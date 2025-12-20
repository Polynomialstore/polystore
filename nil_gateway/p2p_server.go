package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	ws "github.com/libp2p/go-libp2p/p2p/transport/websocket"
	"github.com/multiformats/go-multiaddr"

	"github.com/gorilla/mux"
)

const (
	p2pFetchProtocolID  = "/nilstore/fetch/1.0.0"
	p2pMaxRequestBytes  = 256 * 1024
	p2pMaxHeaderBytes   = 1 * 1024 * 1024
	p2pDefaultTimeout   = 45 * time.Second
	p2pDefaultListenRaw = "/ip4/0.0.0.0/tcp/9100/ws"
)

type p2pFetchRequest struct {
	ManifestRoot    string `json:"manifest_root"`
	DealID          uint64 `json:"deal_id"`
	Owner           string `json:"owner"`
	FilePath        string `json:"file_path"`
	RangeStart      uint64 `json:"range_start"`
	RangeLen        uint64 `json:"range_len"`
	DownloadSession string `json:"download_session,omitempty"`
	OnchainSession  string `json:"onchain_session,omitempty"`
	ReqSig          string `json:"req_sig,omitempty"`
	ReqNonce        uint64 `json:"req_nonce,omitempty"`
	ReqExpiresAt    uint64 `json:"req_expires_at,omitempty"`
}

