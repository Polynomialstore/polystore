package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	"nilchain/x/crypto_ffi"
	niltypes "nilchain/x/nilchain/types"
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

	roots := make([][]byte, 3)
	roots[0] = make([]byte, 32)
	roots[1] = make([]byte, 32)
	roots[2] = make([]byte, 32)
	copy(roots[2], mduRootFr)
	commitment, manifestBlob, err := crypto_ffi.ComputeManifestCommitment(roots)
	if err != nil {
		t.Fatalf("ComputeManifestCommitment failed: %v", err)
	}
	manifestRoot, err := parseManifestRoot("0x" + fmt.Sprintf("%x", commitment))
	if err != nil {
		t.Fatalf("parseManifestRoot(manifest commitment) failed: %v", err)
	}

	dealDir := filepath.Join(uploadDir, manifestRoot.Key)
	if err := os.MkdirAll(dealDir, 0o755); err != nil {
		t.Fatalf("mkdir deal dir: %v", err)
	}

	b := crypto_ffi.NewMdu0Builder(1)
	defer b.Free()
	b.AppendFile(filePath, uint64(len(fileContent)), 0)
	mdu0Data, _ := b.Bytes()
	writeFile(t, filepath.Join(dealDir, "mdu_0.bin"), mdu0Data)
	writeFile(t, filepath.Join(dealDir, "manifest.bin"), manifestBlob)
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
	useTempUploadDir(t)
	t.Setenv("NIL_PROVIDER_ADDRESS", "nil1testprovider")

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
	dealStates := map[uint64]struct{ Owner string; CID string }{
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
	if resp.Headers["X-Nil-Proof-Hash"] == "" {
		t.Fatalf("expected proof hash header")
	}
}
