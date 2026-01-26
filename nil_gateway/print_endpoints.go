package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multiformats/go-multiaddr"
)

type providerEndpoint struct {
	Type      string `json:"type"`
	Multiaddr string `json:"multiaddr"`
	Notes     string `json:"notes,omitempty"`
}

type providerEndpointsOutput struct {
	Endpoints []providerEndpoint `json:"endpoints"`
}

func maybePrintProviderEndpoints(args []string) bool {
	print := false
	formatJSON := false
	includeP2P := false

	for _, arg := range args {
		switch strings.TrimSpace(arg) {
		case "print-endpoints", "--print-endpoints":
			print = true
		case "--json":
			formatJSON = true
		case "--include-p2p":
			includeP2P = true
		}
		if strings.HasPrefix(arg, "--format=") && strings.TrimPrefix(arg, "--format=") == "json" {
			formatJSON = true
		}
	}
	if !print {
		return false
	}

	out := computeProviderEndpoints(includeP2P)
	if formatJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(out)
		return true
	}

	fmt.Println("# nil_gateway provider endpoints (copy/paste into register-provider)")
	for _, ep := range out.Endpoints {
		if ep.Notes != "" {
			fmt.Printf("# %s (%s)\n", ep.Notes, ep.Type)
		} else {
			fmt.Printf("# %s\n", ep.Type)
		}
		fmt.Printf("--endpoint %q\n", ep.Multiaddr)
	}

	fmt.Println("# Tip: use --include-p2p to also print libp2p endpoints (optional).")
	return true
}

func computeProviderEndpoints(includeP2P bool) providerEndpointsOutput {
	out := providerEndpointsOutput{}

	httpEp, httpType, httpNotes := computeHTTPProviderEndpoint()
	if httpEp != "" {
		out.Endpoints = append(out.Endpoints, providerEndpoint{
			Type:      httpType,
			Multiaddr: httpEp,
			Notes:     httpNotes,
		})
	}

	if includeP2P {
		out.Endpoints = append(out.Endpoints, computeP2PProviderEndpoints()...)
	}
	return out
}

