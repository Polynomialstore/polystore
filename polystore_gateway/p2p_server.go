package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	circuitv2client "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/client"
	ws "github.com/libp2p/go-libp2p/p2p/transport/websocket"
	"github.com/multiformats/go-multiaddr"

	"github.com/gorilla/mux"
)

const (
	p2pFetchProtocolID  = "/polystore/fetch/1.0.0"
	p2pMaxRequestBytes  = 256 * 1024
	p2pMaxHeaderBytes   = 1 * 1024 * 1024
	p2pDefaultTimeout   = 45 * time.Second
	p2pDefaultListenRaw = "/ip4/0.0.0.0/tcp/9100/ws"
)

type p2pFetchRequest struct {
	ManifestRoot    string  `json:"manifest_root"`
	DealID          *uint64 `json:"deal_id"`
	Owner           string  `json:"owner"`
	FilePath        string  `json:"file_path"`
	RangeStart      uint64  `json:"range_start"`
	RangeLen        uint64  `json:"range_len"`
	DownloadSession string  `json:"download_session,omitempty"`
	OnchainSession  string  `json:"onchain_session,omitempty"`
	ReqSig          string  `json:"req_sig,omitempty"`
	ReqNonce        uint64  `json:"req_nonce,omitempty"`
	ReqExpiresAt    uint64  `json:"req_expires_at,omitempty"`
	ReqRangeStart   *uint64 `json:"req_range_start,omitempty"`
	ReqRangeLen     *uint64 `json:"req_range_len,omitempty"`
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
	host          host.Host
	announceAddrs []string
}

var (
	p2pAnnounceMu     sync.RWMutex
	p2pAnnounceCached []string
)

func setP2PAnnounceAddrs(addrs []string) {
	if len(addrs) == 0 {
		return
	}
	copied := make([]string, len(addrs))
	copy(copied, addrs)
	p2pAnnounceMu.Lock()
	p2pAnnounceCached = copied
	p2pAnnounceMu.Unlock()
}

func getP2PAnnounceAddrs() []string {
	p2pAnnounceMu.RLock()
	defer p2pAnnounceMu.RUnlock()
	if len(p2pAnnounceCached) == 0 {
		return nil
	}
	copied := make([]string, len(p2pAnnounceCached))
	copy(copied, p2pAnnounceCached)
	return copied
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
	opts := []libp2p.Option{
		libp2p.ListenAddrStrings(listenAddrs...),
		libp2p.Transport(ws.New),
		// Allow dialing/accepting circuit-relay addresses when configured.
		libp2p.EnableRelay(),
	}
	if priv, err := loadP2PIdentityFromEnv(); err != nil {
		return nil, err
	} else if priv != nil {
		opts = append(opts, libp2p.Identity(priv))
	}
	h, err := libp2p.New(opts...)
	if err != nil {
		return nil, err
	}
	server := &p2pServer{host: h}
	h.SetStreamHandler(p2pFetchProtocolID, server.handleFetchStream)
	return server, nil
}

func startLibp2pServerFromEnv(ctx context.Context) (*p2pServer, error) {
	// Default: enabled (dev/test posture). Disable explicitly via NIL_P2P_ENABLED=0.
	if envDefault("NIL_P2P_ENABLED", "1") != "1" {
		return nil, nil
	}
	raw := envDefault("NIL_P2P_LISTEN_ADDRS", p2pDefaultListenRaw)
	addrs := parseCommaList(raw)
	if len(addrs) == 0 {
		return nil, fmt.Errorf("NIL_P2P_LISTEN_ADDRS is empty")
	}
	server, err := startLibp2pServer(ctx, addrs)
	if err != nil {
		return nil, err
	}

	announce := parseCommaList(envDefault("NIL_P2P_ANNOUNCE_ADDRS", ""))
	if len(announce) == 0 {
		relayDial, err := reserveRelayAddrs(ctx, server.host, parseCommaList(envDefault("NIL_P2P_RELAY_ADDRS", "")))
		if err != nil {
			log.Printf("p2p relay reservation failed: %v", err)
		}
		if len(relayDial) > 0 {
			announce = relayDial
		}
	}
	if len(announce) == 0 {
		announce = p2pAnnounceAddrs(server.host)
	}
	server.announceAddrs = announce
	return server, nil
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

func loadP2PIdentityFromEnv() (crypto.PrivKey, error) {
	if raw := strings.TrimSpace(envDefault("NIL_P2P_IDENTITY_B64", "")); raw != "" {
		decoded, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return nil, fmt.Errorf("decode NIL_P2P_IDENTITY_B64: %w", err)
		}
		priv, err := crypto.UnmarshalPrivateKey(decoded)
		if err != nil {
			return nil, fmt.Errorf("unmarshal NIL_P2P_IDENTITY_B64: %w", err)
		}
		return priv, nil
	}
	if path := strings.TrimSpace(envDefault("NIL_P2P_IDENTITY_PATH", "")); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read NIL_P2P_IDENTITY_PATH: %w", err)
		}
		raw := strings.TrimSpace(string(data))
		if raw == "" {
			return nil, fmt.Errorf("NIL_P2P_IDENTITY_PATH is empty")
		}
		decoded, err := base64.StdEncoding.DecodeString(raw)
		if err == nil {
			data = decoded
		}
		priv, err := crypto.UnmarshalPrivateKey(data)
		if err != nil {
			return nil, fmt.Errorf("unmarshal NIL_P2P_IDENTITY_PATH: %w", err)
		}
		return priv, nil
	}
	return nil, nil
}

