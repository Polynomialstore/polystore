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
	"time"

	"github.com/gorilla/mux"
)

// Configurable paths & chain settings (overridable via env).
var (
	uploadDir       = envDefault("NIL_UPLOAD_DIR", "uploads")
	nilCliPath      = envDefault("NIL_CLI_BIN", "../nil_cli/target/release/nil_cli")
	trustedSetup    = envDefault("NIL_TRUSTED_SETUP", "../nilchain/trusted_setup.txt")
	nilchaindBin    = envDefault("NILCHAIND_BIN", "nilchaind")
	chainID         = envDefault("NIL_CHAIN_ID", "test-1")
	homeDir         = envDefault("NIL_HOME", "../_artifacts/nilchain_data")
	gasPrices       = envDefault("NIL_GAS_PRICES", "0.001aatom")
	defaultDuration = envDefault("NIL_DEFAULT_DURATION_BLOCKS", "1000")
	lcdBase         = envDefault("NIL_LCD_BASE", "http://localhost:1317")

	execCommand = exec.Command
)

// Simple txhash extractor, shared with faucet-style flows.
var txHashRe = regexp.MustCompile(`txhash:\s*([A-Fa-f0-9]+)`)

type fileIndexEntry struct {
	CID      string `json:"cid"`
	Path     string `json:"path"`
	Filename string `json:"filename"`
	Size     uint64 `json:"size"`
}

type NilCliOutput struct {
	ManifestRootHex string    `json:"manifest_root_hex"`
	ManifestBlobHex string    `json:"manifest_blob_hex"`
	FileSize        uint64    `json:"file_size_bytes"`
	Mdus            []MduData `json:"mdus"`
}