func computeHTTPProviderEndpoint() (multiaddrStr, endpointType, notes string) {
	// Highest precedence: explicit endpoint already formatted as multiaddr.
	if raw := strings.TrimSpace(envDefault("NIL_PUBLIC_HTTP_MULTIADDR", "")); raw != "" {
		if validateMultiaddr(raw) == nil {
			return raw, "direct", "HTTP(S) gateway endpoint"
		}
		return "", "direct", "invalid NIL_PUBLIC_HTTP_MULTIADDR (must be a multiaddr like /dns4/.../tcp/443/https)"
	}

	// Cloudflare Tunnel convention: when set, we assume the public endpoint is https://<hostname>.
	if hostname := strings.TrimSpace(envDefault("NIL_CLOUDFLARE_TUNNEL_HOSTNAME", "")); hostname != "" {
		raw := fmt.Sprintf("/dns4/%s/tcp/443/https", hostname)
		if validateMultiaddr(raw) == nil {
			return raw, "cloudflare-tunnel", "Cloudflare Tunnel public HTTPS endpoint"
		}
		return "", "cloudflare-tunnel", "invalid NIL_CLOUDFLARE_TUNNEL_HOSTNAME"
	}

	// Direct endpoint: derive from public host/port if provided, otherwise fall back to listen port.
	host := strings.TrimSpace(envDefault("NIL_PUBLIC_HTTP_HOST", envDefault("NIL_PUBLIC_HOST", "")))
	if host == "" {
		host = "127.0.0.1"
	}

	port := envInt("NIL_PUBLIC_HTTP_PORT", 0)
	if port == 0 {
		if p, ok := parsePort(envDefault("NIL_LISTEN_ADDR", ":8080")); ok {
			port = p
		} else {
			port = 8080
		}
	}

	scheme := strings.TrimSpace(envDefault("NIL_PUBLIC_HTTP_SCHEME", ""))
	if scheme == "" {
		if port == 443 {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	if scheme != "http" && scheme != "https" {
		scheme = "http"
	}

	proto := scheme
	maHost := formatHostMultiaddr(host)
	raw := fmt.Sprintf("%s/tcp/%d/%s", maHost, port, proto)
	if validateMultiaddr(raw) != nil {
		return "", "direct", "unable to build multiaddr (set NIL_PUBLIC_HTTP_MULTIADDR explicitly)"
	}
	return raw, "direct", "Direct HTTP(S) gateway endpoint"
}

func computeP2PProviderEndpoints() []providerEndpoint {
	// P2P is optional; only print if enabled and we can compute a stable peer id.
	if envDefault("NIL_P2P_ENABLED", "1") != "1" {
		return nil
	}

	priv, err := loadP2PIdentityFromEnv()
	if err != nil {
		return []providerEndpoint{{
			Type:  "libp2p",
			Notes: "p2p identity error (check NIL_P2P_IDENTITY_PATH / NIL_P2P_IDENTITY_B64)",
		}}
	}
	if priv == nil {
		return []providerEndpoint{{
			Type:  "libp2p",
			Notes: "set NIL_P2P_IDENTITY_PATH (stable peer id) to print libp2p endpoints",
		}}
	}
	pid, err := peer.IDFromPrivateKey(priv)
	if err != nil {
		return []providerEndpoint{{
			Type:  "libp2p",
			Notes: "failed to derive peer id from identity",
		}}
	}

	out := []providerEndpoint{}

	// If relays are configured, clients can dial via /p2p-circuit. This is reliable behind NAT,
	// but relay nodes become part of the data path.
	for _, relayBase := range parseCommaList(envDefault("NIL_P2P_RELAY_ADDRS", "")) {
		relayBase = strings.TrimSpace(relayBase)
		if relayBase == "" {
			continue
		}
		raw := fmt.Sprintf("%s/p2p-circuit/p2p/%s", relayBase, pid.String())
		if validateMultiaddr(raw) == nil {
			out = append(out, providerEndpoint{
				Type:      "libp2p",
				Multiaddr: raw,
				Notes:     "LibP2P endpoint via circuit relay (optional)",
			})
		}
	}

	// If no relays are configured, fall back to announce/listen addrs (may not be reachable behind NAT).
	if len(out) == 0 {
		announce := parseCommaList(envDefault("NIL_P2P_ANNOUNCE_ADDRS", ""))
		if len(announce) == 0 {
			announce = parseCommaList(envDefault("NIL_P2P_LISTEN_ADDRS", ""))
		}
		for _, raw := range announce {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			// Ensure /p2p/<peerId> suffix.
			if !strings.Contains(raw, "/p2p/") {
				raw = raw + "/p2p/" + pid.String()
			}
			if validateMultiaddr(raw) == nil {
				out = append(out, providerEndpoint{
					Type:      "libp2p",
					Multiaddr: raw,
					Notes:     "LibP2P listen/announce addr (direct only; may not work behind NAT)",
				})
			}
		}
	}

	return out
}

func parsePort(listenAddr string) (int, bool) {
	listenAddr = strings.TrimSpace(listenAddr)
	if listenAddr == "" {
		return 0, false
	}
	if strings.HasPrefix(listenAddr, ":") {
		p, err := strconv.Atoi(strings.TrimPrefix(listenAddr, ":"))
		return p, err == nil
	}
	_, portStr, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return 0, false
	}
	p, err := strconv.Atoi(portStr)
	return p, err == nil
}

func formatHostMultiaddr(host string) string {
	host = strings.TrimSpace(host)
	ip := net.ParseIP(host)
	if ip != nil && ip.To4() != nil {
		return fmt.Sprintf("/ip4/%s", host)
	}
	// Default to dns4; callers can provide a literal IPv4 if they want /ip4.
	return fmt.Sprintf("/dns4/%s", host)
}

func validateMultiaddr(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("empty")
	}
	_, err := multiaddr.NewMultiaddr(raw)
	return err
}
