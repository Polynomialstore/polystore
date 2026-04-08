package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"
)

var statusProcessStartedAt = time.Now()

type gatewayStatusResponse struct {
	Version       string                      `json:"version"`
	GitSHA        string                      `json:"git_sha"`
	BuildTime     string                      `json:"build_time"`
	Persona       string                      `json:"persona"`
	Mode          string                      `json:"mode"`
	RouteFamilies []string                    `json:"allowed_route_families"`
	ListeningAddr string                      `json:"listening_addr"`
	ProviderBase  string                      `json:"provider_base,omitempty"`
	P2PAddrs      []string                    `json:"p2p_addrs,omitempty"`
	Capabilities  map[string]bool             `json:"capabilities"`
	Dependencies  map[string]bool             `json:"deps"`
	Provider      *providerDaemonStatusDetail `json:"provider,omitempty"`
	Issues        []string                    `json:"issues,omitempty"`
	Extra         map[string]string           `json:"extra,omitempty"`
}

type providerDaemonStatusDetail struct {
	KeyName            string   `json:"key_name,omitempty"`
	Address            string   `json:"address,omitempty"`
	ConfiguredOperator string   `json:"configured_operator,omitempty"`
	PairingStatus      string   `json:"pairing_status,omitempty"`
	PairedOperator     string   `json:"paired_operator,omitempty"`
	PendingOperator    string   `json:"pending_operator,omitempty"`
	RegistrationStatus string   `json:"registration_status,omitempty"`
	OnchainStatus      string   `json:"onchain_status,omitempty"`
	Draining           bool     `json:"draining"`
	Endpoints          []string `json:"endpoints,omitempty"`
	LocalBase          string   `json:"local_base,omitempty"`
	PublicBase         string   `json:"public_base,omitempty"`
	LocalHealthURL     string   `json:"local_health_url,omitempty"`
	PublicHealthURL    string   `json:"public_health_url,omitempty"`
	LocalHealthOK      bool     `json:"local_health_ok"`
	PublicHealthOK     bool     `json:"public_health_ok"`
	SpAuthPresent      bool     `json:"sp_auth_present"`
	UploadDir          string   `json:"upload_dir,omitempty"`
	NilHome            string   `json:"nil_home,omitempty"`
	ChainID            string   `json:"chain_id,omitempty"`
	LCDBase            string   `json:"lcd_base,omitempty"`
	NodeAddr           string   `json:"node_addr,omitempty"`
	UptimeSeconds      uint64   `json:"uptime_seconds"`
}

type lcdProviderStatusResponse struct {
	Provider struct {
		Address      string   `json:"address"`
		Status       string   `json:"status"`
		Capabilities string   `json:"capabilities"`
		Endpoints    []string `json:"endpoints"`
		Draining     bool     `json:"draining"`
	} `json:"provider"`
}

type lcdProviderPairingResponse struct {
	Pairing struct {
		Provider     string `json:"provider"`
		Operator     string `json:"operator"`
		PairedHeight int64  `json:"paired_height"`
	} `json:"pairing"`
}