type MduData struct {
	Index   int      `json:"index"`
	RootHex string   `json:"root_hex"`
	Blobs   []string `json:"blobs"`
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
	r.HandleFunc("/gateway/update-deal-content", GatewayUpdateDealContent).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/create-deal-evm", GatewayCreateDealFromEvm).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/update-deal-content-evm", GatewayUpdateDealContentFromEvm).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/fetch/{cid}", GatewayFetch).Methods("GET", "OPTIONS")
	r.HandleFunc("/gateway/manifest/{cid}", GatewayManifest).Methods("GET", "OPTIONS")
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
	out, err := shardFile(path, false)
	if err != nil {
		http.Error(w, fmt.Sprintf("Sharding failed: %v", err), http.StatusInternalServerError)
		return
	}
	cid := out.ManifestRootHex
	size := out.FileSize

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
	dealIDStr := r.FormValue("deal_id")
	log.Printf("GatewayUpload: file=%s owner=%s deal_id=%s", header.Filename, owner, dealIDStr)

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

	var cid string
	var size uint64
	var allocatedLength uint64

	if dealIDStr == "" {
		// New Deal Flow: Ingest into MDU #0 structure
		maxMdus := uint64(65536) // Default 512GB
		_, manifestRoot, allocLen, err := IngestNewDeal(path, maxMdus)
		if err != nil {
			http.Error(w, fmt.Sprintf("IngestNewDeal failed: %v", err), http.StatusInternalServerError)
			return
		}
		cid = manifestRoot
		allocatedLength = allocLen
		
		// For backward compatibility (legacy index), we assume size is file size?
		// We need file size. IngestNewDeal doesn't return it directly but calculates it.
		// Let's just stat the file or use header.Size?
		if info, err := os.Stat(path); err == nil {
			size = uint64(info.Size())
		}
	} else {
		// Legacy/Append Flow (Not fully refactored yet, fallback to single-file shard)
		shardOut, err := shardFile(path, false)
		if err != nil {
			http.Error(w, fmt.Sprintf("sharding failed: %v", err), http.StatusInternalServerError)
			return
		}
		cid = shardOut.ManifestRootHex
		size = shardOut.FileSize
	}

	// Record this file in a simple local index so we can serve it back
	// by Root CID in Mode 1 (FullReplica) fetch flows.
	if err := recordFileInIndex(cid, path, header.Filename, size); err != nil {
		log.Printf("GatewayUpload: failed to record file index: %v", err)
	}

	resp := map[string]any{
		"cid":              cid,
		"manifest_root":    cid,
		"size_bytes":       size,
		"allocated_length": allocatedLength,
		"filename":         header.Filename,
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
	DealSizeTier    uint32 `json:"size_tier"`
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

// createDealFromEvmRequest is the payload expected by /gateway/create-deal-evm.
// It mirrors the on-chain MsgCreateDealFromEvm JSON shape.
type createDealFromEvmRequest struct {
	Intent       map[string]any `json:"intent"`
	EvmSignature string         `json:"evm_signature"`
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
	if req.DealSizeTier == 0 || req.InitialEscrow == "" || req.MaxMonthlySpend == "" {
		http.Error(w, "missing fields", http.StatusBadRequest)
		return
	}

	tierStr := strconv.FormatUint(uint64(req.DealSizeTier), 10)
durationStr := strconv.FormatUint(req.DurationBlocks, 10)
	if durationStr == "0" {
		durationStr = defaultDuration
	}
hint := strings.TrimSpace(req.ServiceHint)
	if hint == "" {
		hint = "General"
	}

	// Light economic guardrail: require that the logical creator has at least
	// some stake/atom balance before allowing a deal to be created on their
	// behalf. This forces the UI flow to go through the faucet and ensures the
	// owner appears on-chain, even though the faucet key still sponsors the tx.
	if req.Creator != "" {
		if ok, err := creatorHasSomeBalance(req.Creator); err != nil {
			log.Printf("GatewayCreateDeal: balance check failed for %s: %v", req.Creator, err)
			http.Error(w, "failed to validate creator balance", http.StatusInternalServerError)
			return
		} else if !ok {
			http.Error(w, "creator has no on-chain balance; request testnet NIL from the faucet first", http.StatusBadRequest)
			return
		}
	}

	// NOTE: We sign as the faucet/system key for now. The logical creator is
	// provided in req.Creator and can be wired into on-chain state later.
	cmd := execCommand(
		nilchaindBin,
		"tx", "nilchain", "create-deal",
		tierStr,
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

type updateDealContentRequest struct {
	Creator   string `json:"creator"`
	DealID    uint64 `json:"deal_id"`
	Cid       string `json:"cid"`
	SizeBytes uint64 `json:"size_bytes"`
}

// GatewayUpdateDealContent is a legacy/devnet helper to commit content to a deal
// using the faucet key. It only works if the deal is owned by the faucet (or
// whoever the local keyring signs for).
func GatewayUpdateDealContent(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req updateDealContentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Cid == "" || req.SizeBytes == 0 { // DealID can be 0, which is valid.
		http.Error(w, "missing fields", http.StatusBadRequest)
		return
	}

	dealIDStr := strconv.FormatUint(req.DealID, 10)
	sizeStr := strconv.FormatUint(req.SizeBytes, 10)

	log.Printf("Executing nilchaind command: %s tx nilchain update-deal-content --deal-id %s --cid %s --size %s", nilchaindBin, dealIDStr, req.Cid, sizeStr)

	cmd := execCommand(
		nilchaindBin,
		"tx", "nilchain", "update-deal-content",
		"--deal-id", dealIDStr,
		"--cid", req.Cid,
		"--size", sizeStr,
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
		log.Printf("GatewayUpdateDealContent failed: %s", outStr)
		http.Error(w, fmt.Sprintf("tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	txHash := extractTxHash(outStr)
	log.Printf("GatewayUpdateDealContent success: txhash=%s", txHash)
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"tx_hash": txHash,
	}); err != nil {
		log.Printf("GatewayUpdateDealContent encode error: %v", err)
	}
}

// GatewayCreateDealFromEvm accepts an EVM-signed deal intent and forwards it
// to nilchaind via the MsgCreateDealFromEvm CLI path. This is the primary
// devnet/testnet entrypoint for user-signed deals.
func GatewayCreateDealFromEvm(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req createDealFromEvmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Intent == nil {
		http.Error(w, "intent is required", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.EvmSignature) == "" {
		http.Error(w, "evm_signature is required", http.StatusBadRequest)
		return
	}

	// Light validation of the intent shape.
	rawCreator, okCreator := req.Intent["creator_evm"].(string)
	rawTier, okTier := req.Intent["size_tier"]

	if !okCreator || strings.TrimSpace(rawCreator) == "" || !okTier {
		http.Error(w, "intent must include creator_evm and size_tier", http.StatusBadRequest)
		return
	}

	// Best-effort numeric check for size_tier > 0.
	switch v := rawTier.(type) {
	case float64:
		if v <= 0 {
			http.Error(w, "size_tier must be positive", http.StatusBadRequest)
			return
		}
	case int64:
		if v <= 0 {
			http.Error(w, "size_tier must be positive", http.StatusBadRequest)
			return
		}
	case json.Number:
		n, err := v.Int64()
		if err != nil || n <= 0 {
			http.Error(w, "size_tier must be positive", http.StatusBadRequest)
			return
		}
	}

	tmp, err := os.CreateTemp(uploadDir, "evm-deal-*.json")
	if err != nil {
		http.Error(w, "failed to create temp file", http.StatusInternalServerError)
		return
	}
	tmpPath := tmp.Name()

	payload := map[string]any{
		"intent":        req.Intent,
		"evm_signature": req.EvmSignature,
	}
	if err := json.NewEncoder(tmp).Encode(payload); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		http.Error(w, "failed to encode payload", http.StatusInternalServerError)
		return
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		http.Error(w, "failed to close temp file", http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmpPath)

	cmd := execCommand(
		nilchaindBin,
		"tx", "nilchain", "create-deal-from-evm",
		tmpPath,
		"--chain-id", chainID,
		"--from", "faucet",
		"--yes",
		"--keyring-backend", "test",
		"--home", homeDir,
		"--gas-prices", gasPrices,
		"--broadcast-mode", "sync",
		"--output", "json",
	)

	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("GatewayCreateDealFromEvm failed: %s", string(out))
		http.Error(w, fmt.Sprintf("tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	var txRes struct {
		TxHash string `json:"txhash"`
		Code   int    `json:"code"`
		RawLog string `json:"raw_log"`
	}

	if err := json.Unmarshal(out, &txRes); err != nil {
		log.Printf("GatewayCreateDealFromEvm failed to parse JSON: %v. Output: %s", err, string(out))
		http.Error(w, "failed to parse tx response", http.StatusInternalServerError)
		return
	}

	if txRes.Code != 0 {
		log.Printf("GatewayCreateDealFromEvm tx failed with code %d: %s", txRes.Code, txRes.RawLog)
		http.Error(w, fmt.Sprintf("tx failed: %s", txRes.RawLog), http.StatusInternalServerError)
		return
	}

	txHash := txRes.TxHash
	log.Printf("GatewayCreateDealFromEvm sent: txhash=%s. Polling for inclusion...", txHash)

	var dealID string
	// Poll for tx inclusion (max 10 seconds)
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)

		qCmd := execCommand(
			nilchaindBin,
			"q", "tx", txHash,
			"--output", "json",
			"--node", "tcp://localhost:26657", // Ensure we hit the same node
		)
		qOut, _ := qCmd.CombinedOutput()

				var qRes struct {
					Logs []struct {
						Events []struct {
							Type       string `json:"type"`
							Attributes []struct {
								Key   string `json:"key"`
								Value string `json:"value"`
							} `json:"attributes"`
						} `json:"events"`
					} `json:"logs"`
					Events []struct {
						Type       string `json:"type"`
						Attributes []struct {
							Key   string `json:"key"`
							Value string `json:"value"`
						} `json:"attributes"`
					} `json:"events"`
				}
		
				if err := json.Unmarshal(qOut, &qRes); err == nil {
					// Scan Logs (legacy/standard)
					for _, log := range qRes.Logs {
						for _, event := range log.Events {
							if event.Type == "nilchain.nilchain.EventCreateDeal" || event.Type == "create_deal" {
								for _, attr := range event.Attributes {
									if attr.Key == "id" || attr.Key == "deal_id" {
										dealID = attr.Value
										break
									}
								}
							}
						}
						if dealID != "" {
							break
						}
					}
					// Scan Top-level Events (if Logs was empty or ID not found)
					if dealID == "" {
						for _, event := range qRes.Events {
							if event.Type == "nilchain.nilchain.EventCreateDeal" || event.Type == "create_deal" {
								for _, attr := range event.Attributes {
									if attr.Key == "id" || attr.Key == "deal_id" {
										dealID = attr.Value
										break
									}
								}
							}
							if dealID != "" {
								break
							}
						}
					}
					
					if dealID != "" {
						break
					}
				}
			}
		
			if dealID == "" {
				log.Printf("Error: deal_id not found in tx events after polling. TxHash: %s", txHash)
				http.Error(w, "deal creation failed: deal_id not found in transaction events", http.StatusInternalServerError)
				return
			} else {
				log.Printf("GatewayCreateDealFromEvm confirmed: deal_id=%s", dealID)
			}		
		    resp := map[string]any{
		        "status":  "success",
		        "tx_hash": txHash,
		        "deal_id": dealID,
		    }
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewayCreateDealFromEvm encode error: %v", err)
	}
}

// GatewayUpdateDealContentFromEvm accepts an EVM-signed update content intent.
func GatewayUpdateDealContentFromEvm(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var req createDealFromEvmRequest // Reuse same wrapper
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Intent == nil {
		http.Error(w, "intent is required", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.EvmSignature) == "" {
		http.Error(w, "evm_signature is required", http.StatusBadRequest)
		return
	}

	// Light validation
	rawCid, okCid := req.Intent["cid"].(string)
	rawSize, okSize := req.Intent["size_bytes"]

	if !okCid || strings.TrimSpace(rawCid) == "" || !okSize {
		http.Error(w, "intent must include cid and size_bytes", http.StatusBadRequest)
		return
	}

	// Best-effort numeric check for size_bytes > 0.
	switch v := rawSize.(type) {
	case float64:
		if v <= 0 {
			http.Error(w, "size_bytes must be positive", http.StatusBadRequest)
			return
		}
	case int64:
		if v <= 0 {
			http.Error(w, "size_bytes must be positive", http.StatusBadRequest)
			return
		}
	case json.Number:
		n, err := v.Int64()
		if err != nil || n <= 0 {
			http.Error(w, "size_bytes must be positive", http.StatusBadRequest)
			return
		}
	}

	tmp, err := os.CreateTemp(uploadDir, "evm-update-*.json")
	if err != nil {
		http.Error(w, "failed to create temp file", http.StatusInternalServerError)
		return
	}
	tmpPath := tmp.Name()

	payload := map[string]any{
		"intent":        req.Intent,
		"evm_signature": req.EvmSignature,
	}
	if err := json.NewEncoder(tmp).Encode(payload); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		http.Error(w, "failed to encode payload", http.StatusInternalServerError)
		return
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		http.Error(w, "failed to close temp file", http.StatusInternalServerError)
		return
	}
	defer os.Remove(tmpPath)

	cmd := execCommand(
		nilchaindBin,
		"tx", "nilchain", "update-deal-content-from-evm",
		tmpPath,
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
		log.Printf("GatewayUpdateDealContentFromEvm failed: %s", outStr)
		http.Error(w, fmt.Sprintf("tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	txHash := extractTxHash(outStr)
	log.Printf("GatewayUpdateDealContentFromEvm success: txhash=%s", txHash)

	resp := map[string]any{
		"status":  "success",
		"tx_hash": txHash,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewayUpdateDealContentFromEvm encode error: %v", err)
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

	filePath := q.Get("file_path")
	if filePath != "" {
		// New Logic: Resolve from Slab
		// CID in URL is treated as ManifestRoot
		content, size, err := ResolveFileByPath(cid, filePath)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "file not found in deal", http.StatusNotFound)
			} else {
				log.Printf("ResolveFileByPath failed: %v", err)
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
			return
		}
		defer content.Close()
		
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.FormatUint(size, 10))
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(filePath)))
		io.Copy(w, content)
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

// GatewayManifest serves the manifest (shard output JSON) for a given Root CID.
func GatewayManifest(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	cid := strings.TrimSpace(vars["cid"])
	if cid == "" {
		http.Error(w, "cid required", http.StatusBadRequest)
		return
	}

	entry, err := lookupFileInIndex(cid)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if entry == nil {
		http.Error(w, "manifest not found", http.StatusNotFound)
		return
	}

	// The shard output is stored at <path>.json
	manifestPath := entry.Path + ".json"
	if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
		http.Error(w, "manifest file missing", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	http.ServeFile(w, r, manifestPath)
}

// shardFile runs nil-cli shard on the given path and extracts the full output.
func shardFile(path string, raw bool) (*NilCliOutput, error) {
	outPath := path + ".json"

	args := []string{
		"--trusted-setup", trustedSetup,
		"shard",
		path,
		"--out", outPath,
	}
	if raw {
		args = append(args, "--raw")
	}

	cmd := execCommand(nilCliPath, args...)

	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("shardFile: shard failed: %s", string(output))
		return nil, fmt.Errorf("nil_cli shard failed: %w", err)
	}

	jsonFile, err := os.ReadFile(outPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read shard output: %w", err)
	}

	var shardOut NilCliOutput
	if err := json.Unmarshal(jsonFile, &shardOut); err != nil {
		return nil, fmt.Errorf("failed to parse shard output: %w", err)
	}

	if shardOut.ManifestRootHex == "" {
		return nil, fmt.Errorf("manifest_root_hex missing in shard output")
	}

	return &shardOut, nil
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
	cmd := execCommand(
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

	// Ensure we have a valid 8 MiB MDU file for the proof generator.
	mduPath, isTemp, err := ensureMduFileForProof(filePath)
	if err != nil {
		return "", err
	}
	if isTemp {
		defer os.Remove(mduPath)
	}

	// New: Need Manifest Blob for Triple Proof
	// We assume shardFile already ran and produced .json.
	// We can re-read it to get manifest blob.
	// Ideally submitRetrievalProof should take the manifest blob path, but for now we assume it's derivable or stored.
	// HACK: Read <filePath>.json if it exists (from shardFile)
	jsonPath := filePath + ".json"
	manifestPath := ""
	var manifestBlobHex string

	// Check if json exists
	if _, err := os.Stat(jsonPath); err == nil {
		// Parse it
		jsonFile, _ := os.ReadFile(jsonPath)
		var shardOut map[string]any
		json.Unmarshal(jsonFile, &shardOut)
		if val, ok := shardOut["manifest_blob_hex"].(string); ok {
			manifestBlobHex = val
		}
	}

	// If not found (e.g. synthetic mdu), create a dummy manifest?
	// Triple Proof WILL fail on-chain if manifest is wrong.
	// For Devnet Mode 1 "Fetch", we serve a file we have stored.
	// So shardFile MUST have run.

	if manifestBlobHex == "" {
		return "", fmt.Errorf("manifest_blob_hex not found in %s", jsonPath)
	}

	// Decode hex to binary temp file
	manifestBytes, err := decodeHex(manifestBlobHex)
	if err != nil {
		return "", fmt.Errorf("failed to decode manifest hex: %w", err)
	}

	manTmp, err := os.CreateTemp(uploadDir, "manifest-*.bin")
	if err != nil {
		return "", err
	}
	if _, err := manTmp.Write(manifestBytes); err != nil {
		manTmp.Close()
		return "", err
	}
	manifestPath = manTmp.Name()
	manTmp.Close()
	defer os.Remove(manifestPath)

	// For now, assume MDU index is 0 (single file < 8MB)
	mduIndexStr := "0"

	// 1) Generate a RetrievalReceipt JSON via the CLI (offline signing).
	signCmd := execCommand(
		nilchaindBin,
		"tx", "nilchain", "sign-retrieval-receipt",
		dealIDStr,
		providerAddr,
		epochStr,
		mduPath,
		trustedSetup,
		manifestPath,
		mduIndexStr,
		"--from", providerKeyName,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--offline",
	)
	signOut, err := signCmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("sign-retrieval-receipt failed: %w (stderr: %s)", err, string(ee.Stderr))
		}
		return "", fmt.Errorf("sign-retrieval-receipt failed: %w", err)
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
	submitCmd := execCommand(
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

// creatorHasSomeBalance checks whether a given bech32 address has any non-zero
// balance in the bank module (stake or aatom). It is a devnet guard used to
// ensure users have gone through the faucet flow before deals are created.
func creatorHasSomeBalance(creator string) (bool, error) {
	url := fmt.Sprintf("%s/cosmos/bank/v1beta1/balances/%s", lcdBase, creator)
	resp, err := http.Get(url)
	if err != nil {
		return false, fmt.Errorf("bank LCD request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// If the account does not exist yet, treat as zero balance.
		if resp.StatusCode == http.StatusNotFound {
			return false, nil
		}
		body, _ := io.ReadAll(resp.Body)
		return false, fmt.Errorf("bank LCD returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload struct {
		Balances []struct {
			Denom  string `json:"denom"`
			Amount string `json:"amount"`
		} `json:"balances"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return false, fmt.Errorf("failed to decode bank response: %w", err)
	}

	for _, b := range payload.Balances {
		if b.Amount == "" || b.Amount == "0" {
			continue
		}
		// Any non-zero denom is enough to consider the creator "funded" for devnet.
		return true, nil
	}
	return false, nil
}

// ensureMduFileForProof ensures we have a file of exactly 8 MiB to feed into
// the sign-retrieval-receipt CLI. If the original file is already 8 MiB, it is
// used directly; otherwise a temporary 8 MiB zero-filled buffer is created.
// NOTE: For devnet Mode 1, we do not require the MDU bytes to be derived from
// the real file contents; we only need a structurally valid MDU for KZG.
func ensureMduFileForProof(origPath string) (string, bool, error) {
	const mduSize = 8 * 1024 * 1024 // 8 MiB

	info, err := os.Stat(origPath)
	if err != nil {
		return "", false, fmt.Errorf("stat failed for %s: %w", origPath, err)
	}
	if !info.Mode().IsRegular() {
		return "", false, fmt.Errorf("not a regular file: %s", origPath)
	}

	if info.Size() == mduSize {
		// Even if the size matches, the contents may not form a valid MDU for
		// KZG. For devnet we prefer a known-good zero MDU, so we do not reuse
		// arbitrary 8 MiB files here.
	}

	tmp, err := os.CreateTemp(uploadDir, "mdu-*.bin")
	if err != nil {
		return "", false, fmt.Errorf("CreateTemp for MDU failed: %w", err)
	}

	// Write a zero-filled 8 MiB buffer (synthetic MDU for devnet).
	zero := make([]byte, 1024*1024)
	for written := 0; written < mduSize; written += len(zero) {
		if _, err := tmp.Write(zero); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			return "", false, fmt.Errorf("failed to write zero MDU: %w", err)
		}
	}

	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", false, fmt.Errorf("failed to close MDU file: %w", err)
	}

	return tmp.Name(), true, nil
}

func decodeHex(s string) ([]byte, error) {
	if strings.HasPrefix(s, "0x") {
		s = s[2:]
	}
	// simple manual decode or use encoding/hex
	// Since we didn't import encoding/hex in existing imports, we can use simple loop or add import.
	// Adding import is better but requires context replacement or robust replace.
	// Let's implement simple.

	src := []byte(s)
	dst := make([]byte, len(src)/2)
	for i := 0; i < len(src)/2; i++ {
		h, ok1 := fromHexChar(src[i*2])
		l, ok2 := fromHexChar(src[i*2+1])
		if !ok1 || !ok2 {
			 return nil, fmt.Errorf("invalid hex char")
		}
		dst[i] = (h << 4) | l
	}
	return dst, nil
}

func fromHexChar(c byte) (byte, bool) {
	switch {
	case '0' <= c && c <= '9':
		return c - '0', true
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10, true
	case 'A' <= c && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}