package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cosmos/gogoproto/jsonpb"
	"github.com/gorilla/mux"
	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/peer"
	ws "github.com/libp2p/go-libp2p/p2p/transport/websocket"
	"github.com/multiformats/go-multiaddr"
	bolt "go.etcd.io/bbolt"
	"polystorechain/x/polystorechain/types"
)

func exerciseFrozenSessionDelivery(t *testing.T, original types.QueryGetRetrievalSessionResponse, expected []byte) {
	t.Helper()
	r := original
	root := "0x" + fmt.Sprintf("%x", r.Session.ManifestRoot)
	session := "0x" + fmt.Sprintf("%x", r.Session.SessionId)
	height := "12"
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !strings.Contains(req.URL.Path, "retrieval-sessions/") {
			t.Errorf("unexpected mutable deal authority: %s", req.URL.Path)
			w.WriteHeader(500)
			return
		}
		w.Header().Set(committedHeightHeader, height)
		if err := (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &r); err != nil {
			t.Error(err)
		}
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	oldMock := mockCombinedOutput
	defer func() { mockCombinedOutput = oldMock }()
	signer := r.Session.AuthorizedProofProvider
	mockCombinedOutput = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if len(args) < 3 || args[0] != "keys" || args[1] != "show" {
			return nil, fmt.Errorf("unexpected command")
		}
		return []byte(signer), nil
	}
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", signer)
	oldDB := sessionDB
	sessionDB = nil
	if err := initSessionDB(filepath.Join(t.TempDir(), "proofs.db")); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = closeSessionDB(); sessionDB = oldDB }()
	q := url.Values{"deal_id": {"9007199254740993"}, "owner": {r.Session.Owner}}
	invoke := func(accept string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/sp/retrieval/mdu/"+root+"/2?"+q.Encode(), nil)
		req = mux.SetURLVars(req, map[string]string{"cid": root, "index": "2"})
		req.Header.Set("X-PolyStore-Session-Id", session)
		req.Header.Set("Accept", accept)
		w := httptest.NewRecorder()
		GatewayMdu(w, req)
		return w
	}
	assertBody := func(contentType string, body []byte) {
		t.Helper()
		kind, params, err := mime.ParseMediaType(contentType)
		if err != nil || kind != "multipart/form-data" || params["version"] != "2" {
			t.Fatalf("wrong C5 content type: %s", contentType)
		}
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		meta, err := reader.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		if meta.FormName() != "metadata" || meta.FileName() != "" || meta.Header.Get("Content-Type") != "application/json" {
			t.Fatal("metadata part mismatch")
		}
		var decoded retrievalWindowMetadata
		if err := json.NewDecoder(meta).Decode(&decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.BlobCount != "2" || decoded.StartBlob != 8 || len(decoded.Proofs) != 2 {
			t.Fatalf("metadata mismatch: %+v", decoded)
		}
		part, err := reader.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		payload, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		if part.FormName() != "bytes" || part.FileName() == "" || !bytes.Equal(payload, expected) {
			t.Fatal("delivered bytes differ from proven window")
		}
		if _, err := reader.NextPart(); err != io.EOF {
			t.Fatal("unexpected trailing part")
		}
	}
	result := invoke("multipart/form-data; version=2")
	if result.Code != http.StatusOK {
		t.Fatalf("frozen deputy delivery: %d %s", result.Code, result.Body.String())
	}
	assertBody(result.Header().Get("Content-Type"), result.Body.Bytes())
	if err := sessionDB.View(func(tx *bolt.Tx) error {
		value := tx.Bucket(onChainSessionProofsBucket).Get(frozenProofKey([32]byte(r.Session.SessionId)))
		var stored storedFrozenProof
		if err := json.Unmarshal(value, &stored); err != nil {
			return err
		}
		if stored.Version != 2 || len(stored.Proofs) != 2 || !bytes.Equal(stored.Context, r.ChallengeContext) {
			return fmt.Errorf("incomplete persisted statement")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := invoke("application/octet-stream"); got.Code != http.StatusNotAcceptable {
		t.Fatalf("v2 downgraded to legacy: %d", got.Code)
	}
	for _, status := range []types.RetrievalSessionStatus{types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_EXPIRED, types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED} {
		r.Session.Status = status
		if got := invoke("multipart/form-data; version=2"); got.Code != http.StatusConflict {
			t.Fatalf("terminal state served: %d", got.Code)
		}
	}
	r = original
	height = "51"
	if got := invoke("multipart/form-data; version=2"); got.Code != http.StatusConflict {
		t.Fatalf("expired window served: %d", got.Code)
	}
	height = "12"
	signer = r.Session.Provider // Environment assertion cannot turn the assigned SP into the frozen deputy.
	if got := invoke("multipart/form-data; version=2"); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("key override mismatch accepted: %d", got.Code)
	}
	signer = r.Session.AuthorizedProofProvider

	// Exercise the actual libp2p framing/half-close lifecycle with the same handler.
	server, err := startLibp2pServer(context.Background(), []string{"/ip4/127.0.0.1/tcp/0/ws"})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := libp2p.New(libp2p.Transport(ws.New))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Connect(context.Background(), peer.AddrInfo{ID: server.host.ID(), Addrs: []multiaddr.Multiaddr{pickTestAddr(t, server.host.Addrs())}}); err != nil {
		t.Fatal(err)
	}
	stream, err := client.NewStream(context.Background(), server.host.ID(), p2pFetchProtocolID)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	leaf := uint32(8)
	request := p2pRetrievalWindowRequest{Kind: "retrieval_window_v2", ManifestRoot: root, DealID: "9007199254740993", MDU: "2", StartBlob: &leaf, BlobCount: "2", Owner: r.Session.Owner, SessionID: session}
	if err := json.NewEncoder(stream).Encode(request); err != nil {
		t.Fatal(err)
	}
	if err := stream.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, body, err := readP2PFetchResponse(stream)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != 200 {
		t.Fatalf("P2P v2 failed: %d %s", response.Status, response.Error)
	}
	assertBody(response.Headers["content-type"], body)
	// All negative cases are rejected before a file read or proof operation.
	wire, _ := json.Marshal(request)
	for _, bad := range []string{
		string(wire) + "{}",
		strings.Replace(string(wire), `"start_blob_index":8`, `"start_blob_index":4294967296`, 1),
		strings.Replace(string(wire), `"deal_id":"9007199254740993"`, `"deal_id":9007199254740993`, 1),
		strings.Replace(string(wire), `"blob_count":"2"`, `"blob_count":"65"`, 1),
	} {
		if _, err := readP2PFetchRequest(strings.NewReader(bad)); err == nil {
			t.Fatal("accepted malformed P2P request")
		}
	}
}

func TestRetrievalWriterReportsPartialFailure(t *testing.T) {
	w := &p2pWindowRecorder{header: make(http.Header), limit: 100}
	if err := writeRetrievalWindow(w, []byte(`{}`), make([]byte, 131072)); err == nil {
		t.Fatal("response write failure was ignored")
	}
}
