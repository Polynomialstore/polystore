package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"polystorechain/x/polystorechain/types"
)

const (
	providerAdminActionStatusRefresh  = "status_refresh"
	providerAdminActionRunDoctor      = "run_doctor"
	providerAdminActionRotateEndpoint = "rotate_endpoint"

	providerAdminMaxFutureWindowSeconds = 10 * 60
)

type providerAdminRequest struct {
	Provider  string `json:"provider"`
	Action    string `json:"action"`
	Endpoint  string `json:"endpoint,omitempty"`
	Nonce     uint64 `json:"nonce"`
	ExpiresAt uint64 `json:"expires_at"`
	Signature string `json:"signature"`
}

type providerAdminAuthResult struct {
	Provider    string
	Operator    string
	OperatorEVM string
	Action      string
}

type providerAdminResponse struct {
	Action                string                      `json:"action"`
	Provider              *providerDaemonStatusDetail `json:"provider,omitempty"`
	Issues                []string                    `json:"issues,omitempty"`
	AuthorizedOperator    string                      `json:"authorized_operator"`
	AuthorizedOperatorEVM string                      `json:"authorized_operator_evm"`
	DoctorOutput          string                      `json:"doctor_output,omitempty"`
	TxOutput              string                      `json:"tx_output,omitempty"`
	Endpoint              string                      `json:"endpoint,omitempty"`
	RefreshedAt           string                      `json:"refreshed_at"`
}

type providerAdminNonceStore struct {
	Operators map[string]map[string]uint64 `json:"operators"`
}

var providerAdminNonceStoreMu sync.Mutex

func decodeProviderAdminRequest(r *http.Request) (*providerAdminRequest, error) {
	if r == nil || r.Body == nil {
		return nil, fmt.Errorf("request body is required")
	}
	var req providerAdminRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return nil, fmt.Errorf("invalid JSON body")
	}
	req.Provider = strings.TrimSpace(req.Provider)
	req.Action = strings.TrimSpace(req.Action)
	req.Endpoint = strings.TrimSpace(req.Endpoint)
	req.Signature = strings.TrimSpace(req.Signature)
	return &req, nil
}

func providerAdminNonceStorePath() string {
	if path := strings.TrimSpace(os.Getenv("NIL_PROVIDER_ADMIN_NONCES_PATH")); path != "" {
		return path
	}
	if home := strings.TrimSpace(os.Getenv("NIL_HOME")); home != "" {
		return filepath.Join(home, "provider_admin_nonces.json")
	}
	if upload := strings.TrimSpace(uploadDir); upload != "" {
		return filepath.Join(upload, ".provider_admin_nonces.json")
	}
	return filepath.Join(os.TempDir(), "polystore-provider-admin-nonces.json")
}

func loadProviderAdminNonceStore(path string) (*providerAdminNonceStore, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &providerAdminNonceStore{Operators: make(map[string]map[string]uint64)}, nil
		}
		return nil, err
	}
	store := &providerAdminNonceStore{Operators: make(map[string]map[string]uint64)}
	if len(raw) == 0 {
		return store, nil
	}
	if err := json.Unmarshal(raw, store); err != nil {
		return nil, fmt.Errorf("invalid nonce store: %w", err)
	}
	if store.Operators == nil {
		store.Operators = make(map[string]map[string]uint64)
	}
	return store, nil
}

