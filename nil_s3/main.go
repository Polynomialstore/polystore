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
)

// Simple txhash extractor, shared with faucet-style flows.
var txHashRe = regexp.MustCompile(`txhash:\s*([A-Fa-f0-9]+)`)

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
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
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