type p2pFetchResponse struct {
	Status     int               `json:"status"`
	Error      string            `json:"error,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	BodyLen    uint64            `json:"body_len"`
	RangeStart uint64            `json:"range_start,omitempty"`
	RangeLen   uint64            `json:"range_len,omitempty"`
}

type p2pServer struct {
	host host.Host
}

func (s *p2pServer) Close() error {
	if s == nil || s.host == nil {
		return nil
	}
	return s.host.Close()
}

func startLibp2pServer(ctx context.Context, listenAddrs []string) (*p2pServer, error) {
	if len(listenAddrs) == 0 {
		return nil, errors.New("no libp2p listen addrs provided")
	}
	h, err := libp2p.New(
		libp2p.ListenAddrStrings(listenAddrs...),
		libp2p.Transport(ws.New),
	)
	if err != nil {
		return nil, err
	}
	server := &p2pServer{host: h}
	h.SetStreamHandler(p2pFetchProtocolID, server.handleFetchStream)
	return server, nil
}

func startLibp2pServerFromEnv(ctx context.Context) (*p2pServer, error) {
	if envDefault("NIL_P2P_ENABLED", "0") != "1" {
		return nil, nil
	}
	raw := envDefault("NIL_P2P_LISTEN_ADDRS", p2pDefaultListenRaw)
	addrs := parseCommaList(raw)
	if len(addrs) == 0 {
		return nil, fmt.Errorf("NIL_P2P_LISTEN_ADDRS is empty")
	}
	return startLibp2pServer(ctx, addrs)
}

func parseCommaList(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func p2pAnnounceAddrs(h host.Host) []string {
	if h == nil {
		return nil
	}
	out := make([]string, 0, len(h.Addrs()))
	for _, addr := range h.Addrs() {
		withPeer := addr.Encapsulate(multiaddr.StringCast(fmt.Sprintf("/p2p/%s", h.ID().String())))
		out = append(out, withPeer.String())
	}
	return out
}

func (s *p2pServer) handleFetchStream(stream network.Stream) {
	defer stream.Close()
	_ = stream.SetDeadline(time.Now().Add(p2pDefaultTimeout))

	req, err := readP2PFetchRequest(stream)
	if err != nil {
		_ = writeP2PFetchResponse(stream, &p2pFetchResponse{
			Status: http.StatusBadRequest,
			Error:  err.Error(),
		}, nil)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), p2pDefaultTimeout)
	defer cancel()

	resp, body := serveP2PFetch(ctx, req)
	if err := writeP2PFetchResponse(stream, resp, body); err != nil {
		log.Printf("p2p fetch response write failed: %v", err)
	}
}

func readP2PFetchRequest(r io.Reader) (*p2pFetchRequest, error) {
	decoder := json.NewDecoder(io.LimitReader(r, p2pMaxRequestBytes))
	var req p2pFetchRequest
	if err := decoder.Decode(&req); err != nil {
		return nil, fmt.Errorf("decode request: %w", err)
	}
	req.ManifestRoot = strings.TrimSpace(req.ManifestRoot)
	req.Owner = strings.TrimSpace(req.Owner)
	req.FilePath = strings.TrimSpace(req.FilePath)
	if req.ManifestRoot == "" {
		return nil, errors.New("manifest_root is required")
	}
	if req.DealID == 0 {
		return nil, errors.New("deal_id is required")
	}
	if req.Owner == "" {
		return nil, errors.New("owner is required")
	}
	if req.FilePath == "" {
		return nil, errors.New("file_path is required")
	}
	if req.RangeLen == 0 {
		return nil, errors.New("range_len must be > 0")
	}
	return &req, nil
}

func serveP2PFetch(ctx context.Context, req *p2pFetchRequest) (*p2pFetchResponse, []byte) {
	resp := &p2pFetchResponse{
		Status:  http.StatusOK,
		Headers: make(map[string]string),
	}

	q := url.Values{}
	q.Set("deal_id", fmt.Sprintf("%d", req.DealID))
	q.Set("owner", req.Owner)
	q.Set("file_path", req.FilePath)

	path := fmt.Sprintf("/gateway/fetch/%s?%s", req.ManifestRoot, q.Encode())
	httpReq := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
	httpReq = mux.SetURLVars(httpReq, map[string]string{
		"cid": req.ManifestRoot,
	})
	httpReq.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", req.RangeStart, req.RangeStart+req.RangeLen-1))
	if req.DownloadSession != "" {
		httpReq.Header.Set("X-Nil-Download-Session", req.DownloadSession)
	}
	if req.OnchainSession != "" {
		httpReq.Header.Set("X-Nil-Session-Id", req.OnchainSession)
	}
	if req.ReqSig != "" {
		httpReq.Header.Set("X-Nil-Req-Sig", req.ReqSig)
	}
	if req.ReqNonce != 0 {
		httpReq.Header.Set("X-Nil-Req-Nonce", fmt.Sprintf("%d", req.ReqNonce))
	}
	if req.ReqExpiresAt != 0 {
		httpReq.Header.Set("X-Nil-Req-Expires-At", fmt.Sprintf("%d", req.ReqExpiresAt))
	}
	httpReq.Header.Set("X-Nil-Req-Range-Start", fmt.Sprintf("%d", req.RangeStart))
	httpReq.Header.Set("X-Nil-Req-Range-Len", fmt.Sprintf("%d", req.RangeLen))

	w := httptest.NewRecorder()
	GatewayFetch(w, httpReq)
	result := w.Result()
	body, _ := io.ReadAll(result.Body)
	_ = result.Body.Close()

	resp.Status = result.StatusCode
	resp.BodyLen = uint64(len(body))
	resp.RangeStart = req.RangeStart
	resp.RangeLen = req.RangeLen

	for key, vals := range result.Header {
		if len(vals) == 0 {
			continue
		}
		if strings.HasPrefix(key, "X-Nil-") || key == "Content-Type" {
			resp.Headers[key] = vals[0]
		}
	}

	if resp.Status < http.StatusOK || resp.Status >= http.StatusMultipleChoices {
		resp.Error = strings.TrimSpace(string(body))
		resp.BodyLen = 0
		return resp, nil
	}

	return resp, body
}

func writeP2PFetchResponse(w io.Writer, resp *p2pFetchResponse, body []byte) error {
	if resp == nil {
		return errors.New("nil response")
	}
	if resp.Status < http.StatusOK || resp.Status >= http.StatusMultipleChoices {
		body = nil
	}
	resp.BodyLen = uint64(len(body))
	headerBytes, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	if len(headerBytes) > p2pMaxHeaderBytes {
		return fmt.Errorf("response header too large: %d bytes", len(headerBytes))
	}
	if err := binary.Write(w, binary.BigEndian, uint32(len(headerBytes))); err != nil {
		return err
	}
	if _, err := w.Write(headerBytes); err != nil {
		return err
	}
	if resp.BodyLen == 0 {
		return nil
	}
	_, err = io.Copy(w, bytes.NewReader(body))
	return err
}

func readP2PFetchResponse(r io.Reader) (*p2pFetchResponse, []byte, error) {
	var headerLen uint32
	if err := binary.Read(r, binary.BigEndian, &headerLen); err != nil {
		return nil, nil, err
	}
	if headerLen == 0 || headerLen > p2pMaxHeaderBytes {
		return nil, nil, fmt.Errorf("invalid header length: %d", headerLen)
	}
	headerBuf := make([]byte, headerLen)
	if _, err := io.ReadFull(r, headerBuf); err != nil {
		return nil, nil, err
	}
	var resp p2pFetchResponse
	if err := json.Unmarshal(headerBuf, &resp); err != nil {
		return nil, nil, err
	}
	if resp.BodyLen == 0 {
		return &resp, nil, nil
	}
	if resp.BodyLen > uint64(^uint(0)) {
		return nil, nil, fmt.Errorf("body too large: %d", resp.BodyLen)
	}
	body := make([]byte, int(resp.BodyLen))
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, nil, err
	}
	return &resp, body, nil
}