func persistProviderAdminNonceStore(path string, store *providerAdminNonceStore) error {
	if store == nil {
		store = &providerAdminNonceStore{Operators: make(map[string]map[string]uint64)}
	}
	if store.Operators == nil {
		store.Operators = make(map[string]map[string]uint64)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "provider-admin-nonces-*.json")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func consumeProviderAdminNonce(operator string, nonce uint64, expiresAt uint64) error {
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return fmt.Errorf("operator address is required")
	}
	now := uint64(time.Now().Unix())

	providerAdminNonceStoreMu.Lock()
	defer providerAdminNonceStoreMu.Unlock()

	path := providerAdminNonceStorePath()
	store, err := loadProviderAdminNonceStore(path)
	if err != nil {
		return fmt.Errorf("load provider admin nonce store: %w", err)
	}

	for addr, nonces := range store.Operators {
		for value, expiry := range nonces {
			if expiry <= now {
				delete(nonces, value)
			}
		}
		if len(nonces) == 0 {
			delete(store.Operators, addr)
		}
	}

	nonceKey := strconv.FormatUint(nonce, 10)
	nonces := store.Operators[operator]
	if nonces == nil {
		nonces = make(map[string]uint64)
		store.Operators[operator] = nonces
	}
	if expiry, ok := nonces[nonceKey]; ok && expiry > now {
		return fmt.Errorf("provider admin request nonce has already been used")
	}
	nonces[nonceKey] = expiresAt
	if err := persistProviderAdminNonceStore(path, store); err != nil {
		return fmt.Errorf("persist provider admin nonce store: %w", err)
	}
	return nil
}

func providerAdminStatusSnapshot(ctx context.Context) (*providerDaemonStatusDetail, []string) {
	listenAddr := envDefault("NIL_LISTEN_ADDR", ":8080")
	lcdReachable := pingURL(ctx, statusLCDNodeInfoURL())
	return buildProviderDaemonStatus(ctx, listenAddr, lcdReachable)
}

func verifyProviderAdminRequest(ctx context.Context, req *providerAdminRequest, wantAction string) (*providerAdminAuthResult, error) {
	if req == nil {
		return nil, fmt.Errorf("request is required")
	}
	if strings.TrimSpace(wantAction) == "" {
		return nil, fmt.Errorf("provider admin action is required")
	}
	if req.Action == "" {
		return nil, fmt.Errorf("action is required")
	}
	if req.Action != wantAction {
		return nil, fmt.Errorf("unexpected action %q", req.Action)
	}
	if req.Nonce == 0 {
		return nil, fmt.Errorf("nonce is required")
	}
	if req.ExpiresAt == 0 {
		return nil, fmt.Errorf("expires_at is required")
	}
	now := uint64(time.Now().Unix())
	if req.ExpiresAt+30 < now {
		return nil, fmt.Errorf("provider admin request signature expired")
	}
	if req.ExpiresAt > now+providerAdminMaxFutureWindowSeconds {
		return nil, fmt.Errorf("provider admin request expires too far in the future")
	}
	if req.Signature == "" {
		return nil, fmt.Errorf("signature is required")
	}

	localProviderAddr := strings.TrimSpace(cachedProviderAddress(ctx))
	if localProviderAddr == "" {
		return nil, fmt.Errorf("provider address unavailable")
	}
	if req.Provider == "" {
		return nil, fmt.Errorf("provider is required")
	}
	if req.Provider != localProviderAddr {
		return nil, fmt.Errorf("provider mismatch")
	}

	sigBytes, err := decodeHex(req.Signature)
	if err != nil {
		return nil, fmt.Errorf("invalid signature: %w", err)
	}
	structHash := types.HashProviderAdminAction(req.Provider, req.Action, req.Endpoint, req.Nonce, req.ExpiresAt)
	digest := types.ComputeEIP712Digest(types.HashDomainSeparator(eip712ChainID()), structHash)
	evmAddr, err := recoverEvmAddressFromDigest(digest, sigBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to recover operator signer: %w", err)
	}
	operatorAddr, err := evmHexToNilAddress(evmAddr.Hex())
	if err != nil {
		return nil, fmt.Errorf("failed to map operator signer to nil address: %w", err)
	}

	pairing, pairingStatus, pairingErr := fetchProviderPairingFromLCD(ctx, localProviderAddr)
	if pairingStatus != "paired" || pairing == nil {
		switch pairingStatus {
		case "not_found":
			return nil, fmt.Errorf("provider is not paired to an operator wallet")
		default:
			if pairingErr != nil {
				return nil, fmt.Errorf("provider pairing lookup failed: %w", pairingErr)
			}
			return nil, fmt.Errorf("provider pairing is unavailable")
		}
	}
	if strings.TrimSpace(pairing.Pairing.Operator) != operatorAddr {
		return nil, fmt.Errorf("signer does not match paired operator")
	}
	if err := consumeProviderAdminNonce(operatorAddr, req.Nonce, req.ExpiresAt); err != nil {
		return nil, err
	}

	return &providerAdminAuthResult{
		Provider:    localProviderAddr,
		Operator:    operatorAddr,
		OperatorEVM: strings.ToLower(evmAddr.Hex()),
		Action:      req.Action,
	}, nil
}

