package main

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

type gatewayStatusResponse struct {
	Version       string            `json:"version"`
	GitSHA        string            `json:"git_sha"`
	BuildTime     string            `json:"build_time"`
	Mode          string            `json:"mode"`
	ListeningAddr string            `json:"listening_addr"`
	ProviderBase  string            `json:"provider_base,omitempty"`
	P2PAddrs      []string          `json:"p2p_addrs,omitempty"`
	Capabilities  map[string]bool   `json:"capabilities"`
	Dependencies  map[string]bool   `json:"deps"`
	Extra         map[string]string `json:"extra,omitempty"`
}

func parseP2PAddrList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, part)
	}
	return out
}

func GatewayStatus(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	version := "dev"
	gitSHA := ""
	buildTime := ""
	if info, ok := debug.ReadBuildInfo(); ok && info != nil {
		if info.Main.Version != "" {
			version = info.Main.Version
		}
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				gitSHA = setting.Value
			case "vcs.time":
				buildTime = setting.Value
			}
		}
	}

	mode := "standalone"
	if isGatewayRouterMode() {
		mode = "router"
	}

	listenAddr := envDefault("NIL_LISTEN_ADDR", ":8080")
	status := gatewayStatusResponse{
		Version:       version,
		GitSHA:        gitSHA,
		BuildTime:     buildTime,
		Mode:          mode,
		ListeningAddr: listenAddr,
		ProviderBase:  strings.TrimSpace(providerBase),
		Capabilities: map[string]bool{
			"upload":         true,
			"fetch":          true,
			"list_files":     true,
			"slab":           true,
			"retrieval_plan": true,
		},
		Dependencies: map[string]bool{
			"lcd_reachable": pingURL(r.Context(), lcdBase+"/cosmos/base/tendermint/v1beta1/node_info"),
			"sp_reachable":  pingURL(r.Context(), strings.TrimRight(providerBase, "/")+"/health"),
		},
	}
	p2pAddrs := parseP2PAddrList(envDefault("NIL_P2P_ADDRS", ""))
	if len(p2pAddrs) == 0 {
		if providerAddr := strings.TrimSpace(cachedProviderAddress(r.Context())); providerAddr != "" {
			if addrs, err := resolveProviderP2PAddrs(r.Context(), providerAddr); err == nil {
				p2pAddrs = addrs
			}
		}
	}
	if len(p2pAddrs) > 0 {
		status.P2PAddrs = p2pAddrs
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

func pingURL(ctx context.Context, url string) bool {
	if strings.TrimSpace(url) == "" {
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	client := http.Client{Timeout: 2 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	_ = res.Body.Close()
	return res.StatusCode >= 200 && res.StatusCode < 400
}