func reserveRelayAddrs(ctx context.Context, h host.Host, relayAddrs []string) ([]string, error) {
	if h == nil || len(relayAddrs) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(relayAddrs))
	var firstErr error
	for _, raw := range relayAddrs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		ma, err := multiaddr.NewMultiaddr(raw)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("invalid relay addr %q: %w", raw, err)
			}
			continue
		}
		info, err := peer.AddrInfoFromP2pAddr(ma)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("invalid relay peer addr %q: %w", raw, err)
			}
			continue
		}
		if err := h.Connect(ctx, *info); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("connect relay %q: %w", raw, err)
			}
			continue
		}
		_, err = circuitv2client.Reserve(ctx, h, *info)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("reserve relay %q: %w", raw, err)
			}
			continue
		}
		// Dial address for clients: <relay>/p2p-circuit/p2p/<providerPeerId>.
		dial := ma.Encapsulate(multiaddr.StringCast(fmt.Sprintf("/p2p-circuit/p2p/%s", h.ID().String())))
		out = append(out, dial.String())
	}
	return out, firstErr
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
	if req.DealID == nil {
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

	dealID := uint64(0)
	if req.DealID != nil {
		dealID = *req.DealID
	}
	q := url.Values{}
	q.Set("deal_id", fmt.Sprintf("%d", dealID))
	q.Set("owner", req.Owner)
	q.Set("file_path", req.FilePath)

	path := fmt.Sprintf("/gateway/fetch/%s?%s", req.ManifestRoot, q.Encode())
	httpReq := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
	httpReq = mux.SetURLVars(httpReq, map[string]string{
		"cid": req.ManifestRoot,
	})
	httpReq.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", req.RangeStart, req.RangeStart+req.RangeLen-1))
	if req.DownloadSession != "" {
		httpReq.Header.Set("X-PolyStore-Download-Session", req.DownloadSession)
	}
	if req.OnchainSession != "" {
		httpReq.Header.Set("X-PolyStore-Session-Id", req.OnchainSession)
	}
	if req.ReqSig != "" {
		httpReq.Header.Set("X-PolyStore-Req-Sig", req.ReqSig)
	}
	if req.ReqNonce != 0 {
		httpReq.Header.Set("X-PolyStore-Req-Nonce", fmt.Sprintf("%d", req.ReqNonce))
	}
	if req.ReqExpiresAt != 0 {
		httpReq.Header.Set("X-PolyStore-Req-Expires-At", fmt.Sprintf("%d", req.ReqExpiresAt))
	}
	if req.ReqRangeStart != nil {
		httpReq.Header.Set("X-PolyStore-Req-Range-Start", fmt.Sprintf("%d", *req.ReqRangeStart))
	} else {
		httpReq.Header.Set("X-PolyStore-Req-Range-Start", fmt.Sprintf("%d", req.RangeStart))
	}
	if req.ReqRangeLen != nil {
		httpReq.Header.Set("X-PolyStore-Req-Range-Len", fmt.Sprintf("%d", *req.ReqRangeLen))
	} else {
		httpReq.Header.Set("X-PolyStore-Req-Range-Len", fmt.Sprintf("%d", req.RangeLen))
	}

	w := httptest.NewRecorder()
	if isGatewayRouterMode() {
		RouterGatewayFetch(w, httpReq)
	} else {
		GatewayFetch(w, httpReq)
	}
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
		lowerKey := strings.ToLower(key)
		if strings.HasPrefix(lowerKey, "x-polystore-") || lowerKey == "content-type" {
			resp.Headers[lowerKey] = vals[0]
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