func renderProviderDoctor(detail *providerDaemonStatusDetail, issues []string) string {
	if detail == nil {
		return "FAIL: provider-daemon status unavailable"
	}

	lines := []string{
		"==> provider-daemon doctor",
		fmt.Sprintf("  key:    %s", orDefault(detail.KeyName, "missing")),
		fmt.Sprintf("  addr:   %s", orDefault(detail.Address, "missing")),
		fmt.Sprintf("  lcd:    %s", orDefault(detail.LCDBase, "missing")),
		fmt.Sprintf("  node:   %s", orDefault(detail.NodeAddr, "missing")),
	}

	if detail.SpAuthPresent {
		lines = append(lines, "OK: gateway shared auth is configured")
	} else {
		lines = append(lines, "FAIL: NIL_GATEWAY_SP_AUTH is missing")
	}

	switch detail.PairingStatus {
	case "paired":
		lines = append(lines, fmt.Sprintf("OK: paired to operator %s", orDefault(detail.PairedOperator, "unknown")))
	case "pending":
		lines = append(lines, fmt.Sprintf("WARN: pairing is pending for operator %s", orDefault(detail.PendingOperator, "unknown")))
	default:
		lines = append(lines, "WARN: provider is not paired to an operator wallet")
	}

	if detail.RegistrationStatus == "registered" {
		lines = append(lines, fmt.Sprintf("OK: visible on-chain as %s", orDefault(detail.OnchainStatus, "registered")))
	} else {
		lines = append(lines, "WARN: provider is not registered on-chain")
	}

	if detail.LocalHealthOK {
		lines = append(lines, fmt.Sprintf("OK: local health reachable at %s", orDefault(detail.LocalHealthURL, "n/a")))
	} else {
		lines = append(lines, fmt.Sprintf("WARN: local health unreachable at %s", orDefault(detail.LocalHealthURL, "n/a")))
	}

	if detail.PublicHealthURL != "" {
		if detail.PublicHealthOK {
			lines = append(lines, fmt.Sprintf("OK: public health reachable at %s", detail.PublicHealthURL))
		} else {
			lines = append(lines, fmt.Sprintf("WARN: public health unreachable at %s", detail.PublicHealthURL))
		}
	}

	if len(detail.Endpoints) > 0 {
		lines = append(lines, fmt.Sprintf("OK: %d endpoint(s) registered", len(detail.Endpoints)))
	} else {
		lines = append(lines, "WARN: provider endpoints are not configured")
	}

	if len(issues) > 0 {
		lines = append(lines, "Issues:")
		for _, issue := range issues {
			lines = append(lines, fmt.Sprintf("  - %s", issue))
		}
	} else {
		lines = append(lines, "Doctor finished with no active issues.")
	}

	return strings.Join(lines, "\n")
}

