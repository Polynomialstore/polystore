package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/gorilla/mux"
)

// Configurable paths & chain settings (overridable via env).
var (
	uploadDir       = envDefault("NIL_UPLOAD_DIR", "uploads")
	nilCliPath      = envDefault("NIL_CLI_BIN", "../nil_cli/target/debug/nil_cli")
	trustedSetup    = envDefault("NIL_TRUSTED_SETUP", "../nilchain/trusted_setup.txt")
	nilchaindBin    = envDefault("NILCHAIND_BIN", "nilchaind")
	chainID         = envDefault("NIL_CHAIN_ID", "test-1")
	homeDir         = envDefault("NIL_HOME", "../_artifacts/nilchain_data")
	gasPrices       = envDefault("NIL_GAS_PRICES", "0.001aatom")
	defaultDuration = envDefault("NIL_DEFAULT_DURATION_BLOCKS", "1000")
	lcdBase         = envDefault("NIL_LCD_BASE", "http://localhost:1317")
)

// Simple txhash extractor, shared with faucet-style flows.
var txHashRe = regexp.MustCompile(`txhash:\s*([A-Fa-f0-9]+)`)

type fileIndexEntry struct {
	CID      string `json:"cid"`
	Path     string `json:"path"`
	Filename string `json:"filename"`
	Size     uint64 `json:"size"`
}

func main() {
	// Ensure upload dir
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatalf("failed to create upload dir %s: %v", uploadDir, err)
	}

	r := mux.NewRouter()
	// Legacy S3-style interface
	r.HandleFunc("/api/v1/object/{key}", PutObject).Methods("PUT")
	r.HandleFunc("/api/v1/object/{key}", GetObject).Methods("GET")

	// Gateway endpoints used by the web UI
	r.HandleFunc("/gateway/upload", GatewayUpload).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/create-deal", GatewayCreateDeal).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/fetch/{cid}", GatewayFetch).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/prove-retrieval", GatewayProveRetrieval).Methods("POST", "OPTIONS")

	log.Println("Starting NilStore Gateway/S3 Adapter on :8080")
	log.Fatal(http.ListenAndServe(":8080", r))
}

func PutObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]

	log.Printf("PUT object: %s", key)

	// 1. Save file
	path := filepath.Join(uploadDir, key)
	f, err := os.Create(path)
	if err != nil {
		http.Error(w, "Failed to create file", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	if _, err := io.Copy(f, r.Body); err != nil {
		http.Error(w, "Failed to write file", http.StatusInternalServerError)
		return
	}

	// 2. Compute CID + size using nil-cli
	cid, size, err := shardFile(path)
	if err != nil {
		http.Error(w, fmt.Sprintf("Sharding failed: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "Object stored. CID: %s, Size: %d.", cid, size)
}

func GetObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]
	path := filepath.Join(uploadDir, key)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		http.Error(w, "Object not found", http.StatusNotFound)
		return
	}

	http.ServeFile(w, r, path)
}

// GatewayUpload is used by the web UI to upload a file and derive a Root CID + size.
// It does NOT create a deal; it just returns metadata.
func GatewayUpload(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "invalid multipart form", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file field is required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	owner := r.FormValue("owner")
	log.Printf("GatewayUpload: file=%s owner=%s", header.Filename, owner)

	// Persist file under a deterministic key (filename-based for now).
	key := strings.TrimSpace(header.Filename)
	if key == "" {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	path := filepath.Join(uploadDir, key)
	out, err := os.Create(path)
	if err != nil {
		http.Error(w, "failed to create file", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		http.Error(w, "failed to write file", http.StatusInternalServerError)
		return
	}
	if err := out.Close(); err != nil {
		http.Error(w, "failed to close file", http.StatusInternalServerError)
		return
	}

	cid, size, err := shardFile(path)
	if err != nil {
		http.Error(w, fmt.Sprintf("sharding failed: %v", err), http.StatusInternalServerError)
		return
	}

	// Record this file in a simple local index so we can serve it back
	// by Root CID in Mode 1 (FullReplica) fetch flows.
	if err := recordFileInIndex(cid, path, header.Filename, size); err != nil {
		log.Printf("GatewayUpload: failed to record file index: %v", err)
	}

	resp := map[string]any{
		"cid":        cid,
		"size_bytes": size,
		"filename":   header.Filename,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewayUpload encode error: %v", err)
	}
}

// GatewayCreateDeal accepts a spec-aligned payload and creates a deal on-chain.
// For now it signs using the faucet/system key, but the logical creator is
// included in the request for future user-signed flows.
type createDealRequest struct {
	Creator         string `json:"creator"`
	Cid             string `json:"cid"`
	SizeBytes       uint64 `json:"size_bytes"`
	DurationBlocks  uint64 `json:"duration_blocks"`
	ServiceHint     string `json:"service_hint"`
	InitialEscrow   string `json:"initial_escrow"`
	MaxMonthlySpend string `json:"max_monthly_spend"`
}

type proveRetrievalRequest struct {
	Cid    string `json:"cid"`
	DealID uint64 `json:"deal_id"`
	Epoch  uint64 `json:"epoch_id,omitempty"`
}

func GatewayCreateDeal(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req createDealRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Cid == "" || req.SizeBytes == 0 || req.InitialEscrow == "" || req.MaxMonthlySpend == "" {
		http.Error(w, "missing fields", http.StatusBadRequest)
		return
	}

	sizeStr := strconv.FormatUint(req.SizeBytes, 10)
	durationStr := strconv.FormatUint(req.DurationBlocks, 10)
	if durationStr == "0" {
		durationStr = defaultDuration
	}
	hint := strings.TrimSpace(req.ServiceHint)
	if hint == "" {
		hint = "General"
	}

	// NOTE: We sign as the faucet/system key for now. The logical creator is
	// provided in req.Creator and can be wired into on-chain state later.
	cmd := exec.Command(
		nilchaindBin,
		"tx", "nilchain", "create-deal",
		req.Cid,
		sizeStr,
		durationStr,
		req.InitialEscrow,
		req.MaxMonthlySpend,
		"--service-hint", hint,
		"--chain-id", chainID,
		"--from", "faucet",
		"--yes",
		"--keyring-backend", "test",
		"--home", homeDir,
		"--gas-prices", gasPrices,
	)

	out, err := cmd.CombinedOutput()
	outStr := string(out)
	if err != nil {
		log.Printf("GatewayCreateDeal failed: %s", outStr)
		http.Error(w, fmt.Sprintf("tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	txHash := extractTxHash(outStr)
	log.Printf("GatewayCreateDeal success: txhash=%s", txHash)
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"tx_hash": txHash,
	}); err != nil {
		log.Printf("GatewayCreateDeal encode error: %v", err)
	}
}

// GatewayProveRetrieval constructs a RetrievalReceipt for a stored file and
// submits it as a MsgProveLiveness on-chain. This is a devnet Mode 1 helper:
// the gateway plays both "user" and "provider" using the faucet key.
func GatewayProveRetrieval(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req proveRetrievalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Cid == "" {
		http.Error(w, "cid is required", http.StatusBadRequest)
		return
	}

	epoch := req.Epoch
	if epoch == 0 {
		epoch = 1
	}

	// For the devnet, we use the faucet key as both the logical user and provider.
	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	providerAddr, err := resolveKeyAddress(providerKeyName)
	if err != nil {
		log.Printf("GatewayProveRetrieval: resolveKeyAddress failed: %v", err)
		http.Error(w, "failed to resolve provider address", http.StatusInternalServerError)
		return
	}

	entry, err := lookupFileInIndex(req.Cid)
	if err != nil {
		log.Printf("GatewayProveRetrieval: index lookup failed: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if entry == nil {
		http.Error(w, "file not found for cid", http.StatusNotFound)
		return
	}

	txHash, err := submitRetrievalProofWithParams(req.DealID, epoch, providerKeyName, providerAddr, entry.Path)
	if err != nil {
		log.Printf("GatewayProveRetrieval: submitRetrievalProof failed: %v", err)
		http.Error(w, "failed to submit retrieval proof (check nilchaind logs)", http.StatusInternalServerError)
		return
	}

	log.Printf("GatewayProveRetrieval success: txhash=%s", txHash)
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"tx_hash": txHash,
	}); err != nil {
		log.Printf("GatewayProveRetrieval encode error: %v", err)
	}
}

// GatewayFetch serves back a stored file by its Root CID.
// This is a Mode 1 (FullReplica) helper for local/testnet flows where
// the gateway acts as both ingress and provider. For devnet correctness,
// it atomically:
//   1) Verifies that the requested owner matches the on-chain Deal owner.
//   2) Submits a retrieval proof (MsgProveLiveness) on-chain.
//   3) Streams the file back to the caller.
func GatewayFetch(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	cid := strings.TrimSpace(vars["cid"])
	if cid == "" {
		http.Error(w, "cid path parameter is required", http.StatusBadRequest)
		return
	}

	q := r.URL.Query()
	dealIDStr := strings.TrimSpace(q.Get("deal_id"))
	owner := strings.TrimSpace(q.Get("owner"))
	if dealIDStr == "" || owner == "" {
		http.Error(w, "deal_id and owner query parameters are required", http.StatusBadRequest)
		return
	}

	dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid deal_id", http.StatusBadRequest)
		return
	}

	// 1) Guard: ensure the caller's owner matches the on-chain Deal owner.
	dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		log.Printf("GatewayFetch: failed to fetch deal %d: %v", dealID, err)
		http.Error(w, "failed to validate deal owner", http.StatusInternalServerError)
		return
	}
	if dealOwner == "" || dealOwner != owner {
		http.Error(w, "forbidden: owner does not match deal", http.StatusForbidden)
		return
	}
	if dealCID != "" && dealCID != cid {
		http.Error(w, "cid does not match deal", http.StatusBadRequest)
		return
	}

	entry, err := lookupFileInIndex(cid)
	if err != nil {
		log.Printf("GatewayFetch: lookup failed for cid %s: %v", cid, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if entry == nil {
		http.Error(w, "file not found for cid", http.StatusNotFound)
		return
	}

	// 2) Submit the retrieval proof before serving the file.
	if _, err := submitRetrievalProof(dealID, entry.Path); err != nil {
		log.Printf("GatewayFetch: submitRetrievalProof failed: %v", err)
		http.Error(w, "failed to submit retrieval proof", http.StatusInternalServerError)
		return
	}

	// Serve as attachment so browsers will download instead of inline JSON.
	w.Header().Set("Content-Type", "application/octet-stream")
	if entry.Filename != "" {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", entry.Filename))
	}
	http.ServeFile(w, r, entry.Path)
}

// shardFile runs nil-cli shard on the given path and extracts the DU root CID
// and file size.
func shardFile(path string) (string, uint64, error) {
	outPath := path + ".json"

	cmd := exec.Command(
		nilCliPath,
		"--trusted-setup", trustedSetup,
		"shard",
		path,
		"--out", outPath,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("shardFile: shard failed: %s", string(output))
		return "", 0, fmt.Errorf("nil_cli shard failed: %w", err)
	}

	jsonFile, err := os.ReadFile(outPath)
	if err != nil {
		return "", 0, fmt.Errorf("failed to read shard output: %w", err)
	}

	var shardOut map[string]any
	if err := json.Unmarshal(jsonFile, &shardOut); err != nil {
		return "", 0, fmt.Errorf("failed to parse shard output: %w", err)
	}

	rawCID, ok := shardOut["du_c_root_hex"].(string)
	if !ok || rawCID == "" {
		return "", 0, fmt.Errorf("du_c_root_hex missing in shard output")
	}

	sizeVal, ok := shardOut["file_size_bytes"].(float64)
	if !ok {
		return "", 0, fmt.Errorf("file_size_bytes missing in shard output")
	}
	size := uint64(sizeVal)

	return rawCID, size, nil
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func extractTxHash(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "txhash:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			return strings.TrimSpace(fields[1])
		}
	}
	if m := txHashRe.FindStringSubmatch(out); len(m) == 2 {
		return m[1]
	}
	return ""
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func indexPath() string {
	return filepath.Join(uploadDir, "index.json")
}

func loadFileIndex() (map[string]fileIndexEntry, error) {
	path := indexPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]fileIndexEntry{}, nil
		}
		return nil, err
	}
	var entries []fileIndexEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	index := make(map[string]fileIndexEntry, len(entries))
	for _, e := range entries {
		if e.CID == "" {
			continue
		}
		index[e.CID] = e
	}
	return index, nil
}

