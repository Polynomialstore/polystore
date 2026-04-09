package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	ws "github.com/libp2p/go-libp2p/p2p/transport/websocket"
	"github.com/multiformats/go-multiaddr"
)

const defaultListen = "/ip4/0.0.0.0/tcp/9101/ws"

type output struct {
	PeerID      string   `json:"peer_id"`
	Announce    []string `json:"announce_addrs"`
	ListenAddrs []string `json:"listen_addrs"`
	Mode        string   `json:"mode"`
}

func main() {
	var (
		listenRaw    = flag.String("listen", defaultListen, "comma-separated libp2p listen multiaddrs")
		identityPath = flag.String("identity", "", "path to libp2p private key (protobuf bytes, base64 or raw)")
		genIdentity  = flag.String("gen-identity", "", "generate a new identity key at this path (0600)")
		printPeerID  = flag.Bool("print-peer-id", false, "print peer id for the loaded/generated identity and exit")
	)
	flag.Parse()

	priv, err := loadOrCreateIdentity(*identityPath, *genIdentity)
	if err != nil {
		log.Fatalf("identity: %v", err)
	}

	if *printPeerID {
		pid, err := peerIDFromPriv(priv)
		if err != nil {
			log.Fatalf("peer id: %v", err)
		}
		fmt.Println(pid)
		return
	}

	listenAddrs := splitCommaList(*listenRaw)
	if len(listenAddrs) == 0 {
		log.Fatalf("no listen addrs")
	}

	h, err := libp2p.New(
		libp2p.ListenAddrStrings(listenAddrs...),
		libp2p.Transport(ws.New),
		libp2p.Identity(priv),
	)
	if err != nil {
		log.Fatalf("libp2p: %v", err)
	}
	defer func() { _ = h.Close() }()

	_, err = relayv2.New(h)
	if err != nil {
		log.Fatalf("relayv2: %v", err)
	}

	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(&output{
		PeerID:      h.ID().String(),
		Announce:    withPeerID(h),
		ListenAddrs: listenAddrs,
		Mode:        "relay",
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
}

func splitCommaList(raw string) []string {
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

func withPeerID(h host.Host) []string {
	out := make([]string, 0, len(h.Addrs()))
	for _, addr := range h.Addrs() {
		out = append(out, addr.Encapsulate(multiaddr.StringCast("/p2p/"+h.ID().String())).String())
	}
	return out
}

func peerIDFromPriv(priv crypto.PrivKey) (string, error) {
	pid, err := peer.IDFromPrivateKey(priv)
	if err != nil {
		return "", err
	}
	return pid.String(), nil
}

func loadOrCreateIdentity(identityPath, genIdentityPath string) (crypto.PrivKey, error) {
	if genIdentityPath != "" {
		if err := os.MkdirAll(filepath.Dir(genIdentityPath), 0o755); err != nil {
			return nil, err
		}
		priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
		if err != nil {
			return nil, err
		}
		raw, err := crypto.MarshalPrivateKey(priv)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(genIdentityPath, []byte(base64.StdEncoding.EncodeToString(raw)), 0o600); err != nil {
			return nil, err
		}
		return priv, nil
	}

	if identityPath == "" {
		priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
		return priv, err
	}

	data, err := os.ReadFile(identityPath)
	if err != nil {
		return nil, err
	}
	raw := strings.TrimSpace(string(data))
	if raw == "" {
		return nil, errors.New("identity file is empty")
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err == nil {
		data = decoded
	}
	priv, err := crypto.UnmarshalPrivateKey(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshal private key: %w", err)
	}
	return priv, nil
}