type lcdPendingProviderLinkResponse struct {
	Link struct {
		Provider        string `json:"provider"`
		Operator        string `json:"operator"`
		RequestedHeight int64  `json:"requested_height"`
	} `json:"link"`
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
	persona := currentRuntimePersona()
	listenAddr := envDefault("NIL_LISTEN_ADDR", ":8080")
	lcdNodeInfoURL := statusLCDNodeInfoURL()
	spHealthURL := strings.TrimRight(strings.TrimSpace(providerBase), "/") + "/health"
	if persona == runtimePersonaProviderDaemon {
		if localBase := localBaseURLFromListenAddr(listenAddr); localBase != "" {
			spHealthURL = strings.TrimRight(localBase, "/") + "/health"
		}
	}
	lcdReachable := pingURL(r.Context(), lcdNodeInfoURL)
	spReachable := pingURL(r.Context(), spHealthURL)

	status := gatewayStatusResponse{
		Version:       version,
		GitSHA:        gitSHA,
		BuildTime:     buildTime,
		Persona:       persona.String(),
		Mode:          mode,
		RouteFamilies: allowedRouteFamiliesForPersona(persona),
		ListeningAddr: listenAddr,
		ProviderBase:  strings.TrimSpace(providerBase),
		Capabilities: map[string]bool{
			"upload":         true,
			"fetch":          true,
			"list_files":     true,
			"slab":           true,
			"retrieval_plan": true,
			// Mode 2: gateway-side RS encoding + witness generation for new deals.
			"mode2_rs":        !isGatewayRouterMode(),
			"mode2_rs_append": false,
		},
		Dependencies: map[string]bool{
			"lcd_reachable": lcdReachable,
			"sp_reachable":  spReachable,
		},
		Extra: map[string]string{
			"artifact_spec": "mode2-artifacts-v1",
			"rs_default":    "8+4",
		},
	}
	for k, v := range systemLivenessSnapshotForStatus() {
		status.Extra[k] = v
	}
	for k, v := range mode2ReconstructSnapshotForStatus() {
		status.Extra[k] = v
	}
	for k, v := range dealGenerationStatusSnapshotForStatus() {
		status.Extra[k] = v
	}
	for k, v := range polyfsCASStatusSnapshotForStatus() {
		status.Extra[k] = v
	}

	if persona == runtimePersonaProviderDaemon {
		providerStatus, issues := buildProviderDaemonStatus(r.Context(), listenAddr, lcdReachable)
		status.Provider = providerStatus
		status.Issues = issues
		if providerStatus != nil && strings.TrimSpace(status.ProviderBase) == "" {
			status.ProviderBase = providerStatus.LocalBase
		}
	}

	p2pAddrs := getP2PAnnounceAddrs()
	if len(p2pAddrs) == 0 {
		p2pAddrs = parseP2PAddrList(envDefault("NIL_P2P_ADDRS", ""))
	}
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

func buildProviderDaemonStatus(ctx context.Context, listenAddr string, lcdReachable bool) (*providerDaemonStatusDetail, []string) {
	detail := &providerDaemonStatusDetail{
		KeyName:       strings.TrimSpace(os.Getenv("NIL_PROVIDER_KEY")),
		ConfiguredOperator: strings.TrimSpace(os.Getenv("NIL_OPERATOR_ADDRESS")),
		SpAuthPresent: strings.TrimSpace(os.Getenv("NIL_GATEWAY_SP_AUTH")) != "",
		UploadDir:     uploadDir,
		NilHome:       homeDir,
		ChainID:       strings.TrimSpace(chainID),
		LCDBase:       strings.TrimSpace(lcdBase),
		NodeAddr:      strings.TrimSpace(nodeAddr),
		UptimeSeconds: statusUptimeSeconds(),
	}
	issues := make([]string, 0, 8)

	detail.LocalBase = localBaseURLFromListenAddr(listenAddr)
	if detail.LocalBase != "" {
		detail.LocalHealthURL = strings.TrimRight(detail.LocalBase, "/") + "/health"
		detail.LocalHealthOK = pingURL(ctx, detail.LocalHealthURL)
	}

	if !detail.SpAuthPresent {
		issues = append(issues, "NIL_GATEWAY_SP_AUTH is missing")
	}
	if strings.TrimSpace(detail.LCDBase) == "" {
		issues = append(issues, "LCD base is not configured")
	} else if !lcdReachable {
		issues = append(issues, "LCD is unreachable")
	}

	detail.Address = strings.TrimSpace(cachedProviderAddress(ctx))
	if detail.Address == "" {
		issues = append(issues, "provider address could not be resolved from NIL_PROVIDER_KEY/NIL_PROVIDER_ADDRESS")
		detail.PairingStatus = "unknown"
		detail.RegistrationStatus = "unknown"
		if !detail.LocalHealthOK {
			issues = append(issues, "local provider health endpoint is unreachable")
		}
		return detail, dedupeIssues(issues)
	}

	detail.Endpoints = parseP2PAddrList(strings.TrimSpace(os.Getenv("NIL_PROVIDER_ENDPOINTS")))

	record, registrationStatus, regErr := fetchProviderStatusFromLCD(ctx, detail.Address)
	detail.RegistrationStatus = registrationStatus
	if regErr == nil && record != nil {
		detail.OnchainStatus = strings.TrimSpace(record.Provider.Status)
		detail.Draining = record.Provider.Draining
		if len(record.Provider.Endpoints) > 0 {
			detail.Endpoints = append([]string(nil), record.Provider.Endpoints...)
		}
	}

	pairing, pairingStatus, pairingErr := fetchProviderPairingFromLCD(ctx, detail.Address)
	detail.PairingStatus = pairingStatus
	if pairingErr == nil && pairing != nil {
		detail.PairedOperator = strings.TrimSpace(pairing.Pairing.Operator)
	}

	if detail.PairingStatus != "paired" {
		pending, pendingStatus, pendingErr := fetchPendingProviderLinkFromLCD(ctx, detail.Address)
		if pendingErr == nil && pending != nil {
			detail.PairingStatus = pendingStatus
			detail.PendingOperator = strings.TrimSpace(pending.Link.Operator)
		}
	}
	if detail.PairingStatus == "" {
		detail.PairingStatus = "unknown"
	}
	if detail.RegistrationStatus == "" {
		detail.RegistrationStatus = "unknown"
	}

	if publicBase := firstHTTPBaseFromEndpoints(detail.Endpoints); publicBase != "" {
		detail.PublicBase = publicBase
		detail.PublicHealthURL = strings.TrimRight(publicBase, "/") + "/health"
		detail.PublicHealthOK = pingURL(ctx, detail.PublicHealthURL)
	}

	if !detail.LocalHealthOK {
		issues = append(issues, "local provider health endpoint is unreachable")
	}
	switch detail.PairingStatus {
	case "paired":
	case "pending":
		issues = append(issues, "provider link request is still pending operator approval on-chain")
	case "not_found":
		if strings.TrimSpace(detail.ConfiguredOperator) != "" {
			issues = append(issues, "configured provider link request is not open on-chain")
		} else {
			issues = append(issues, "provider is not paired to an operator wallet")
		}
	case "unknown":
		if pairingErr != nil && lcdReachable {
			issues = append(issues, "provider pairing could not be queried from the LCD")
		}
	}
	switch detail.RegistrationStatus {
	case "registered":
	case "unregistered":
		issues = append(issues, "provider is not registered on-chain")
	case "unknown":
		if regErr != nil && lcdReachable {
			issues = append(issues, "provider registration could not be queried from the LCD")
		}
	}
	if len(detail.Endpoints) == 0 {
		issues = append(issues, "provider endpoints are not configured")
	}
	if detail.PublicHealthURL != "" && !detail.PublicHealthOK {
		issues = append(issues, "public provider health endpoint is unreachable")
	}

	return detail, dedupeIssues(issues)
}

func statusUptimeSeconds() uint64 {
	if statusProcessStartedAt.IsZero() {
		return 0
	}
	if d := time.Since(statusProcessStartedAt); d > 0 {
		return uint64(d / time.Second)
	}
	return 0
}

func statusLCDNodeInfoURL() string {
	base := strings.TrimRight(strings.TrimSpace(lcdBase), "/")
	if base == "" {
		return ""
	}
	return base + "/cosmos/base/tendermint/v1beta1/node_info"
}

func localBaseURLFromListenAddr(listenAddr string) string {
	switch trimmed := strings.TrimSpace(listenAddr); {
	case trimmed == "":
		return ""
	case strings.HasPrefix(trimmed, "http://"), strings.HasPrefix(trimmed, "https://"):
		return strings.TrimRight(trimmed, "/")
	case strings.HasPrefix(trimmed, ":"):
		return "http://127.0.0.1" + trimmed
	case strings.HasPrefix(trimmed, "0.0.0.0:"):
		return "http://127.0.0.1:" + strings.TrimPrefix(trimmed, "0.0.0.0:")
	case strings.HasPrefix(trimmed, "localhost:"), strings.HasPrefix(trimmed, "127.0.0.1:"):
		return "http://" + trimmed
	default:
		return "http://" + trimmed
	}
}

func firstHTTPBaseFromEndpoints(endpoints []string) string {
	for _, endpoint := range endpoints {
		base, err := httpBaseURLFromMultiaddr(endpoint)
		if err == nil && strings.TrimSpace(base) != "" {
			return base
		}
	}
	return ""
}

func fetchProviderStatusFromLCD(ctx context.Context, providerAddr string) (*lcdProviderStatusResponse, string, error) {
	base := strings.TrimRight(strings.TrimSpace(lcdBase), "/")
	if base == "" || strings.TrimSpace(providerAddr) == "" {
		return nil, "unknown", nil
	}

	var payload lcdProviderStatusResponse
	statusCode, err := fetchStatusJSON(ctx, base+"/polystorechain/polystorechain/v1/providers/"+providerAddr, &payload)
	switch statusCode {
	case http.StatusOK:
		return &payload, "registered", nil
	case http.StatusNotFound:
		return nil, "unregistered", nil
	default:
		return nil, "unknown", err
	}
}

func fetchProviderPairingFromLCD(ctx context.Context, providerAddr string) (*lcdProviderPairingResponse, string, error) {
	base := strings.TrimRight(strings.TrimSpace(lcdBase), "/")
	if base == "" || strings.TrimSpace(providerAddr) == "" {
		return nil, "unknown", nil
	}

	var payload lcdProviderPairingResponse
	statusCode, err := fetchStatusJSON(ctx, base+"/polystorechain/polystorechain/v1/provider-pairings/"+providerAddr, &payload)
	switch statusCode {
	case http.StatusOK:
		return &payload, "paired", nil
	case http.StatusNotFound:
		return nil, "not_found", nil
	default:
		return nil, "unknown", err
	}
}

func fetchPendingProviderLinkFromLCD(ctx context.Context, providerAddr string) (*lcdPendingProviderLinkResponse, string, error) {
	base := strings.TrimRight(strings.TrimSpace(lcdBase), "/")
	if base == "" || strings.TrimSpace(providerAddr) == "" {
		return nil, "unknown", nil
	}

	var payload lcdPendingProviderLinkResponse
	statusCode, err := fetchStatusJSON(ctx, base+"/polystorechain/polystorechain/v1/provider-pairings/pending/"+providerAddr, &payload)
	switch statusCode {
	case http.StatusOK:
		return &payload, "pending", nil
	case http.StatusNotFound:
		return nil, "not_found", nil
	default:
		return nil, "unknown", err
	}
}

func fetchStatusJSON(ctx context.Context, url string, dest any) (int, error) {
	if strings.TrimSpace(url) == "" {
		return 0, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	client := http.Client{Timeout: 2 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return res.StatusCode, fmt.Errorf("unexpected status %d for %s", res.StatusCode, url)
	}
	if err := json.NewDecoder(res.Body).Decode(dest); err != nil {
		return res.StatusCode, err
	}
	return res.StatusCode, nil
}

func dedupeIssues(issues []string) []string {
	if len(issues) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(issues))
	out := make([]string, 0, len(issues))
	for _, issue := range issues {
		issue = strings.TrimSpace(issue)
		if issue == "" {
			continue
		}
		if _, ok := seen[issue]; ok {
			continue
		}
		seen[issue] = struct{}{}
		out = append(out, issue)
	}
	if len(out) == 0 {
		return nil
	}
	return out
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
