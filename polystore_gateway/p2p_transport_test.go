package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/peer"
	ws "github.com/libp2p/go-libp2p/p2p/transport/websocket"
	"github.com/multiformats/go-multiaddr"

	"golang.org/x/crypto/blake2s"
	"polystorechain/x/crypto_ffi"
	niltypes "polystorechain/x/polystorechain/types"
)

func buildTestSlab(t *testing.T, filePath string, fileContent []byte) ManifestRoot {
	t.Helper()

	commitmentBytes := 48
	witnessPlain := make([]byte, niltypes.BLOBS_PER_MDU*commitmentBytes)
	leafHashes := make([][32]byte, 0, niltypes.BLOBS_PER_MDU)
	for i := 0; i < len(witnessPlain); i += commitmentBytes {
		for j := 0; j < commitmentBytes; j++ {
			witnessPlain[i+j] = byte(i / commitmentBytes)
		}
		leafHashes = append(leafHashes, blake2s.Sum256(witnessPlain[i:i+commitmentBytes]))
	}
	mduRootFr, _ := merkleRootAndPath(leafHashes, 0)

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	b.AppendFile(filePath, uint64(len(fileContent)), 0)
	if err := b.SetRoot(b.GetWitnessCount(), mduRootFr); err != nil {
		t.Fatalf("SetRoot(user) failed: %v", err)
	}
	mdu0Data, _ := b.Bytes()
	if err := materializeMdu0RootTable(mdu0Data, map[uint64][]byte{uint64(1) + b.GetWitnessCount(): mduRootFr}); err != nil {
		t.Fatalf("materialize MDU #0 root table failed: %v", err)
	}
	rootBytes, err := crypto_ffi.ComputeMduMerkleRoot(mdu0Data)
	if err != nil {
		t.Fatalf("ComputeMduMerkleRoot failed: %v", err)
	}
	manifestRoot, err := parseManifestRoot("0x" + hex.EncodeToString(rootBytes))
	if err != nil {
		t.Fatalf("parseManifestRoot(polyfs root) failed: %v", err)
	}

	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}
	writeFile(t, filepath.Join(dealDir, "mdu_0.bin"), mdu0Data)
	writeFile(t, filepath.Join(dealDir, "mdu_1.bin"), encodeRawToMdu(witnessPlain))
	writeFile(t, filepath.Join(dealDir, "mdu_2.bin"), encodeRawToMdu(fileContent))

	return manifestRoot
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func pickTestAddr(t *testing.T, addrs []multiaddr.Multiaddr) multiaddr.Multiaddr {
	t.Helper()
	for _, addr := range addrs {
		if strings.Contains(addr.String(), "/ws") && !strings.Contains(addr.String(), "/ip4/0.0.0.0") {
			return addr
		}
	}
	for _, addr := range addrs {
		if strings.Contains(addr.String(), "/ws") {
			return addr
		}
	}
	t.Fatalf("no websocket listen address found")
	return nil
}

func TestP2PFetch_EndToEnd(t *testing.T) {
	requireOnchainSessionForTest(t, false)
	useTempUploadDir(t)
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "nil1testprovider")

	oldReqSig := requireRetrievalReqSig
	requireRetrievalReqSig = false
	t.Cleanup(func() { requireRetrievalReqSig = oldReqSig })

	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatalf("crypto_ffi.Init failed: %v", err)
	}

	owner := testDealOwner(t)
	filePath := "video.mp4"
	fileContent := []byte("Hello libp2p transport")
	manifestRoot := buildTestSlab(t, filePath, fileContent)

	dealID := uint64(1)
	dealStates := map[uint64]struct {
		Owner string
		CID   string
	}{
		dealID: {Owner: owner, CID: manifestRoot.Canonical},
	}
	srv := dynamicMockDealServer(dealStates)
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	ctx := context.Background()
	server, err := startLibp2pServer(ctx, []string{"/ip4/127.0.0.1/tcp/0/ws"})
	if err != nil {
		t.Fatalf("startLibp2pServer failed: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })

	client, err := libp2p.New(libp2p.Transport(ws.New))
	if err != nil {
		t.Fatalf("libp2p client init failed: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	addr := pickTestAddr(t, server.host.Addrs())
	addrInfo := peer.AddrInfo{
		ID:    server.host.ID(),
		Addrs: []multiaddr.Multiaddr{addr},
	}
	if err := client.Connect(ctx, addrInfo); err != nil {
		t.Fatalf("libp2p connect failed: %v", err)
	}

	stream, err := client.NewStream(ctx, server.host.ID(), p2pFetchProtocolID)
	if err != nil {
		t.Fatalf("open stream failed: %v", err)
	}
	defer stream.Close()

	req := p2pFetchRequest{
		ManifestRoot: manifestRoot.Canonical,
		DealID:       &dealID,
		Owner:        owner,
		FilePath:     filePath,
		RangeStart:   0,
		RangeLen:     uint64(len(fileContent)),
	}
	if err := json.NewEncoder(stream).Encode(&req); err != nil {
		t.Fatalf("encode request failed: %v", err)
	}
	if err := stream.CloseWrite(); err != nil {
		t.Fatalf("close write failed: %v", err)
	}

	resp, body, err := readP2PFetchResponse(stream)
	if err != nil {
		t.Fatalf("read response failed: %v", err)
	}
	if resp.Status != http.StatusOK && resp.Status != http.StatusPartialContent {
		t.Fatalf("unexpected status %d: %s", resp.Status, resp.Error)
	}
	if !bytes.Equal(body, fileContent) {
		t.Fatalf("response body mismatch: got %q", string(body))
	}
	if resp.Headers["x-polystore-proof-hash"] == "" {
		t.Fatalf("expected proof hash header")
	}
}