func saveFileIndex(index map[string]fileIndexEntry) error {
	entries := make([]fileIndexEntry, 0, len(index))
	for _, e := range index {
		entries = append(entries, e)
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(indexPath(), data, 0o644)
}

func recordFileInIndex(cid, path, filename string, size uint64) error {
	idx, err := loadFileIndex()
	if err != nil {
		return err
	}
	idx[cid] = fileIndexEntry{
		CID:      cid,
		Path:     path,
		Filename: filename,
		Size:     size,
	}
	return saveFileIndex(idx)
}

func lookupFileInIndex(cid string) (*fileIndexEntry, error) {
	idx, err := loadFileIndex()
	if err != nil {
		return nil, err
	}
	if e, ok := idx[cid]; ok {
		return &e, nil
	}
	return nil, nil
}

// resolveKeyAddress returns the bech32 address for a key name in the local keyring.
func resolveKeyAddress(name string) (string, error) {
	cmd := exec.Command(
		nilchaindBin,
		"keys", "show", name,
		"-a",
		"--home", homeDir,
		"--keyring-backend", "test",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("keys show failed: %v (%s)", err, string(out))
	}
	return strings.TrimSpace(string(out)), nil
}

// submitRetrievalProof submits a retrieval proof for the given deal and file
// using the default provider key and epoch.
func submitRetrievalProof(dealID uint64, filePath string) (string, error) {
	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	providerAddr, err := resolveKeyAddress(providerKeyName)
	if err != nil {
		return "", fmt.Errorf("resolveKeyAddress failed: %w", err)
	}
	return submitRetrievalProofWithParams(dealID, 1, providerKeyName, providerAddr, filePath)
}

// submitRetrievalProofWithParams generates a RetrievalReceipt via the CLI and
// submits it as a retrieval proof, returning the tx hash.
func submitRetrievalProofWithParams(dealID, epoch uint64, providerKeyName, providerAddr, filePath string) (string, error) {
	dealIDStr := strconv.FormatUint(dealID, 10)
	epochStr := strconv.FormatUint(epoch, 10)

	// 1) Generate a RetrievalReceipt JSON via the CLI (offline signing).
	signCmd := exec.Command(
		nilchaindBin,
		"tx", "nilchain", "sign-retrieval-receipt",
		dealIDStr,
		providerAddr,
		epochStr,
		filePath,
		trustedSetup,
		"--from", providerKeyName,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--offline",
	)
	signOut, err := signCmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("sign-retrieval-receipt failed: %w (%s)", err, string(signOut))
	}

	tmpFile, err := os.CreateTemp(uploadDir, "receipt-*.json")
	if err != nil {
		return "", fmt.Errorf("CreateTemp failed: %w", err)
	}
	tmpPath := tmpFile.Name()
	if _, err := tmpFile.Write(signOut); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("writing receipt file failed: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("closing receipt file failed: %w", err)
	}
	defer os.Remove(tmpPath)

	// 2) Submit the receipt as a retrieval proof.
	submitCmd := exec.Command(
		nilchaindBin,
		"tx", "nilchain", "submit-retrieval-proof",
		tmpPath,
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas-prices", gasPrices,
	)
	submitOut, err := submitCmd.CombinedOutput()
	outStr := string(submitOut)
	if err != nil {
		return "", fmt.Errorf("submit-retrieval-proof failed: %w (%s)", err, outStr)
	}

	return extractTxHash(outStr), nil
}

// fetchDealOwnerAndCID calls the LCD to retrieve the deal owner and CID for a given deal ID.
func fetchDealOwnerAndCID(dealID uint64) (owner string, cid string, err error) {
	url := fmt.Sprintf("%s/nilchain/nilchain/v1/deals/%d", lcdBase, dealID)
	resp, err := http.Get(url)
	if err != nil {
		return "", "", fmt.Errorf("LCD request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("LCD returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload struct {
		Deal map[string]any `json:"deal"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", "", fmt.Errorf("failed to decode LCD response: %w", err)
	}
	if payload.Deal == nil {
		return "", "", fmt.Errorf("LCD response missing deal field")
	}

	if v, ok := payload.Deal["owner"].(string); ok {
		owner = v
	}
	if v, ok := payload.Deal["cid"].(string); ok {
		cid = v
	}
	return owner, cid, nil
}