func orDefault(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func providerAdminRegisterOrUpdateEndpoint(ctx context.Context, endpoint string) (string, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", fmt.Errorf("endpoint is required")
	}

	providerKeyName := strings.TrimSpace(os.Getenv("NIL_PROVIDER_KEY"))
	if providerKeyName == "" {
		return "", fmt.Errorf("NIL_PROVIDER_KEY is required")
	}

	providerAddr := strings.TrimSpace(cachedProviderAddress(ctx))
	if providerAddr == "" {
		return "", fmt.Errorf("provider address unavailable")
	}

	_, registrationStatus, regErr := fetchProviderStatusFromLCD(ctx, providerAddr)
	if registrationStatus == "unknown" {
		if regErr != nil {
			return "", fmt.Errorf("provider registration state unavailable: %w", regErr)
		}
		return "", fmt.Errorf("provider registration state unavailable")
	}

	args := []string{"tx", "polystorechain"}
	switch registrationStatus {
	case "registered":
		args = append(args, "update-provider-endpoints", "--endpoint", endpoint)
	case "unregistered":
		args = append(
			args,
			"register-provider",
			envDefault("NIL_PROVIDER_CAPABILITIES", "General"),
			envDefault("NIL_PROVIDER_TOTAL_STORAGE", "1099511627776"),
			"--endpoint",
			endpoint,
		)
	default:
		return "", fmt.Errorf("unsupported provider registration state %q", registrationStatus)
	}

	args = append(
		args,
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--node", nodeAddr,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--gas", "auto",
		"--gas-adjustment", "1.6",
		"--gas-prices", gasPrices,
		"--yes",
	)

	out, err := runCommand(ctx, polystorechaindBin, args, "")
	output := strings.TrimSpace(string(out))
	if err != nil {
		if output == "" {
			output = err.Error()
		}
		return output, fmt.Errorf("provider endpoint update failed: %w", err)
	}
	return output, nil
}

func writeProviderAdminResponse(w http.ResponseWriter, auth *providerAdminAuthResult, action string, detail *providerDaemonStatusDetail, issues []string, doctorOutput string, txOutput string, endpoint string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(providerAdminResponse{
		Action:                action,
		Provider:              detail,
		Issues:                issues,
		AuthorizedOperator:    auth.Operator,
		AuthorizedOperatorEVM: auth.OperatorEVM,
		DoctorOutput:          doctorOutput,
		TxOutput:              txOutput,
		Endpoint:              endpoint,
		RefreshedAt:           time.Now().UTC().Format(time.RFC3339),
	})
}

func SpAdminStatus(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	req, err := decodeProviderAdminRequest(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error(), "")
		return
	}
	auth, err := verifyProviderAdminRequest(r.Context(), req, providerAdminActionStatusRefresh)
	if err != nil {
		writeJSONError(w, http.StatusForbidden, "forbidden", err.Error())
		return
	}

	detail, issues := providerAdminStatusSnapshot(r.Context())
	writeProviderAdminResponse(w, auth, providerAdminActionStatusRefresh, detail, issues, "", "", "")
}

func SpAdminDoctor(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	req, err := decodeProviderAdminRequest(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error(), "")
		return
	}
	auth, err := verifyProviderAdminRequest(r.Context(), req, providerAdminActionRunDoctor)
	if err != nil {
		writeJSONError(w, http.StatusForbidden, "forbidden", err.Error())
		return
	}

	detail, issues := providerAdminStatusSnapshot(r.Context())
	writeProviderAdminResponse(w, auth, providerAdminActionRunDoctor, detail, issues, renderProviderDoctor(detail, issues), "", "")
}

func SpAdminRotateEndpoint(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	req, err := decodeProviderAdminRequest(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error(), "")
		return
	}
	if req.Endpoint == "" {
		writeJSONError(w, http.StatusBadRequest, "endpoint is required", "")
		return
	}
	auth, err := verifyProviderAdminRequest(r.Context(), req, providerAdminActionRotateEndpoint)
	if err != nil {
		writeJSONError(w, http.StatusForbidden, "forbidden", err.Error())
		return
	}

	txOutput, err := providerAdminRegisterOrUpdateEndpoint(r.Context(), req.Endpoint)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error(), txOutput)
		return
	}

	detail, issues := providerAdminStatusSnapshot(r.Context())
	writeProviderAdminResponse(w, auth, providerAdminActionRotateEndpoint, detail, issues, "", txOutput, req.Endpoint)
}
