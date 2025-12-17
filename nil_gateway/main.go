package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/btcsuite/btcutil/bech32"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/gorilla/mux"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

// Configurable paths & chain settings (overridable via env).
var (
	uploadDir       = envDefault("NIL_UPLOAD_DIR", "uploads")
	sessionDBPath   = envDefault("NIL_SESSION_DB_PATH", filepath.Join(uploadDir, "sessions.db"))
	providerBase    = envDefault("NIL_PROVIDER_BASE", "http://localhost:8080")
	nilCliPath      = envDefault("NIL_CLI_BIN", "../nil_cli/target/release/nil_cli")
	trustedSetup    = envDefault("NIL_TRUSTED_SETUP", "../nilchain/trusted_setup.txt")
	nilchaindBin    = envDefault("NILCHAIND_BIN", "nilchaind")
	chainID         = envDefault("NIL_CHAIN_ID", "test-1")
	nodeAddr        = envDefault("NIL_NODE", "tcp://127.0.0.1:26657")
	homeDir         = envDefault("NIL_HOME", "../_artifacts/nilchain_data")
	gasPrices       = envDefault("NIL_GAS_PRICES", "0.001aatom")
	defaultDuration = envDefault("NIL_DEFAULT_DURATION_BLOCKS", "1000")
	lcdBase         = envDefault("NIL_LCD_BASE", "http://localhost:1317")
	faucetBase      = envDefault("NIL_FAUCET_BASE", "http://localhost:8081")
	cmdTimeout      = time.Duration(envInt("NIL_CMD_TIMEOUT_SECONDS", 30)) * time.Second
	// Sharding (nil_cli shard) is intentionally CPU/memory heavy; allow a larger default timeout.
	shardTimeout = time.Duration(envInt("NIL_SHARD_TIMEOUT_SECONDS", 600)) * time.Second
	// End-to-end upload ingest timeout (covers user sharding + witness + MDU #0 + aggregate).
	// This is enforced per request so clients never see an infinite hang.
	uploadIngestTimeout = time.Duration(envInt("NIL_GATEWAY_UPLOAD_TIMEOUT_SECONDS", envInt("NIL_UPLOAD_INGEST_TIMEOUT_SECONDS", 60))) * time.Second
	// Default to full KZG/MDU pipeline for correctness; fast shard mode is a local-only optimization.
	fastShardMode = envDefault("NIL_FAST_SHARD", "0") == "1"
	// Devnet UX: allow unsigned range fetches (MetaMask-only txs) by default.
	// When enabled, clients must provide EIP-712 request headers and the gateway
	// enforces them before serving byte ranges.
	requireRetrievalReqSig = envDefault("NIL_REQUIRE_RETRIEVAL_REQ_SIG", "0") == "1"

	execCommandContext = exec.CommandContext
	mockCombinedOutput func(ctx context.Context, name string, args ...string) ([]byte, error)
)

// runCommand executes an external command, respecting mockCombinedOutput if set.
func runCommand(ctx context.Context, name string, args []string, dir string) ([]byte, error) {
	if mockCombinedOutput != nil {
		return mockCombinedOutput(ctx, name, args...)
	}
	cmd := execCommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	return cmd.CombinedOutput()
}

// Simple txhash extractor, shared with faucet-style flows.
var txHashRe = regexp.MustCompile(`txhash:\s*([A-Fa-f0-9]+)`)
var nilAddrRe = regexp.MustCompile(`\bnil1[0-9a-z]{20,}\b`)

var lcdHTTPClient = &http.Client{Timeout: 5 * time.Second}

// extractJSONBody attempts to locate the first JSON object in a mixed CLI output.
func extractJSONBody(b []byte) []byte {
	start := bytes.IndexByte(b, '{')
	end := bytes.LastIndexByte(b, '}')
	if start == -1 || end == -1 || end <= start {
		return nil
	}
	return b[start : end+1]
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

type txAttribute struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type txEvent struct {
	Type       string        `json:"type"`
	Attributes []txAttribute `json:"attributes"`
}

type txLog struct {
	Events []txEvent `json:"events"`
}

type txBroadcastResponse struct {
	Code      uint32 `json:"code"`
	Codespace string `json:"codespace"`
	RawLog    string `json:"raw_log"`
	TxHash    string `json:"txhash"`
}

func extractDealID(logs []txLog, events []txEvent) string {
	find := func(evts []txEvent) string {
		for _, evt := range evts {
			if evt.Type != "nilchain.nilchain.EventCreateDeal" && evt.Type != "create_deal" {
				continue
			}
			for _, attr := range evt.Attributes {
				if attr.Key == "id" || attr.Key == "deal_id" {
					return attr.Value
				}
			}
		}
		return ""
	}

	for _, l := range logs {
		if id := find(l.Events); id != "" {
			return id
		}
	}
	return find(events)
}

func evmHexToNilAddress(hexAddr string) (string, error) {
	trimmed := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(hexAddr)), "0x")
	raw, err := hex.DecodeString(trimmed)
	if err != nil {
		return "", err
	}
	if len(raw) != 20 {
		return "", fmt.Errorf("invalid EVM address length: %d", len(raw))
	}
	converted, err := bech32.ConvertBits(raw, 8, 5, true)
	if err != nil {
		return "", err
	}
	return bech32.Encode("nil", converted)
}

func fundAddressOnce(addr string) {
	client := &http.Client{Timeout: 5 * time.Second}
	body := fmt.Sprintf(`{"address":"%s"}`, addr)
	req, _ := http.NewRequest("POST", fmt.Sprintf("%s/faucet", faucetBase), strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("fundAddressOnce: faucet request failed: %v", err)
		return
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("fundAddressOnce: faucet returned status %d", resp.StatusCode)
	}
}

// deriveNilchaindDir attempts to find a working directory where nilchaind
// can locate its trusted setup file via the default relative path
// "nilchain/trusted_setup.txt". This keeps gateway CLI calls reliable even when
// the gateway runs from a subdirectory.
func deriveNilchaindDir() string {
	if root := os.Getenv("NIL_ROOT_DIR"); root != "" {
		return root
	}

	if homeDir != "" {
		dir := homeDir
		if abs, err := filepath.Abs(homeDir); err == nil {
			dir = abs
		}
		for i := 0; i < 6; i++ {
			if _, err := os.Stat(filepath.Join(dir, "nilchain", "trusted_setup.txt")); err == nil {
				return dir
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}

	if wd, err := os.Getwd(); err == nil {
		dir := wd
		for i := 0; i < 6; i++ {
			if _, err := os.Stat(filepath.Join(dir, "nilchain", "trusted_setup.txt")); err == nil {
				return dir
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}

	return ""
}



// execNilchaind runs a nilchaind command and returns its combined output.
func execNilchaind(ctx context.Context, args ...string) ([]byte, error) {
	args = maybeWithNodeArg(args)
	return runCommand(ctx, nilchaindBin, args, deriveNilchaindDir())
}

func maybeWithNodeArg(args []string) []string {
	if strings.TrimSpace(nodeAddr) == "" || len(args) == 0 {
		return args
	}
	// Only attach for tx/query subcommands.
	if args[0] != "tx" && args[0] != "query" {
		return args
	}
	for i := 0; i < len(args); i++ {
		if args[i] == "--node" {
			return args
		}
	}
	return append(args, "--node", nodeAddr)
}

// execNilCli runs a nil_cli command and returns its combined output.
func execNilCli(ctx context.Context, args ...string) ([]byte, error) {
	return runCommand(ctx, nilCliPath, args, "")
}

func runTxWithRetry(ctx context.Context, args ...string) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	maxRetries := 5
	var out []byte
	var err error

	for i := 0; i < maxRetries; i++ {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		attemptCtx, cancel := context.WithTimeout(ctx, cmdTimeout)
		var cmdOut []byte
		var cmdErr error
		cmdOut, cmdErr = execNilchaind(attemptCtx, args...) // Use the new execNilchaind
		cancel()
		out = cmdOut
		err = cmdErr
		outStr := string(out)

		if errors.Is(attemptCtx.Err(), context.DeadlineExceeded) {
			return out, fmt.Errorf("nilchaind command timed out after %s", cmdTimeout)
		}

		if err != nil {
			if strings.Contains(outStr, "account sequence mismatch") {
				log.Printf("runTxWithRetry: account sequence mismatch (CLI error, attempt %d/%d), retrying...", i+1, maxRetries)
				time.Sleep(1 * time.Second)
				continue
			}
			return out, err
		}

		if strings.Contains(outStr, "account sequence mismatch") {
			log.Printf("runTxWithRetry: account sequence mismatch (CheckTx error, attempt %d/%d), retrying...", i+1, maxRetries)
			time.Sleep(1 * time.Second)
			continue
		}

		return out, nil
	}
	return out, err
}

func main() {
	routerMode := isGatewayRouterMode()

	// Ensure upload dir
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatalf("failed to create upload dir %s: %v", uploadDir, err)
	}

	if !routerMode {
		if err := initSessionDB(sessionDBPath); err != nil {
			log.Fatalf("failed to open session db %s: %v", sessionDBPath, err)
		}

		// Initialize KZG (load trusted setup once)
		log.Printf("Initializing KZG from %s...", trustedSetup)
		if err := crypto_ffi.Init(trustedSetup); err != nil {
			log.Fatalf("Failed to initialize KZG: %v. Check path.", err)
		}

		// Best-effort warmups to keep the first browser fetch fast.
		go func() {
			_ = cachedProviderAddress(context.Background())
		}()
	}

	r := mux.NewRouter()
	// Legacy S3-style interface
	r.HandleFunc("/api/v1/object/{key}", PutObject).Methods("PUT")
	r.HandleFunc("/api/v1/object/{key}", GetObject).Methods("GET")

	// Gateway endpoints used by the web UI
	r.HandleFunc("/gateway/create-deal", GatewayCreateDeal).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/update-deal-content", GatewayUpdateDealContent).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/create-deal-evm", GatewayCreateDealFromEvm).Methods("POST", "OPTIONS")
	r.HandleFunc("/gateway/update-deal-content-evm", GatewayUpdateDealContentFromEvm).Methods("POST", "OPTIONS")
	r.HandleFunc("/health", HealthCheck).Methods("GET", "OPTIONS")

	if routerMode {
		r.HandleFunc("/gateway/upload", RouterGatewayUpload).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/open-session/{cid}", RouterGatewayOpenSession).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/fetch/{cid}", RouterGatewayFetch).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/plan-retrieval-session/{cid}", RouterGatewayPlanRetrievalSession).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/list-files/{cid}", RouterGatewayListFiles).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/slab/{cid}", RouterGatewaySlab).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/manifest-info/{cid}", RouterGatewayManifestInfo).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/mdu-kzg/{cid}/{index}", RouterGatewayMduKzg).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/receipt", RouterGatewaySubmitReceipt).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/receipts", RouterGatewaySubmitReceipts).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/session-receipt", RouterGatewaySubmitSessionReceipt).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/session-proof", RouterGatewaySubmitRetrievalSessionProof).Methods("POST", "OPTIONS")
	} else {
		r.HandleFunc("/gateway/upload", GatewayUpload).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/open-session/{cid}", GatewayOpenSession).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/fetch/{cid}", GatewayFetch).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/plan-retrieval-session/{cid}", GatewayPlanRetrievalSession).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/list-files/{cid}", GatewayListFiles).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/slab/{cid}", GatewaySlab).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/manifest-info/{cid}", GatewayManifestInfo).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/mdu-kzg/{cid}/{index}", GatewayMduKzg).Methods("GET", "OPTIONS")
		r.HandleFunc("/gateway/prove-retrieval", GatewayProveRetrieval).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/receipt", GatewaySubmitReceipt).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/receipts", GatewaySubmitReceipts).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/session-receipt", GatewaySubmitSessionReceipt).Methods("POST", "OPTIONS")
		r.HandleFunc("/gateway/session-proof", GatewaySubmitRetrievalSessionProof).Methods("POST", "OPTIONS")
		r.HandleFunc("/sp/receipt", SpSubmitReceipt).Methods("POST", "OPTIONS")
		r.HandleFunc("/sp/receipts", SpSubmitReceipts).Methods("POST", "OPTIONS")
		r.HandleFunc("/sp/session-receipt", SpSubmitSessionReceipt).Methods("POST", "OPTIONS")
		r.HandleFunc("/sp/session-proof", SpSubmitRetrievalSessionProof).Methods("POST", "OPTIONS")
	}

	listenAddr := envDefault("NIL_LISTEN_ADDR", ":8080")
	log.Printf("Starting NilStore Gateway/S3 Adapter on %s", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, r))
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
	out, err := shardFile(r.Context(), path, false, "")
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

	ingestCtx, cancel := context.WithTimeout(r.Context(), uploadIngestTimeout)
	defer cancel()
	if ingestCtx.Err() != nil {
		http.Error(w, "request canceled", http.StatusRequestTimeout)
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
	var fileSize uint64
	var allocatedLength uint64

	// Canonical NilFS ingest by default (MDU #0 + Witness + User MDUs + ManifestRoot).
	// Legacy/fake modes are only enabled behind explicit env flags:
	// - NIL_FAKE_INGEST=1: fast SHA256-based manifest_root (dev only, not Triple-Proof valid)
	// - NIL_FAST_INGEST=1: skip witness generation (faster, still not Triple-Proof valid)
	maxMdus := uint64(256) // Default ~2 GiB to keep local runs fast
	if raw := strings.TrimSpace(r.FormValue("max_user_mdus")); raw != "" {
		if parsed, err := strconv.ParseUint(raw, 10, 64); err == nil && parsed > 0 {
			maxMdus = parsed
		}
	}

	if strings.TrimSpace(dealIDStr) != "" {
		dealID, err := strconv.ParseUint(strings.TrimSpace(dealIDStr), 10, 64)
		if err != nil {
			http.Error(w, "invalid deal_id", http.StatusBadRequest)
			return
		}

		chainOwner, chainCID, err := fetchDealOwnerAndCID(dealID)
		if err != nil {
			log.Printf("GatewayUpload: failed to fetch deal %d: %v", dealID, err)
			http.Error(w, "failed to fetch deal state", http.StatusInternalServerError)
			return
		}
		if owner != "" && chainOwner != "" && owner != chainOwner {
			http.Error(w, "forbidden: owner does not match deal", http.StatusForbidden)
			return
		}

		if chainCID == "" {
			// First upload for a thin-provisioned deal: stage a fresh NilFS slab on the
			// assigned provider before the first content commit.
			switch {
			case os.Getenv("NIL_FAKE_INGEST") == "1":
				var err error
				cid, size, allocatedLength, err = fastShardQuick(path)
				if err != nil {
					http.Error(w, fmt.Sprintf("fast shard failed: %v", err), http.StatusInternalServerError)
					return
				}
				fileSize = size

			case os.Getenv("NIL_FAST_INGEST") == "1":
				b, manifestRoot, allocLen, err := IngestNewDealFast(ingestCtx, path, maxMdus)
				if err != nil {
					if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
						http.Error(w, err.Error(), http.StatusRequestTimeout)
						return
					}
					http.Error(w, fmt.Sprintf("IngestNewDealFast failed: %v", err), http.StatusInternalServerError)
					return
				}
				cid = manifestRoot
				allocatedLength = allocLen
				if info, err := os.Stat(path); err == nil {
					fileSize = uint64(info.Size())
				}
				if b != nil {
					size = totalSizeBytesFromMdu0(b)
				}

			default:
				b, manifestRoot, allocLen, err := IngestNewDeal(ingestCtx, path, maxMdus)
				if err != nil {
					if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
						http.Error(w, err.Error(), http.StatusRequestTimeout)
						return
					}
					http.Error(w, fmt.Sprintf("IngestNewDeal failed: %v", err), http.StatusInternalServerError)
					return
				}
				cid = manifestRoot
				allocatedLength = allocLen
				if info, err := os.Stat(path); err == nil {
					fileSize = uint64(info.Size())
				}
				if b != nil {
					size = totalSizeBytesFromMdu0(b)
				}
			}
		} else {
			// Append path: load existing slab by on-chain manifest root, then append.
			if os.Getenv("NIL_FAKE_INGEST") == "1" || os.Getenv("NIL_FAST_INGEST") == "1" {
				http.Error(w, "append is only supported in canonical ingest mode", http.StatusBadRequest)
				return
			}

			b, manifestRoot, allocLen, err := IngestAppendToDeal(ingestCtx, path, chainCID, maxMdus)
			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					http.Error(w, err.Error(), http.StatusRequestTimeout)
					return
				}
				http.Error(w, fmt.Sprintf("IngestAppendToDeal failed: %v", err), http.StatusInternalServerError)
				return
			}
			cid = manifestRoot
			allocatedLength = allocLen
			if info, err := os.Stat(path); err == nil {
				fileSize = uint64(info.Size())
			}
			if b != nil {
				size = totalSizeBytesFromMdu0(b)
			}
		}
	} else {
		switch {
		case os.Getenv("NIL_FAKE_INGEST") == "1":
			// Very fast dev path: SHA256 padded to 48 bytes.
			var err error
			cid, size, allocatedLength, err = fastShardQuick(path)
			if err != nil {
				http.Error(w, fmt.Sprintf("fast shard failed: %v", err), http.StatusInternalServerError)
				return
			}
			fileSize = size

		case os.Getenv("NIL_FAST_INGEST") == "1":
			// Semi-canonical dev path: NilFS slab without Witness MDUs.
			b, manifestRoot, allocLen, err := IngestNewDealFast(ingestCtx, path, maxMdus)
			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					http.Error(w, err.Error(), http.StatusRequestTimeout)
					return
				}
				http.Error(w, fmt.Sprintf("IngestNewDealFast failed: %v", err), http.StatusInternalServerError)
				return
			}
			cid = manifestRoot
			allocatedLength = allocLen
			if info, err := os.Stat(path); err == nil {
				fileSize = uint64(info.Size())
			}
			if b != nil {
				size = totalSizeBytesFromMdu0(b)
			}

		default:
			// Full canonical ingest (Triple-Proof valid).
			b, manifestRoot, allocLen, err := IngestNewDeal(ingestCtx, path, maxMdus)
			if err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					http.Error(w, err.Error(), http.StatusRequestTimeout)
					return
				}
				http.Error(w, fmt.Sprintf("IngestNewDeal failed: %v", err), http.StatusInternalServerError)
				return
			}
			cid = manifestRoot
			allocatedLength = allocLen
			if info, err := os.Stat(path); err == nil {
				fileSize = uint64(info.Size())
			}
			if b != nil {
				size = totalSizeBytesFromMdu0(b)
			}
		}
	}

	// Backstop: preserve previous behavior if we could not compute a non-zero total size.
	if size == 0 {
		size = fileSize
	}

	resp := map[string]any{
		"cid":              cid,
		"manifest_root":    cid,
		"size_bytes":       size,
		"file_size_bytes":  fileSize,
		"allocated_length": allocatedLength,
		"filename":         header.Filename,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewayUpload encode error: %v", err)
	}
}

func totalSizeBytesFromMdu0(b *crypto_ffi.Mdu0Builder) uint64 {
	if b == nil {
		return 0
	}
	var total uint64
	count := b.GetRecordCount()
	for i := uint32(0); i < count; i++ {
		rec, err := b.GetRecord(i)
		if err != nil {
			continue
		}
		// Path[0]==0 marks a tombstone in NilFS V1.
		if rec.Path[0] == 0 {
			continue
		}
		length, _ := crypto_ffi.UnpackLengthAndFlags(rec.LengthAndFlags)
		total += length
	}
	return total
}

// GatewayCreateDeal accepts a spec-aligned payload and creates a deal on-chain.
// For now it signs using the faucet/system key, but the logical creator is
// included in the request for future user-signed flows.
type createDealRequest struct {
	Creator         string `json:"creator"`
	DurationBlocks  uint64 `json:"duration_blocks"`
	ServiceHint     string `json:"service_hint"`
	InitialEscrow   string `json:"initial_escrow"`
	MaxMonthlySpend string `json:"max_monthly_spend"`
}

type proveRetrievalRequest struct {
	DealID       *uint64 `json:"deal_id"`
	ManifestRoot string  `json:"manifest_root,omitempty"`
	Cid          string  `json:"cid,omitempty"`
	FilePath     string  `json:"file_path,omitempty"`
	Owner        string  `json:"owner,omitempty"`
	Epoch        uint64  `json:"epoch_id,omitempty"`
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
	if req.InitialEscrow == "" || req.MaxMonthlySpend == "" {
		http.Error(w, "missing fields", http.StatusBadRequest)
		return
	}

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
	out, err := runTxWithRetry(
		r.Context(),
		"tx", "nilchain", "create-deal",
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

	out, err := runTxWithRetry(
		r.Context(),
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

	// Light validation of the intent shape (creator_evm present).
	rawCreator, okCreator := req.Intent["creator_evm"].(string)
	if !okCreator || strings.TrimSpace(rawCreator) == "" {
		http.Error(w, "intent must include creator_evm", http.StatusBadRequest)
		return
	}
	if creatorNil, err := evmHexToNilAddress(rawCreator); err == nil {
		// Only hit the faucet if the creator has no on-chain balance.
		// This avoids bumping the faucet key sequence right before we submit
		// MsgCreateDealFromEvm (which also signs with faucet), preventing
		// avoidable account-sequence retries.
		if ok, berr := creatorHasSomeBalance(creatorNil); berr != nil {
			log.Printf("GatewayCreateDealFromEvm: balance check failed for %s: %v", creatorNil, berr)
		} else if !ok {
			fundAddressOnce(creatorNil)
		}
	}

	tmp, err := os.CreateTemp(uploadDir, "evm-deal-*.json")
	if err != nil {
		http.Error(w, "failed to create temp file", http.StatusInternalServerError)
		return
	}
	tmpPath := tmp.Name()
	if abs, err := filepath.Abs(tmpPath); err == nil {
		tmpPath = abs
	}

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

	out, err := runTxWithRetry(
		r.Context(),
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
		// CLI can emit prefix lines (warnings, broadcast summaries). Try to salvage the JSON body.
		body := extractJSONBody(out)
		if len(body) == 0 || json.Unmarshal(body, &txRes) != nil {
			log.Printf("GatewayCreateDealFromEvm failed to parse JSON: %v. Output: %s", err, string(out))
			http.Error(w, "failed to parse tx response", http.StatusInternalServerError)
			return
		}
	}

	if txRes.Code != 0 {
		log.Printf("GatewayCreateDealFromEvm tx failed with code %d: %s", txRes.Code, txRes.RawLog)
		http.Error(w, fmt.Sprintf("tx failed: %s", txRes.RawLog), http.StatusInternalServerError)
		return
	}

	txHash := txRes.TxHash
	log.Printf("GatewayCreateDealFromEvm sent: txhash=%s. Polling for inclusion...", txHash)

	var dealID string
	client := &http.Client{Timeout: 2 * time.Second}
	// Poll for tx inclusion (max 10 seconds)
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)

		req, _ := http.NewRequest("GET", fmt.Sprintf("%s/cosmos/tx/v1beta1/txs/%s", lcdBase, txHash), nil)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			log.Printf("GatewayCreateDealFromEvm: LCD returned status %d for tx %s", resp.StatusCode, txHash)
			continue
		}

		var txResp struct {
			TxResponse struct {
				TxHash string    `json:"txhash"`
				Code   uint32    `json:"code"`
				RawLog string    `json:"raw_log"`
				Logs   []txLog   `json:"logs"`
				Events []txEvent `json:"events"`
			} `json:"tx_response"`
		}
		if err := json.Unmarshal(body, &txResp); err != nil {
			log.Printf("GatewayCreateDealFromEvm: failed to parse LCD tx response: %v", err)
			continue
		}
		if txResp.TxResponse.Code != 0 {
			http.Error(w, fmt.Sprintf("tx failed: %s", txResp.TxResponse.RawLog), http.StatusInternalServerError)
			return
		}

		dealID = extractDealID(txResp.TxResponse.Logs, txResp.TxResponse.Events)
		if dealID != "" {
			break
		}
	}

	if dealID == "" {
		// Fallback: query the chain for the latest deal and assume it belongs to this tx.
		log.Printf("deal_id not found in tx events; falling back to list-deals. TxHash: %s", txHash)
		fallbackCtx, cancel := context.WithTimeout(r.Context(), cmdTimeout)
		defer cancel()
		listOut, _ := execNilchaind(
			fallbackCtx,
			"query", "nilchain", "list-deals",
			"--home", homeDir,
			"--output", "json",
		)
		var listRes struct {
			Deals []struct {
				Id uint64 `json:"id"`
			} `json:"deals"`
		}
		if err := json.Unmarshal(listOut, &listRes); err == nil && len(listRes.Deals) > 0 {
			var max uint64
			for _, d := range listRes.Deals {
				if d.Id > max {
					max = d.Id
				}
			}
			if max > 0 {
				dealID = fmt.Sprintf("%d", max)
				log.Printf("Fallback deal_id resolved to %s from list-deals", dealID)
			}
		}
		if dealID == "" {
			http.Error(w, "deal creation failed: deal_id not found", http.StatusInternalServerError)
			return
		}
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
	if abs, err := filepath.Abs(tmpPath); err == nil {
		tmpPath = abs
	}

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

	out, err := runTxWithRetry(
		r.Context(),
		"tx", "nilchain", "update-deal-content-from-evm",
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

	if err != nil {
		log.Printf("GatewayUpdateDealContentFromEvm failed (CLI error): %s", string(out))
		http.Error(w, fmt.Sprintf("tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	var txRes struct {
		TxHash string `json:"txhash"`
		Code   int    `json:"code"`
		RawLog string `json:"raw_log"`
	}
	if err := json.Unmarshal(out, &txRes); err != nil {
		body := extractJSONBody(out)
		if len(body) == 0 || json.Unmarshal(body, &txRes) != nil {
			log.Printf("GatewayUpdateDealContentFromEvm failed to parse JSON: %v. Output: %s", err, string(out))
			http.Error(w, "failed to parse tx response", http.StatusInternalServerError)
			return
		}
	}
	if txRes.Code != 0 {
		log.Printf("GatewayUpdateDealContentFromEvm tx failed with code %d: %s", txRes.Code, txRes.RawLog)
		http.Error(w, fmt.Sprintf("tx failed (checkTx): %s", txRes.RawLog), http.StatusInternalServerError)
		return
	}

	txHash := txRes.TxHash
	log.Printf("GatewayUpdateDealContentFromEvm sent: txhash=%s. Polling for inclusion...", txHash)

	// Poll LCD for final tx result so we can surface DeliverTx errors (e.g. unauthorized)
	client := &http.Client{Timeout: 2 * time.Second}
	confirmed := false
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)

		reqLCD, _ := http.NewRequest("GET", fmt.Sprintf("%s/cosmos/tx/v1beta1/txs/%s", lcdBase, txHash), nil)
		resp, err := client.Do(reqLCD)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			log.Printf("GatewayUpdateDealContentFromEvm: LCD returned status %d for tx %s", resp.StatusCode, txHash)
			continue
		}

		var txResp struct {
			TxResponse struct {
				Code   uint32 `json:"code"`
				RawLog string `json:"raw_log"`
			} `json:"tx_response"`
		}
		if err := json.Unmarshal(body, &txResp); err != nil {
			log.Printf("GatewayUpdateDealContentFromEvm: failed to parse LCD tx response: %v", err)
			continue
		}
		if txResp.TxResponse.Code != 0 {
			log.Printf("GatewayUpdateDealContentFromEvm DeliverTx failed with code %d: %s", txResp.TxResponse.Code, txResp.TxResponse.RawLog)
			http.Error(w, fmt.Sprintf("tx failed: %s", txResp.TxResponse.RawLog), http.StatusInternalServerError)
			return
		}

		confirmed = true
		break
	}

	if !confirmed {
		http.Error(w, "tx not confirmed on-chain within timeout window", http.StatusInternalServerError)
		return
	}

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
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "")
		return
	}
	if req.DealID == nil {
		writeJSONError(w, http.StatusBadRequest, "deal_id is required", "")
		return
	}

	rawManifestRoot := strings.TrimSpace(req.ManifestRoot)
	if rawManifestRoot == "" {
		rawManifestRoot = strings.TrimSpace(req.Cid)
	}
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root is required", "")
		return
	}

	manifestRoot, err := parseManifestRoot(rawManifestRoot)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid manifest_root", err.Error())
		return
	}

	dealID := *req.DealID
	filePath, err := validateNilfsFilePath(req.FilePath)
	if err != nil {
		writeJSONError(
			w,
			http.StatusBadRequest,
			"invalid file_path",
			fmt.Sprintf("List files via GET /gateway/list-files/%s?deal_id=%d&owner=<deal_owner>", manifestRoot.Canonical, dealID),
		)
		return
	}

	epoch := req.Epoch
	if epoch == 0 {
		epoch = 1
	}

	dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeJSONError(w, http.StatusNotFound, "deal not found", "")
			return
		}
		log.Printf("GatewayProveRetrieval: failed to fetch deal %d: %v", dealID, err)
		writeJSONError(w, http.StatusInternalServerError, "failed to validate deal", "")
		return
	}
	if owner := strings.TrimSpace(req.Owner); owner != "" && dealOwner != owner {
		writeJSONError(w, http.StatusForbidden, "forbidden: owner does not match deal", "")
		return
	}
	if strings.TrimSpace(dealCID) == "" {
		writeJSONError(
			w,
			http.StatusConflict,
			"deal has no committed manifest_root yet",
			"Commit content via /gateway/update-deal-content-evm (or update-deal-content) first",
		)
		return
	}
	chainRoot, err := parseManifestRoot(dealCID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "invalid on-chain manifest_root", err.Error())
		return
	}
	if chainRoot.Canonical != manifestRoot.Canonical {
		writeJSONError(
			w,
			http.StatusConflict,
			"stale manifest_root (does not match on-chain deal state)",
			fmt.Sprintf("Query the deal and retry with manifest_root=%s", chainRoot.Canonical),
		)
		return
	}

	dealDir, err := resolveDealDir(manifestRoot, rawManifestRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	mduIdx, mduPath, _, err := GetFileLocation(dealDir, filePath)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(
				w,
				http.StatusNotFound,
				"file not found in deal",
				fmt.Sprintf("List files via GET /gateway/list-files/%s?deal_id=%d&owner=%s", manifestRoot.Canonical, dealID, dealOwner),
			)
			return
		}
		log.Printf("GatewayProveRetrieval: GetFileLocation failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve file", "")
		return
	}

	manifestPath := filepath.Join(dealDir, "manifest.bin")
	if _, err := os.Stat(manifestPath); err != nil {
		if os.IsNotExist(err) {
			writeJSONError(
				w,
				http.StatusConflict,
				"manifest blob missing on disk",
				"Re-upload or run the gateway in full ingest mode (not NIL_FAST_INGEST)",
			)
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to read manifest blob", err.Error())
		return
	}

	txHash, err := submitRetrievalProofNew(r.Context(), dealID, epoch, mduIdx, mduPath, manifestPath)
	if err != nil {
		log.Printf("GatewayProveRetrieval: submitRetrievalProof failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to submit retrieval proof", "check nilchaind logs")
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

// GatewayOpenSession creates a server-side download session for a (deal_id, file_path) using a
// user-signed RetrievalRequest. Subsequent chunk fetches can reference the returned
// download_session without additional wallet signatures.
func GatewayOpenSession(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRootFromPath := false
	var manifestRoot ManifestRoot
	if parsed, err := parseManifestRoot(rawManifestRoot); err == nil {
		manifestRootFromPath = true
		manifestRoot = parsed
	}

	q := r.URL.Query()
	dealIDStr := strings.TrimSpace(q.Get("deal_id"))
	owner := strings.TrimSpace(q.Get("owner"))
	filePath, err := validateNilfsFilePath(q.Get("file_path"))
	reqSig := strings.TrimSpace(r.Header.Get("X-Nil-Req-Sig"))
	if reqSig == "" {
		reqSig = strings.TrimSpace(q.Get("req_sig"))
	}
	reqNonceStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Nonce"))
	if reqNonceStr == "" {
		reqNonceStr = strings.TrimSpace(q.Get("req_nonce"))
	}
	reqExpiresStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Expires-At"))
	if reqExpiresStr == "" {
		reqExpiresStr = strings.TrimSpace(q.Get("req_expires_at"))
	}
	reqRangeStartStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Range-Start"))
	if reqRangeStartStr == "" {
		reqRangeStartStr = strings.TrimSpace(q.Get("req_range_start"))
	}
	reqRangeLenStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Range-Len"))
	if reqRangeLenStr == "" {
		reqRangeLenStr = strings.TrimSpace(q.Get("req_range_len"))
	}

	if dealIDStr == "" || owner == "" {
		writeJSONError(w, http.StatusBadRequest, "deal_id and owner query parameters are required", "")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid file_path", err.Error())
		return
	}

	dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid deal_id", "")
		return
	}
	var reqNonce uint64
	var reqExpiresAt uint64
	var reqRangeStart uint64
	var reqRangeLen uint64
	if requireRetrievalReqSig {
		if strings.TrimSpace(reqSig) == "" {
			writeJSONError(w, http.StatusBadRequest, "req_sig is required", "")
			return
		}
		reqNonce, err = strconv.ParseUint(reqNonceStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_nonce", "")
			return
		}
		reqExpiresAt, err = strconv.ParseUint(reqExpiresStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_expires_at", "")
			return
		}
		reqRangeStart, err = strconv.ParseUint(reqRangeStartStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_range_start", "")
			return
		}
		reqRangeLen, err = strconv.ParseUint(reqRangeLenStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_range_len", "")
			return
		}
	} else {
		// Best-effort parse optional range hints for logging/session metadata only.
		if strings.TrimSpace(reqRangeStartStr) != "" {
			if v, perr := strconv.ParseUint(reqRangeStartStr, 10, 64); perr == nil {
				reqRangeStart = v
			}
		}
		if strings.TrimSpace(reqRangeLenStr) != "" {
			if v, perr := strconv.ParseUint(reqRangeLenStr, 10, 64); perr == nil {
				reqRangeLen = v
			}
		}
	}

	// Guard: ensure the caller's owner matches the on-chain Deal owner.
	dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeJSONError(w, http.StatusNotFound, "deal not found", "")
			return
		}
		log.Printf("GatewayOpenSession: failed to fetch deal %d: %v", dealID, err)
		writeJSONError(w, http.StatusInternalServerError, "failed to validate deal owner", "")
		return
	}
	if dealOwner == "" || dealOwner != owner {
		writeJSONError(w, http.StatusForbidden, "forbidden: owner does not match deal", "")
		return
	}

	// Guard: ensure the caller has an EIP-712 signature authorizing this session (if enabled).
	if requireRetrievalReqSig {
		if err := verifyRetrievalRequestSignature(dealOwner, dealID, filePath, reqRangeStart, reqRangeLen, reqNonce, reqExpiresAt, reqSig); err != nil {
			writeJSONError(w, http.StatusForbidden, "forbidden: invalid retrieval request signature", err.Error())
			return
		}
	}

	if strings.TrimSpace(dealCID) == "" {
		writeJSONError(
			w,
			http.StatusConflict,
			"deal has no committed manifest_root yet",
			"Commit content via /gateway/update-deal-content-evm (or update-deal-content) first",
		)
		return
	}
	dealRoot, err := parseManifestRoot(dealCID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "invalid on-chain manifest_root", err.Error())
		return
	}
	if manifestRootFromPath && dealRoot.Canonical != manifestRoot.Canonical {
		writeJSONError(
			w,
			http.StatusConflict,
			"stale manifest_root (does not match on-chain deal state)",
			fmt.Sprintf("Query the deal and retry with manifest_root=%s", dealRoot.Canonical),
		)
		return
	}
	rawManifestRoot = dealRoot.Canonical
	manifestRoot = dealRoot

	dealDir, err := resolveDealDir(manifestRoot, rawManifestRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	entry, err := loadSlabIndex(dealDir)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to load slab index", err.Error())
		return
	}
	if _, ok := entry.files[filePath]; !ok {
		writeJSONError(w, http.StatusNotFound, "file not found in deal", "")
		return
	}

	providerAddr := cachedProviderAddress(r.Context())
	if strings.TrimSpace(providerAddr) == "" {
		writeJSONError(w, http.StatusInternalServerError, "provider address unavailable", "set NIL_PROVIDER_ADDRESS or NIL_PROVIDER_KEY to a valid local key")
		return
	}

	// Anti-replay: only consume the request nonce once we've fully validated the deal state.
	if err := checkAndStoreRequestReplay(dealID, owner, reqNonce, reqExpiresAt); err != nil {
		writeJSONError(w, http.StatusConflict, "replay rejected", err.Error())
		return
	}

	sessionExpires := time.Unix(int64(reqExpiresAt), 0)
	downloadID, err := storeDownloadSession(downloadSession{
		DealID:     dealID,
		EpochID:    1,
		Owner:      owner,
		Provider:   providerAddr,
		FilePath:   filePath,
		RangeStart: reqRangeStart,
		RangeLen:   reqRangeLen,
		ExpiresAt:  sessionExpires,
		CreatedAt:  time.Now(),
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create download session", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"download_session": downloadID,
		"deal_id":          dealID,
		"epoch_id":         1,
		"provider":         providerAddr,
		"file_path":        filePath,
		"expires_at":       uint64(sessionExpires.Unix()),
	})
}

// GatewayFetch serves back a stored file by its manifest root, resolving the NilFS file_path.
//
// Retrieval is interactive: the gateway returns enough metadata for the client to sign a receipt,
// and records a short-lived session so the provider can later submit MsgProveLiveness.
//
// Modes:
//   - Per-chunk receipts: validates a signed RetrievalRequest (req_sig), creates a one-time fetch_session,
//     and returns `X-Nil-Fetch-Session` for receipt submission.
//   - Bundled download sessions: accepts a `download_session` created by GatewayOpenSession and records
//     chunk proofs server-side; the client later submits a single DownloadSessionReceipt.
func GatewayFetch(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	startTotal := time.Now()

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRootFromPath := false
	var manifestRoot ManifestRoot
	if parsed, err := parseManifestRoot(rawManifestRoot); err == nil {
		manifestRootFromPath = true
		manifestRoot = parsed
	}

	q := r.URL.Query()
	dealIDStr := strings.TrimSpace(q.Get("deal_id"))
	owner := strings.TrimSpace(q.Get("owner"))
	filePath, err := validateNilfsFilePath(q.Get("file_path"))
	reqSig := strings.TrimSpace(r.Header.Get("X-Nil-Req-Sig"))
	if reqSig == "" {
		reqSig = strings.TrimSpace(q.Get("req_sig"))
	}
	reqNonceStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Nonce"))
	if reqNonceStr == "" {
		reqNonceStr = strings.TrimSpace(q.Get("req_nonce"))
	}
	reqExpiresStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Expires-At"))
	if reqExpiresStr == "" {
		reqExpiresStr = strings.TrimSpace(q.Get("req_expires_at"))
	}
	reqRangeStartStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Range-Start"))
	if reqRangeStartStr == "" {
		reqRangeStartStr = strings.TrimSpace(q.Get("req_range_start"))
	}
	reqRangeLenStr := strings.TrimSpace(r.Header.Get("X-Nil-Req-Range-Len"))
	if reqRangeLenStr == "" {
		reqRangeLenStr = strings.TrimSpace(q.Get("req_range_len"))
	}

	onchainSessionID := strings.TrimSpace(r.Header.Get("X-Nil-Session-Id"))
	downloadSessionID := strings.TrimSpace(r.Header.Get("X-Nil-Download-Session"))
	if downloadSessionID == "" {
		downloadSessionID = strings.TrimSpace(q.Get("download_session"))
	}
	isOnchainSession := onchainSessionID != ""
	if isOnchainSession {
		downloadSessionID = onchainSessionID
	}
	isDownloadSession := downloadSessionID != ""
	if dealIDStr == "" || owner == "" {
		writeJSONError(w, http.StatusBadRequest, "deal_id and owner query parameters are required", "")
		return
	}
	if err != nil {
		writeJSONError(
			w,
			http.StatusBadRequest,
			"invalid file_path",
			"List files via GET /gateway/list-files/<manifest_root>?deal_id=<id>&owner=<owner>",
		)
		return
	}

	dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid deal_id", "")
		return
	}

	var reqNonce uint64
	var reqExpiresAt uint64
	var reqRangeStart uint64
	var reqRangeLen uint64
	if !isDownloadSession && requireRetrievalReqSig {
		reqNonce, err = strconv.ParseUint(reqNonceStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_nonce", "")
			return
		}
		reqExpiresAt, err = strconv.ParseUint(reqExpiresStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_expires_at", "")
			return
		}
		reqRangeStart, err = strconv.ParseUint(reqRangeStartStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_range_start", "")
			return
		}
		reqRangeLen, err = strconv.ParseUint(reqRangeLenStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid req_range_len", "")
			return
		}
		if reqRangeLen > uint64(types.BLOB_SIZE) {
			writeJSONError(w, http.StatusBadRequest, "range too large", fmt.Sprintf("req_range_len must be <= %d", types.BLOB_SIZE))
			return
		}
	}

	// 1) Guard: ensure the caller's owner matches the on-chain Deal owner.
	dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeJSONError(w, http.StatusNotFound, "deal not found", "")
			return
		}
		log.Printf("GatewayFetch: failed to fetch deal %d: %v", dealID, err)
		writeJSONError(w, http.StatusInternalServerError, "failed to validate deal owner", "")
		return
	}
	if dealOwner == "" || dealOwner != owner {
		writeJSONError(w, http.StatusForbidden, "forbidden: owner does not match deal", "")
		return
	}

	// 1b) Guard: ensure the caller has an EIP-712 signature authorizing this fetch.
	// For download sessions, this check is done once in GatewayOpenSession.
	if !isDownloadSession && requireRetrievalReqSig {
		if err := verifyRetrievalRequestSignature(dealOwner, dealID, filePath, reqRangeStart, reqRangeLen, reqNonce, reqExpiresAt, reqSig); err != nil {
			writeJSONError(w, http.StatusForbidden, "forbidden: invalid retrieval request signature", err.Error())
			return
		}
	}
	if strings.TrimSpace(dealCID) == "" {
		writeJSONError(
			w,
			http.StatusConflict,
			"deal has no committed manifest_root yet",
			"Commit content via /gateway/update-deal-content-evm (or update-deal-content) first",
		)
		return
	}
	dealRoot, err := parseManifestRoot(dealCID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "invalid on-chain manifest_root", err.Error())
		return
	}
	if manifestRootFromPath && dealRoot.Canonical != manifestRoot.Canonical {
		writeJSONError(
			w,
			http.StatusConflict,
			"stale manifest_root (does not match on-chain deal state)",
			fmt.Sprintf("Query the deal and retry with manifest_root=%s", dealRoot.Canonical),
		)
		return
	}
	rawManifestRoot = dealRoot.Canonical
	manifestRoot = dealRoot

	dealDir, err := resolveDealDir(manifestRoot, rawManifestRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	var dlSession downloadSession
	if isDownloadSession {
		if isOnchainSession {
			// Verify on-chain session state
			onchainSession, err := fetchRetrievalSession(onchainSessionID)
			if err != nil {
				if errors.Is(err, ErrSessionNotFound) {
					writeJSONError(w, http.StatusNotFound, "retrieval session not found on chain", "")
					return
				}
				writeJSONError(w, http.StatusInternalServerError, "failed to fetch retrieval session", err.Error())
				return
			}

			// Validation
			if onchainSession.DealId != dealID {
				writeJSONError(w, http.StatusBadRequest, "session deal_id mismatch", "")
				return
			}
			if onchainSession.Owner != owner {
				writeJSONError(w, http.StatusForbidden, "session owner mismatch", "")
				return
			}
			providerAddr := cachedProviderAddress(r.Context())
			if strings.TrimSpace(onchainSession.Provider) != strings.TrimSpace(providerAddr) {
				writeJSONError(w, http.StatusForbidden, "session provider mismatch", fmt.Sprintf("expected %s, got %s", onchainSession.Provider, providerAddr))
				return
			}
			if onchainSession.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN {
				writeJSONError(w, http.StatusConflict, "session not OPEN", fmt.Sprintf("status: %s", onchainSession.Status))
				return
			}
			// Note: We don't strictly enforce blob range here in the fetch handler yet,
			// but the proof submission will fail if we serve/prove outside the opened session.
		} else {
			dlSession, err = loadDownloadSession(downloadSessionID)
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, "invalid download_session", err.Error())
				return
			}
			if dlSession.DealID != dealID {
				writeJSONError(w, http.StatusBadRequest, "download_session does not match request", "deal_id mismatch")
				return
			}
			if strings.TrimSpace(dlSession.Owner) != strings.TrimSpace(owner) {
				writeJSONError(w, http.StatusBadRequest, "download_session does not match request", "owner mismatch")
				return
			}
			if strings.TrimSpace(dlSession.FilePath) != strings.TrimSpace(filePath) {
				writeJSONError(w, http.StatusBadRequest, "download_session does not match request", "file_path mismatch")
				return
			}
		}
	}

	// 2. Resolve NilFS file.
	rangeHeader := strings.TrimSpace(r.Header.Get("Range"))
	var rangeHeaderStart uint64
	var rangeHeaderLen uint64
	if rangeHeader != "" {
		start, length, perr := parseHTTPRange(rangeHeader)
		if perr != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid Range header", perr.Error())
			return
		}
		rangeHeaderStart = start
		rangeHeaderLen = length
	}
	if isDownloadSession {
		if rangeHeader == "" {
			writeJSONError(w, http.StatusBadRequest, "Range header is required", "download_session fetches must be chunked")
			return
		}
		if rangeHeaderLen == 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid Range header", "range length must be non-zero")
			return
		}
		if rangeHeaderLen > uint64(types.BLOB_SIZE) {
			writeJSONError(w, http.StatusBadRequest, "range too large", fmt.Sprintf("range must be <= %d", types.BLOB_SIZE))
			return
		}

		reqRangeStart = rangeHeaderStart
		reqRangeLen = rangeHeaderLen

		if !isOnchainSession {
			// Enforce the signed session range (range_len == 0 means "until EOF").
			if reqRangeStart < dlSession.RangeStart {
				writeJSONError(w, http.StatusBadRequest, "range outside session", "range_start before session start")
				return
			}
			if dlSession.RangeLen > 0 {
				if reqRangeStart > reqRangeStart+reqRangeLen {
					writeJSONError(w, http.StatusBadRequest, "range outside session", "range overflow")
					return
				}
				end := reqRangeStart + reqRangeLen
				limit := dlSession.RangeStart + dlSession.RangeLen
				if limit < dlSession.RangeStart {
					writeJSONError(w, http.StatusBadRequest, "range outside session", "session range overflow")
					return
				}
				if end > limit {
					writeJSONError(w, http.StatusBadRequest, "range outside session", "range exceeds session limit")
					return
				}
			}
		}
	} else {
		if requireRetrievalReqSig {
			if rangeHeader != "" && reqRangeLen == 0 {
				writeJSONError(w, http.StatusBadRequest, "range must be signed", "include range_start/range_len in the signed retrieval request")
				return
			}
			if reqRangeLen > 0 && rangeHeader != "" {
				if rangeHeaderStart != reqRangeStart || rangeHeaderLen != reqRangeLen {
					writeJSONError(w, http.StatusBadRequest, "range mismatch", "Range header must match signed request")
					return
				}
			}
		} else {
			// MetaMask-only tx mode: require a standard HTTP Range header (no request signatures).
			if rangeHeader == "" {
				// Allow non-range fetches only if the file fits within a single blob; otherwise
				// require chunking so we can provide a single per-blob proof header.
				if entry, eerr := loadSlabIndex(dealDir); eerr == nil {
					if info, ok := entry.files[filePath]; ok {
						if info.Length > uint64(types.BLOB_SIZE) {
							writeJSONError(w, http.StatusBadRequest, "Range header is required", "unsigned fetches must be chunked")
							return
						}
					}
				}
				reqRangeStart = 0
				reqRangeLen = 0
			} else {
				if rangeHeaderLen == 0 {
					writeJSONError(w, http.StatusBadRequest, "invalid Range header", "range length must be non-zero")
					return
				}
				if rangeHeaderLen > uint64(types.BLOB_SIZE) {
					writeJSONError(w, http.StatusBadRequest, "range too large", fmt.Sprintf("range must be <= %d", types.BLOB_SIZE))
					return
				}
				reqRangeStart = rangeHeaderStart
				reqRangeLen = rangeHeaderLen
			}
		}
	}

	content, mduIdx, mduPath, absOffset, servedLen, totalFileLen, err := resolveNilfsFileSegmentForFetch(dealDir, filePath, reqRangeStart, reqRangeLen)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(
				w,
				http.StatusNotFound,
				"file not found in deal",
				fmt.Sprintf("List files via GET /gateway/list-files/%s?deal_id=%d&owner=%s", manifestRoot.Canonical, dealID, owner),
			)
			return
		}
		log.Printf("resolveNilfsFileSegmentForFetch failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve file", "")
		return
	}
	defer content.Close()
	if servedLen == 0 {
		writeJSONError(w, http.StatusRequestedRangeNotSatisfiable, "range not satisfiable", "")
		return
	}
	implicitRange := !requireRetrievalReqSig && !isDownloadSession && rangeHeader == ""
	// If this was a non-range fetch in unsigned mode, only allow it when the
	// full response fits within a single blob; otherwise require chunking.
	if implicitRange {
		if servedLen > uint64(types.BLOB_SIZE) {
			writeJSONError(w, http.StatusBadRequest, "Range header is required", "unsigned fetches must be chunked")
			return
		}
	}

	// Resolve Provider Address for the Header (for Client-Side Signing)
	providerAddr := cachedProviderAddress(r.Context())
	if strings.TrimSpace(providerAddr) == "" {
		writeJSONError(w, http.StatusInternalServerError, "provider address unavailable", "set NIL_PROVIDER_ADDRESS or NIL_PROVIDER_KEY to a valid local key")
		return
	}
	if isDownloadSession && strings.TrimSpace(dlSession.Provider) != "" && strings.TrimSpace(providerAddr) != strings.TrimSpace(dlSession.Provider) {
		writeJSONError(w, http.StatusBadRequest, "download_session does not match this provider", "provider mismatch")
		return
	}

	// Generate Proof Details payload (for receipt submission).
	manifestPath := filepath.Join(dealDir, "manifest.bin")
	var proofPayload []byte
	var proofHash string
	var proofMs int64
	proofStart := time.Now()
	offsetInMdu := absOffset % RawMduCapacity
	blobIndex, berr := rawOffsetToEncodedBlobIndex(offsetInMdu)
	if berr != nil {
		blobIndex = 0
	}
	// Range requests must stay within a single physical MDU and blob for now.
	if reqRangeLen > 0 || implicitRange {
		endAbs := absOffset + servedLen - 1
		if absOffset/RawMduCapacity != endAbs/RawMduCapacity {
			writeJSONError(w, http.StatusBadRequest, "range crosses MDU boundary", "split into multiple requests")
			return
		}
		endOffsetInMdu := endAbs % RawMduCapacity
		endBlob, eerr := rawOffsetToEncodedBlobIndex(endOffsetInMdu)
		if eerr != nil || endBlob != blobIndex {
			writeJSONError(w, http.StatusBadRequest, "range crosses blob boundary", "split into multiple requests")
			return
		}
	}

	proofPayload, proofHash, err = generateProofHeaderJSON(r.Context(), dealID, 1, mduIdx, mduPath, manifestPath, blobIndex, absOffset)
	proofMs = time.Since(proofStart).Milliseconds()
	if err != nil {
		log.Printf("GatewayFetch: generateProofHeaderJSON failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to generate proof_details", err.Error())
		return
	}
	if proofHash == "" || proofPayload == nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to generate proof_details", "")
		return
	}

	var fetchSessionID string
	if isDownloadSession {
		var wrapper struct {
			ProofDetail json.RawMessage `json:"proof_details"`
		}
		if err := json.Unmarshal(proofPayload, &wrapper); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to parse proof_details", err.Error())
			return
		}
		var chained types.ChainedProof
		if err := json.Unmarshal(wrapper.ProofDetail, &chained); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to parse proof_details", err.Error())
			return
		}
		var err error
		if isOnchainSession {
			err = storeOnChainSessionProof(onchainSessionID, chained)
		} else {
			err = appendDownloadChunkToSession(downloadSessionID, downloadChunk{
				RangeStart:   reqRangeStart,
				RangeLen:     servedLen,
				ProofDetails: chained,
			})
		}
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to record download session chunk", err.Error())
			return
		}
	} else {
		if requireRetrievalReqSig {
			// Anti-replay: only consume the request nonce once we've fully validated the deal state
			// and successfully generated the proof/segment.
			if err := checkAndStoreRequestReplay(dealID, owner, reqNonce, reqExpiresAt); err != nil {
				writeJSONError(w, http.StatusConflict, "replay rejected", err.Error())
				return
			}

			sessionID, serr := storeFetchSession(fetchSession{
				DealID:      dealID,
				EpochID:     1,
				Owner:       owner,
				Provider:    providerAddr,
				FilePath:    filePath,
				RangeStart:  reqRangeStart,
				RangeLen:    servedLen,
				BytesServed: servedLen,
				ProofHash:   proofHash,
				ReqNonce:    reqNonce,
				ReqExpires:  reqExpiresAt,
				ExpiresAt:   time.Now().Add(10 * time.Minute),
			})
			if serr != nil {
				writeJSONError(w, http.StatusInternalServerError, "failed to create fetch session", serr.Error())
				return
			}
			fetchSessionID = sessionID
		}
	}

	// Add Retrieval Headers for Client Signing (Interactive Protocol)
	w.Header().Set("X-Nil-Deal-ID", dealIDStr)
	w.Header().Set("X-Nil-Epoch", "1") // Fixed Epoch 1 for Devnet
	w.Header().Set("X-Nil-Bytes-Served", strconv.FormatUint(servedLen, 10))
	w.Header().Set("X-Nil-Provider", providerAddr)
	w.Header().Set("X-Nil-File-Path", filePath)
	w.Header().Set("X-Nil-Range-Start", strconv.FormatUint(reqRangeStart, 10))
	w.Header().Set("X-Nil-Range-Len", strconv.FormatUint(servedLen, 10))
	w.Header().Set("X-Nil-Gateway-Proof-MS", strconv.FormatInt(proofMs, 10))
	w.Header().Set("X-Nil-Gateway-Fetch-MS", strconv.FormatInt(time.Since(startTotal).Milliseconds(), 10))
	if isDownloadSession {
		w.Header().Set("X-Nil-Download-Session", downloadSessionID)
	} else {
		if fetchSessionID != "" {
			w.Header().Set("X-Nil-Fetch-Session", fetchSessionID)
		}
	}
	if proofHash != "" {
		w.Header().Set("X-Nil-Proof-Hash", proofHash)
	}
	if proofPayload != nil {
		w.Header().Set("X-Nil-Proof-JSON", base64.StdEncoding.EncodeToString(proofPayload))
	}

	// Serve as attachment so browsers will download instead of inline JSON.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(filePath)))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatUint(servedLen, 10))
	if reqRangeLen > 0 || rangeHeader != "" {
		end := reqRangeStart + servedLen - 1
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", reqRangeStart, end, totalFileLen))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	_, _ = io.Copy(w, content)
}

// GatewayPlanRetrievalSession plans an on-chain RetrievalSession for a file byte-range by
// mapping it to a contiguous blob interval over the NilFS slab.
func GatewayPlanRetrievalSession(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRoot, err := parseManifestRoot(rawManifestRoot)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid manifest_root", err.Error())
		return
	}

	q := r.URL.Query()
	dealIDStr := strings.TrimSpace(q.Get("deal_id"))
	owner := strings.TrimSpace(q.Get("owner"))
	filePath, ferr := validateNilfsFilePath(q.Get("file_path"))
	if dealIDStr == "" || owner == "" {
		writeJSONError(w, http.StatusBadRequest, "deal_id and owner query parameters are required", "")
		return
	}
	if ferr != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid file_path", "List files via GET /gateway/list-files/<manifest_root>?deal_id=<id>&owner=<owner>")
		return
	}
	dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid deal_id", "")
		return
	}

	dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeJSONError(w, http.StatusNotFound, "deal not found", "")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to validate deal", "")
		return
	}
	if dealOwner == "" || dealOwner != owner {
		writeJSONError(w, http.StatusForbidden, "forbidden: owner does not match deal", "")
		return
	}
	if strings.TrimSpace(dealCID) == "" {
		writeJSONError(w, http.StatusConflict, "deal has no committed manifest_root yet", "commit content before planning retrieval sessions")
		return
	}
	dealRoot, err := parseManifestRoot(dealCID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "invalid on-chain manifest_root", err.Error())
		return
	}
	if dealRoot.Canonical != manifestRoot.Canonical {
		writeJSONError(w, http.StatusConflict, "stale manifest_root (does not match on-chain deal state)", fmt.Sprintf("Query the deal and retry with manifest_root=%s", dealRoot.Canonical))
		return
	}

	dealDir, err := resolveDealDir(dealRoot, dealRoot.Canonical)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	startOffset, fileLen, witnessCount, err := GetFileMetaByPath(dealDir, filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "file not found in deal", "")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve file metadata", err.Error())
		return
	}

	var rangeStart uint64
	var rangeLen uint64
	if raw := strings.TrimSpace(q.Get("range_start")); raw != "" {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid range_start", "")
			return
		}
		rangeStart = v
	}
	if raw := strings.TrimSpace(q.Get("range_len")); raw != "" {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid range_len", "")
			return
		}
		rangeLen = v
	}
	if fileLen == 0 {
		writeJSONError(w, http.StatusConflict, "file has zero length", "")
		return
	}
	if rangeStart >= fileLen {
		writeJSONError(w, http.StatusBadRequest, "range_start beyond EOF", "")
		return
	}
	if rangeLen == 0 || rangeLen > fileLen-rangeStart {
		rangeLen = fileLen - rangeStart
	}

	absStart := startOffset + rangeStart
	absEnd := absStart + rangeLen - 1

	startMdu := uint64(1) + witnessCount + (absStart / RawMduCapacity)
	endMdu := uint64(1) + witnessCount + (absEnd / RawMduCapacity)
	startBlob, err := rawOffsetToEncodedBlobIndex(absStart % RawMduCapacity)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to map start blob", err.Error())
		return
	}
	endBlob, err := rawOffsetToEncodedBlobIndex(absEnd % RawMduCapacity)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to map end blob", err.Error())
		return
	}

	startGlobal := startMdu*uint64(types.BLOBS_PER_MDU) + uint64(startBlob)
	endGlobal := endMdu*uint64(types.BLOBS_PER_MDU) + uint64(endBlob)
	if endGlobal < startGlobal {
		writeJSONError(w, http.StatusInternalServerError, "invalid blob mapping", "")
		return
	}
	blobCount := endGlobal - startGlobal + 1

	providerAddr := cachedProviderAddress(r.Context())
	if strings.TrimSpace(providerAddr) == "" {
		writeJSONError(w, http.StatusInternalServerError, "provider address unavailable", "set NIL_PROVIDER_ADDRESS or NIL_PROVIDER_KEY")
		return
	}

	type response struct {
		DealID         uint64 `json:"deal_id"`
		Owner          string `json:"owner"`
		Provider       string `json:"provider"`
		ManifestRoot   string `json:"manifest_root"`
		FilePath       string `json:"file_path"`
		RangeStart     uint64 `json:"range_start"`
		RangeLen       uint64 `json:"range_len"`
		StartMduIndex  uint64 `json:"start_mdu_index"`
		StartBlobIndex uint32 `json:"start_blob_index"`
		BlobCount      uint64 `json:"blob_count"`
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response{
		DealID:         dealID,
		Owner:          owner,
		Provider:       providerAddr,
		ManifestRoot:   dealRoot.Canonical,
		FilePath:       filePath,
		RangeStart:     rangeStart,
		RangeLen:       rangeLen,
		StartMduIndex:  startMdu,
		StartBlobIndex: startBlob,
		BlobCount:      blobCount,
	})
}

type nilfsFileEntry struct {
	Path        string `json:"path"`
	SizeBytes   uint64 `json:"size_bytes"`
	StartOffset uint64 `json:"start_offset"`
	Flags       uint8  `json:"flags"`
}

type slabSegment struct {
	Kind       string `json:"kind"` // mdu0 | witness | user
	StartIndex uint64 `json:"start_index"`
	Count      uint64 `json:"count"`
	SizeBytes  uint64 `json:"size_bytes"`
}

type slabLayoutResponse struct {
	ManifestRoot   string        `json:"manifest_root"`
	MduSizeBytes   uint64        `json:"mdu_size_bytes"`
	BlobSizeBytes  uint64        `json:"blob_size_bytes"`
	TotalMdus      uint64        `json:"total_mdus"`
	WitnessMdus    uint64        `json:"witness_mdus"`
	UserMdus       uint64        `json:"user_mdus"`
	FileRecords    uint32        `json:"file_records"`
	FileCount      uint32        `json:"file_count"`
	TotalSizeBytes uint64        `json:"total_size_bytes"`
	Segments       []slabSegment `json:"segments"`
}

// GatewayListFiles returns the NilFS V1 file table for a manifest root.
func GatewayListFiles(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRoot, err := parseManifestRoot(rawManifestRoot)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid manifest_root", err.Error())
		return
	}

	q := r.URL.Query()
	dealIDStr := strings.TrimSpace(q.Get("deal_id"))
	owner := strings.TrimSpace(q.Get("owner"))
	if dealIDStr == "" || owner == "" {
		writeJSONError(w, http.StatusBadRequest, "deal_id and owner query parameters are required", "")
		return
	}
	dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid deal_id", "")
		return
	}

	dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeJSONError(w, http.StatusNotFound, "deal not found", "")
			return
		}
		log.Printf("GatewayListFiles: failed to fetch deal %d: %v", dealID, err)
		writeJSONError(w, http.StatusInternalServerError, "failed to validate deal owner", "")
		return
	}
	if dealOwner == "" || dealOwner != owner {
		writeJSONError(w, http.StatusForbidden, "forbidden: owner does not match deal", "")
		return
	}
	if strings.TrimSpace(dealCID) == "" {
		writeJSONError(
			w,
			http.StatusConflict,
			"deal has no committed manifest_root yet",
			"Commit content via /gateway/update-deal-content-evm (or update-deal-content) first",
		)
		return
	}
	dealRoot, err := parseManifestRoot(dealCID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "invalid on-chain manifest_root", err.Error())
		return
	}
	if dealRoot.Canonical != manifestRoot.Canonical {
		writeJSONError(
			w,
			http.StatusConflict,
			"stale manifest_root (does not match on-chain deal state)",
			fmt.Sprintf("Query the deal and retry with manifest_root=%s", dealRoot.Canonical),
		)
		return
	}

	dealDir, err := resolveDealDir(manifestRoot, rawManifestRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}

	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(w, http.StatusNotFound, "slab not found", "")
			return
		}
		log.Printf("GatewayListFiles: failed to read MDU #0: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to read slab", "")
		return
	}

	b, err := crypto_ffi.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		log.Printf("GatewayListFiles: failed to parse MDU #0: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to parse slab", "")
		return
	}
	defer b.Free()

	count := b.GetRecordCount()
	latest := make(map[string]nilfsFileEntry, count)
	for i := uint32(0); i < count; i++ {
		rec, err := b.GetRecord(i)
		if err != nil {
			continue
		}
		// Tombstone slot.
		if rec.Path[0] == 0 {
			continue
		}
		name := string(bytes.TrimRight(rec.Path[:], "\x00"))
		length, flags := crypto_ffi.UnpackLengthAndFlags(rec.LengthAndFlags)
		latest[name] = nilfsFileEntry{
			Path:        name,
			SizeBytes:   length,
			StartOffset: rec.StartOffset,
			Flags:       flags,
		}
	}

	files := make([]nilfsFileEntry, 0, len(latest))
	var total uint64
	for _, entry := range latest {
		files = append(files, entry)
		total += entry.SizeBytes
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })

	resp := map[string]any{
		"manifest_root":    manifestRoot.Canonical,
		"total_size_bytes": total,
		"files":            files,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewayListFiles encode error: %v", err)
	}
}

// GatewaySlab returns the slab layout summary for a manifest root.
// Optional query params:
// - deal_id + owner: best-effort authz against on-chain deal owner (cid match enforced if the deal is already committed).
func GatewaySlab(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	vars := mux.Vars(r)
	rawManifestRoot := strings.TrimSpace(vars["cid"])
	if rawManifestRoot == "" {
		writeJSONError(w, http.StatusBadRequest, "manifest_root path parameter is required", "")
		return
	}
	manifestRoot, err := parseManifestRoot(rawManifestRoot)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid manifest_root", err.Error())
		return
	}

	q := r.URL.Query()
	dealIDStr := strings.TrimSpace(q.Get("deal_id"))
	owner := strings.TrimSpace(q.Get("owner"))
	if dealIDStr != "" || owner != "" {
		if dealIDStr == "" || owner == "" {
			writeJSONError(w, http.StatusBadRequest, "deal_id and owner must be provided together", "")
			return
		}
		dealID, err := strconv.ParseUint(dealIDStr, 10, 64)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid deal_id", "")
			return
		}

		dealOwner, dealCID, err := fetchDealOwnerAndCID(dealID)
		if err != nil {
			if errors.Is(err, ErrDealNotFound) {
				writeJSONError(w, http.StatusNotFound, "deal not found", "")
				return
			}
			log.Printf("GatewaySlab: failed to fetch deal %d: %v", dealID, err)
			writeJSONError(w, http.StatusInternalServerError, "failed to validate deal owner", "")
			return
		}
		if dealOwner == "" || dealOwner != owner {
			writeJSONError(w, http.StatusForbidden, "forbidden: owner does not match deal", "")
			return
		}
		if strings.TrimSpace(dealCID) == "" {
			writeJSONError(
				w,
				http.StatusConflict,
				"deal has no committed manifest_root yet",
				"Commit content via /gateway/update-deal-content-evm (or update-deal-content) first",
			)
			return
		}
		dealRoot, err := parseManifestRoot(dealCID)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "invalid on-chain manifest_root", err.Error())
			return
		}
		if dealRoot.Canonical != manifestRoot.Canonical {
			writeJSONError(
				w,
				http.StatusConflict,
				"stale manifest_root (does not match on-chain deal state)",
				fmt.Sprintf("Query the deal and retry with manifest_root=%s", dealRoot.Canonical),
			)
			return
		}
	}

	dealDir, err := resolveDealDir(manifestRoot, rawManifestRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "slab not found on disk", "")
			return
		}
		if errors.Is(err, ErrDealDirConflict) {
			writeJSONError(w, http.StatusConflict, "deal directory conflict", err.Error())
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to resolve slab directory", err.Error())
		return
	}
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(w, http.StatusNotFound, "slab not found", "")
			return
		}
		log.Printf("GatewaySlab: failed to read MDU #0: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to read slab", "")
		return
	}

	b, err := crypto_ffi.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		log.Printf("GatewaySlab: failed to parse MDU #0: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to parse slab", "")
		return
	}
	defer b.Free()

	var fileCount uint32
	var totalSize uint64
	var maxEnd uint64
	count := b.GetRecordCount()
	for i := uint32(0); i < count; i++ {
		rec, err := b.GetRecord(i)
		if err != nil {
			continue
		}
		length, _ := crypto_ffi.UnpackLengthAndFlags(rec.LengthAndFlags)
		end := rec.StartOffset + length
		if end > maxEnd {
			maxEnd = end
		}
		// Path[0]==0 marks a tombstone in NilFS V1.
		if rec.Path[0] == 0 {
			continue
		}
		fileCount++
		totalSize += length
	}

	userMdus := uint64(0)
	if maxEnd > 0 {
		userMdus = (maxEnd + RawMduCapacity - 1) / RawMduCapacity
	}

	entries, err := os.ReadDir(dealDir)
	if err != nil {
		log.Printf("GatewaySlab: failed to read slab dir: %v", err)
		http.Error(w, "failed to read slab", http.StatusInternalServerError)
		return
	}

	idxSet := map[uint64]struct{}{}
	var maxIdx uint64
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "mdu_") || !strings.HasSuffix(name, ".bin") {
			continue
		}
		idxStr := strings.TrimSuffix(strings.TrimPrefix(name, "mdu_"), ".bin")
		idx, err := strconv.ParseUint(idxStr, 10, 64)
		if err != nil {
			continue
		}
		idxSet[idx] = struct{}{}
		if idx > maxIdx {
			maxIdx = idx
		}
	}

	if len(idxSet) == 0 {
		http.Error(w, "slab not found", http.StatusNotFound)
		return
	}
	if _, ok := idxSet[0]; !ok {
		http.Error(w, "invalid slab layout: mdu_0.bin missing", http.StatusInternalServerError)
		return
	}

	totalMdus := maxIdx + 1
	if uint64(len(idxSet)) != totalMdus {
		http.Error(w, "invalid slab layout: non-contiguous mdu files", http.StatusInternalServerError)
		return
	}
	if totalMdus < 1 {
		http.Error(w, "invalid slab layout", http.StatusInternalServerError)
		return
	}
	if totalMdus-1 < userMdus {
		http.Error(w, "invalid slab layout: file table exceeds user mdus", http.StatusInternalServerError)
		return
	}
	witnessMdus := (totalMdus - 1) - userMdus

	segments := []slabSegment{
		{Kind: "mdu0", StartIndex: 0, Count: 1, SizeBytes: types.MDU_SIZE},
	}
	if witnessMdus > 0 {
		segments = append(segments, slabSegment{Kind: "witness", StartIndex: 1, Count: witnessMdus, SizeBytes: types.MDU_SIZE})
	}
	if userMdus > 0 {
		segments = append(segments, slabSegment{Kind: "user", StartIndex: 1 + witnessMdus, Count: userMdus, SizeBytes: types.MDU_SIZE})
	}

	resp := slabLayoutResponse{
		ManifestRoot:   manifestRoot.Canonical,
		MduSizeBytes:   types.MDU_SIZE,
		BlobSizeBytes:  types.BLOB_SIZE,
		TotalMdus:      totalMdus,
		WitnessMdus:    witnessMdus,
		UserMdus:       userMdus,
		FileRecords:    b.GetRecordCount(),
		FileCount:      fileCount,
		TotalSizeBytes: totalSize,
		Segments:       segments,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("GatewaySlab encode error: %v", err)
	}
}

// shardFile runs nil-cli shard on the given path and extracts the full output.
func shardFile(ctx context.Context, path string, raw bool, savePrefix string) (*NilCliOutput, error) {
	if ctx == nil {
		ctx = context.Background()
	}

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
	if savePrefix != "" {
		args = append(args, "--save-mdu-prefix", savePrefix)
	}

	// Use execNilCli which now returns ([]byte, error)
	outBytes, err := execNilCli(ctx, args...)
	if err != nil {
		return nil, fmt.Errorf("nil-cli shard failed: %w", err)
	}

	// nil_cli with --out writes to file, but might print logs to stdout.
	// We should read the file if it exists.
	if _, err := os.Stat(outPath); err == nil {
		data, err := os.ReadFile(outPath)
		if err != nil {
			return nil, fmt.Errorf("failed to read shard output file: %w", err)
		}
		var out NilCliOutput
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, fmt.Errorf("failed to parse shard output file: %w", err)
		}
		return &out, nil
	}

	// Fallback to parsing stdout if file doesn't exist (though --out was passed)
	body := extractJSONBody(outBytes)
	if body == nil {
		return nil, fmt.Errorf("failed to extract JSON from shard output (and output file missing): %s", string(outBytes))
	}

	var out NilCliOutput
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("failed to parse shard output: %w", err)
	}
	return &out, nil
}

func fastShardQuick(path string) (string, uint64, uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, 0, err
	}
	size := uint64(len(data))
	hash := sha256.Sum256(data)
	// Pad the 32-byte SHA256 hash with 16 zero bytes to make it 48 bytes.
	// This is NOT a cryptographically valid KZG commitment, but passes length check.
	paddedHash := make([]byte, 48)
	copy(paddedHash[:32], hash[:])
	cid := "0x" + hex.EncodeToString(paddedHash)

	const mduSize uint64 = 8 * 1024 * 1024
	userMdus := size / mduSize
	if size%mduSize != 0 {
		userMdus++
	}
	if userMdus == 0 {
		userMdus = 1
	}
	// MDU #0 + a single witness MDU + user data MDUs
	allocated := 1 + 1 + userMdus
	return cid, size, allocated, nil
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range, X-Nil-Req-Sig, X-Nil-Req-Nonce, X-Nil-Req-Expires-At, X-Nil-Req-Range-Start, X-Nil-Req-Range-Len, X-Nil-Download-Session, X-Nil-Session-Id")
	w.Header().Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, X-Nil-Deal-ID, X-Nil-Epoch, X-Nil-Bytes-Served, X-Nil-Provider, X-Nil-File-Path, X-Nil-Range-Start, X-Nil-Range-Len, X-Nil-Proof-JSON, X-Nil-Proof-Hash, X-Nil-Fetch-Session, X-Nil-Gateway-Proof-MS, X-Nil-Gateway-Fetch-MS")
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

func extractNilAddress(out string) string {
	normalized := strings.ToLower(out)
	matches := nilAddrRe.FindAllString(normalized, -1)
	if len(matches) == 0 {
		return ""
	}
	return matches[len(matches)-1]
}

func parseHTTPRange(header string) (start uint64, length uint64, err error) {
	// Only support a single explicit range: "bytes=start-end".
	// No suffix ranges, no multipart ranges.
	header = strings.TrimSpace(header)
	if header == "" {
		return 0, 0, fmt.Errorf("empty Range")
	}
	if !strings.HasPrefix(strings.ToLower(header), "bytes=") {
		return 0, 0, fmt.Errorf("unsupported range unit")
	}
	spec := strings.TrimSpace(header[len("bytes="):])
	if spec == "" || strings.Contains(spec, ",") {
		return 0, 0, fmt.Errorf("multiple ranges not supported")
	}
	parts := strings.Split(spec, "-")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid range format")
	}
	if strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return 0, 0, fmt.Errorf("open-ended ranges not supported")
	}
	s, err := strconv.ParseUint(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid range start")
	}
	e, err := strconv.ParseUint(strings.TrimSpace(parts[1]), 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid range end")
	}
	if e < s {
		return 0, 0, fmt.Errorf("invalid range end before start")
	}
	return s, e - s + 1, nil
}

func rawOffsetToEncodedBlobIndex(rawOffsetInMdu uint64) (uint32, error) {
	// Map a raw NilFS payload offset to the underlying encoded MDU byte position
	// (32-byte scalars, right-aligned payload), then to a 128 KiB blob index.
	//
	// Note: This assumes the standard NilFS packing (31 payload bytes per 32-byte scalar).
	if rawOffsetInMdu >= RawMduCapacity {
		return 0, fmt.Errorf("raw offset out of bounds: %d", rawOffsetInMdu)
	}
	scalarIdx := rawOffsetInMdu / nilfsScalarPayloadBytes
	payloadOffset := rawOffsetInMdu % nilfsScalarPayloadBytes
	// Most scalars have a 1-byte left pad (32-31). The very last scalar of a
	// partially-filled MDU can have a larger pad, but in devnet we treat it as 1.
	encodedPos := scalarIdx*nilfsScalarBytes + 1 + payloadOffset
	blobIdx := encodedPos / uint64(types.BLOB_SIZE)
	if blobIdx >= uint64(types.BLOBS_PER_MDU) {
		return 0, fmt.Errorf("derived blob index out of range: %d", blobIdx)
	}
	return uint32(blobIdx), nil
}

func eip712ChainID() *big.Int {
	// Prefer numeric chain IDs (local devnet uses 31337). If NIL_CHAIN_ID is not
	// numeric (e.g. "test-1"), fall back to 31337 to match the web UI default.
	raw := strings.TrimSpace(chainID)
	if raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			return big.NewInt(n)
		}
	}
	return big.NewInt(31337)
}

func recoverEvmAddressFromDigest(digest []byte, signature []byte) (common.Address, error) {
	if len(digest) != 32 {
		return common.Address{}, fmt.Errorf("invalid digest length: %d", len(digest))
	}
	if len(signature) != 65 {
		return common.Address{}, fmt.Errorf("invalid signature length: %d", len(signature))
	}
	sig := make([]byte, 65)
	copy(sig, signature)
	v := sig[64]
	if v == 27 || v == 28 {
		v -= 27
	}
	if v != 0 && v != 1 {
		return common.Address{}, fmt.Errorf("invalid signature v: %d", sig[64])
	}
	sig[64] = v

	pub, err := crypto.SigToPub(digest, sig)
	if err != nil {
		return common.Address{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}

func verifyRetrievalRequestSignature(dealOwner string, dealID uint64, filePath string, rangeStart uint64, rangeLen uint64, nonce uint64, expiresAt uint64, sigHex string) error {
	if strings.TrimSpace(sigHex) == "" {
		return fmt.Errorf("req_sig is required")
	}
	if expiresAt == 0 {
		return fmt.Errorf("req_expires_at is required")
	}
	now := uint64(time.Now().Unix())
	// Allow a small clock skew, but never accept long-lived tickets.
	if expiresAt+30 < now {
		return fmt.Errorf("request signature expired")
	}
	if expiresAt > now+10*60 {
		return fmt.Errorf("request signature expires too far in the future")
	}
	if nonce == 0 {
		return fmt.Errorf("req_nonce is required")
	}
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return fmt.Errorf("file_path is required")
	}

	sigBytes, err := decodeHex(sigHex)
	if err != nil {
		return fmt.Errorf("invalid req_sig: %w", err)
	}
	if len(sigBytes) != 65 {
		return fmt.Errorf("invalid req_sig length: %d", len(sigBytes))
	}

	domainSep := types.HashDomainSeparator(eip712ChainID())
	structHash := types.HashRetrievalRequest(dealID, filePath, rangeStart, rangeLen, nonce, expiresAt)
	digest := types.ComputeEIP712Digest(domainSep, structHash)
	evmAddr, err := recoverEvmAddressFromDigest(digest, sigBytes)
	if err != nil {
		return fmt.Errorf("failed to recover request signer: %w", err)
	}
	nilAddr, err := evmHexToNilAddress(evmAddr.Hex())
	if err != nil {
		return fmt.Errorf("failed to map request signer to nil address: %w", err)
	}
	if strings.TrimSpace(nilAddr) != strings.TrimSpace(dealOwner) {
		return fmt.Errorf("request signer is not deal owner")
	}
	return nil
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// resolveKeyAddress returns the bech32 address for a key name in the local keyring.
func resolveKeyAddress(ctx context.Context, name string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cctx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()
	out, err := execNilchaind(
		cctx,
		"keys", "show", name,
		"-a",
		"--home", homeDir,
		"--keyring-backend", "test",
	)
	if errors.Is(cctx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("keys show timed out after %s", cmdTimeout)
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			combined := append(out, ee.Stderr...)
			if addr := extractNilAddress(string(combined)); addr != "" {
				return addr, nil
			}
			return "", fmt.Errorf("keys show failed: %v (%s)", err, strings.TrimSpace(string(combined)))
		}
		return "", fmt.Errorf("keys show failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	if addr := extractNilAddress(string(out)); addr != "" {
		return addr, nil
	}
	trimmed := strings.TrimSpace(string(out))
	if addr := extractNilAddress(trimmed); addr != "" {
		return addr, nil
	}
	return "", fmt.Errorf("keys show returned no nil bech32 address (%q)", trimmed)
}

// submitRetrievalProof submits a retrieval proof for the given deal and file
// using the default provider key and epoch.
func submitRetrievalProof(ctx context.Context, dealID uint64, filePath string) (string, error) {
	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	providerAddr, err := resolveKeyAddress(ctx, providerKeyName)
	if err != nil {
		return "", fmt.Errorf("resolveKeyAddress failed: %w", err)
	}
	return submitRetrievalProofWithParams(ctx, dealID, 1, providerKeyName, providerAddr, filePath)
}

// submitRetrievalProofWithParams generates a RetrievalReceipt via the CLI and
// submits it as a retrieval proof, returning the tx hash.
func submitRetrievalProofWithParams(ctx context.Context, dealID, epoch uint64, providerKeyName, providerAddr, filePath string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	dealIDStr := strconv.FormatUint(dealID, 10)
	epochStr := strconv.FormatUint(epoch, 10)

	// Ensure we have a valid 8 MiB MDU file for the proof generator.
	mduPath, isTemp, err := ensureMduFileForProof(filePath)
	if err != nil {
		return "", err
	}
	if abs, err := filepath.Abs(mduPath); err == nil {
		mduPath = abs
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
	if abs, err := filepath.Abs(manifestPath); err == nil {
		manifestPath = abs
	}
	manTmp.Close()
	defer os.Remove(manifestPath)

	// For now, assume MDU index is 0 (single file < 8MB)
	mduIndexStr := "0"

	// 1) Generate a RetrievalReceipt JSON via the CLI (offline signing).
	signCtx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()
	signOut, err := execNilchaind(
		signCtx,
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
	if errors.Is(signCtx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("sign-retrieval-receipt timed out after %s", cmdTimeout)
	}
	if err != nil {
		return "", fmt.Errorf("sign-retrieval-receipt failed: %w (output: %s)", err, string(signOut))
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
	submitOut, err := runTxWithRetry(
		ctx,
		"tx", "nilchain", "submit-retrieval-proof",
		tmpPath,
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas", "auto",
		"--gas-adjustment", "1.6",
		"--gas-prices", gasPrices,
	)
	outStr := string(submitOut)
	if err != nil {
		return "", fmt.Errorf("submit-retrieval-proof failed: %w (%s)", err, outStr)
	}

	return extractTxHash(outStr), nil
}

// fetchDealOwnerAndCID calls the LCD to retrieve the deal owner and CID for a given deal ID.
func fetchDealOwnerAndCID(dealID uint64) (owner string, cid string, err error) {
	url := fmt.Sprintf("%s/nilchain/nilchain/v1/deals/%d", lcdBase, dealID)
	resp, err := lcdHTTPClient.Get(url)
	if err != nil {
		return "", "", fmt.Errorf("LCD request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound {
			return "", "", ErrDealNotFound
		}
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
		cid = strings.TrimSpace(v)
	}
	if cid == "" {
		// Newer deal schema exposes manifest_root as base64 or hex.
		if v, ok := payload.Deal["manifest_root"].(string); ok && strings.TrimSpace(v) != "" {
			raw := strings.TrimSpace(v)
			if strings.HasPrefix(raw, "0x") {
				cid = raw
			} else if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && len(decoded) > 0 {
				cid = "0x" + hex.EncodeToString(decoded)
			} else {
				// Fallback: assume already hex without prefix.
				if _, err := decodeHex(raw); err == nil {
					cid = "0x" + strings.TrimPrefix(raw, "0x")
				}
			}
		} else if v, ok := payload.Deal["manifest_root_hex"].(string); ok {
			cid = strings.TrimSpace(v)
		}
	}

	if strings.TrimSpace(cid) == "" {
		return owner, "", nil
	}
	parsed, err := parseManifestRoot(cid)
	if err != nil {
		return "", "", fmt.Errorf("failed to parse deal manifest_root: %w", err)
	}
	cid = parsed.Canonical
	return owner, cid, nil
}

// creatorHasSomeBalance checks whether a given bech32 address has any non-zero
// balance in the bank module (stake or aatom). It is a devnet guard used to
// ensure users have gone through the faucet flow before deals are created.
func creatorHasSomeBalance(creator string) (bool, error) {
	url := fmt.Sprintf("%s/cosmos/bank/v1beta1/balances/%s", lcdBase, creator)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
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

				return hex.DecodeString(s)

			}

			

			// RetrievalReceipt represents the JSON payload signed by the client.

			type RetrievalReceipt struct {

			
	DealId        uint64          `json:"deal_id"`
	EpochId       uint64          `json:"epoch_id"`
	Provider      string          `json:"provider"`
	FilePath      string          `json:"file_path"`
	RangeStart    uint64          `json:"range_start"`
	RangeLen      uint64          `json:"range_len"`
	BytesServed   uint64          `json:"bytes_served"`
	ProofDetails  json.RawMessage `json:"proof_details"`
	UserSignature []byte          `json:"user_signature"`
	Nonce         uint64          `json:"nonce"`
	ExpiresAt     uint64          `json:"expires_at"`
}

type SignedReceiptEnvelope struct {
	FetchSession string           `json:"fetch_session"`
	Receipt      RetrievalReceipt `json:"receipt"`
}

type SignedReceiptBatchEnvelope struct {
	Receipts []SignedReceiptEnvelope `json:"receipts"`
}

type SignedSessionReceiptEnvelope struct {
	DownloadSession string                       `json:"download_session"`
	Receipt         types.DownloadSessionReceipt `json:"receipt"`
}

// GatewaySubmitReceipt is the User Daemon endpoint.
// It accepts a signed receipt from the browser and forwards it to the Provider.
func GatewaySubmitReceipt(w http.ResponseWriter, r *http.Request) {
	forwardToProvider(w, r, "/sp/receipt")
}

// GatewaySubmitReceipts forwards a batch of receipts to the Provider endpoint.
func GatewaySubmitReceipts(w http.ResponseWriter, r *http.Request) {
	forwardToProvider(w, r, "/sp/receipts")
}

// GatewaySubmitSessionReceipt forwards a bundled download session receipt to the Provider.
func GatewaySubmitSessionReceipt(w http.ResponseWriter, r *http.Request) {
	forwardToProvider(w, r, "/sp/session-receipt")
}

// GatewaySubmitRetrievalSessionProof asks the provider to submit the on-chain proof for a
// RetrievalSession once the client has finished downloading.
func GatewaySubmitRetrievalSessionProof(w http.ResponseWriter, r *http.Request) {
	forwardToProvider(w, r, "/sp/session-proof")
}

// SpSubmitReceipt is the Storage Provider endpoint.
// It accepts a signed receipt, validates it, and submits it to the chain.
func SpSubmitReceipt(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !isGatewayAuthorized(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "missing or invalid gateway auth")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	var env SignedReceiptEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "expected {fetch_session, receipt}")
		return
	}
	if strings.TrimSpace(env.FetchSession) == "" {
		writeJSONError(w, http.StatusBadRequest, "fetch_session is required", "")
		return
	}

	receipt := env.Receipt
	if strings.TrimSpace(receipt.Provider) == "" {
		writeJSONError(w, http.StatusBadRequest, "provider is required", "")
		return
	}
	if strings.TrimSpace(receipt.FilePath) == "" {
		writeJSONError(w, http.StatusBadRequest, "file_path is required", "")
		return
	}
	if receipt.RangeLen == 0 {
		writeJSONError(w, http.StatusBadRequest, "range_len is required", "")
		return
	}
	if receipt.BytesServed != receipt.RangeLen {
		writeJSONError(w, http.StatusBadRequest, "invalid receipt", "bytes_served must equal range_len")
		return
	}
	if len(receipt.UserSignature) == 0 {
		writeJSONError(w, http.StatusBadRequest, "user_signature is required", "client must sign the retrieval receipt (EIP-712) before submission")
		return
	}
	if receipt.Nonce == 0 {
		writeJSONError(w, http.StatusBadRequest, "nonce is required", "client must fetch and increment the on-chain receipt nonce before submission")
		return
	}
	if len(bytes.TrimSpace(receipt.ProofDetails)) == 0 || bytes.Equal(bytes.TrimSpace(receipt.ProofDetails), []byte("null")) {
		writeJSONError(w, http.StatusBadRequest, "proof_details is required", "gateway must supply proof_details so the user signature is bound to an exact proof")
		return
	}

	session, ok := takeFetchSession(strings.TrimSpace(env.FetchSession))
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "invalid fetch_session", "session expired or unknown; retry the download")
		return
	}
	if session.DealID != receipt.DealId || session.EpochID != receipt.EpochId {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "deal_id/epoch_id mismatch")
		return
	}
	if strings.TrimSpace(session.Provider) != strings.TrimSpace(receipt.Provider) {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "provider mismatch")
		return
	}
	if session.BytesServed != receipt.BytesServed {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "bytes_served mismatch")
		return
	}
	if strings.TrimSpace(session.FilePath) != strings.TrimSpace(receipt.FilePath) {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "file_path mismatch")
		return
	}
	if session.RangeStart != receipt.RangeStart {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "range_start mismatch")
		return
	}
	if session.RangeLen != receipt.RangeLen {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "range_len mismatch")
		return
	}
	var chained types.ChainedProof
	if err := json.Unmarshal(receipt.ProofDetails, &chained); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid proof_details", err.Error())
		return
	}
	proofHash, _ := types.HashChainedProof(&chained)
	proofHashHex := "0x" + hex.EncodeToString(proofHash.Bytes())
	if strings.TrimSpace(session.ProofHash) != "" && strings.TrimSpace(session.ProofHash) != strings.TrimSpace(proofHashHex) {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "proof_hash mismatch")
		return
	}

	// Save to temp file for CLI submission
	tmpFile, err := os.CreateTemp(uploadDir, "signed-receipt-*.json")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create temp file", err.Error())
		return
	}
	defer os.Remove(tmpFile.Name())

	receiptJSON, err := json.Marshal(receipt)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to encode receipt", err.Error())
		return
	}
	if _, err := tmpFile.Write(receiptJSON); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to write temp file", err.Error())
		return
	}
	tmpFile.Close()

	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	localProviderAddr := cachedProviderAddress(r.Context())
	if strings.TrimSpace(localProviderAddr) == "" {
		localProviderAddr, err = resolveKeyAddress(r.Context(), providerKeyName)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to resolve provider key address", err.Error())
			return
		}
	}
	if strings.TrimSpace(receipt.Provider) != strings.TrimSpace(localProviderAddr) {
		writeJSONError(
			w,
			http.StatusForbidden,
			"receipt.provider must match this provider",
			fmt.Sprintf("receipt.provider=%q provider_key=%q addr=%q", receipt.Provider, providerKeyName, localProviderAddr),
		)
		return
	}

	txHash, err := submitTxAndWait(
		r.Context(),
		"tx", "nilchain", "submit-retrieval-proof",
		tmpFile.Name(),
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas", "auto",
		"--gas-adjustment", "1.6",
		"--gas-prices", gasPrices,
		"--broadcast-mode", "sync",
		"--output", "json",
	)
	if err != nil {
		log.Printf("SpSubmitReceipt: submit failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "submit-retrieval-proof failed", err.Error())
		return
	}

	log.Printf("SpSubmitReceipt success: txhash=%s", txHash)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"tx_hash": txHash,
	})
}

// SpSubmitReceipts accepts a batch of signed receipts, validates each against its fetch_session,
// and submits them in a single on-chain transaction.
func SpSubmitReceipts(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !isGatewayAuthorized(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "missing or invalid gateway auth")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	var batch SignedReceiptBatchEnvelope
	if err := json.Unmarshal(body, &batch); err != nil {
		// Fallback: accept a raw JSON array of envelopes.
		var arr []SignedReceiptEnvelope
		if err2 := json.Unmarshal(body, &arr); err2 != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON", "expected {receipts:[{fetch_session,receipt},...]} or an array")
			return
		}
		batch.Receipts = arr
	}
	if len(batch.Receipts) == 0 {
		writeJSONError(w, http.StatusBadRequest, "receipts is required", "batch must contain at least one receipt")
		return
	}

	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	localProviderAddr := cachedProviderAddress(r.Context())
	if strings.TrimSpace(localProviderAddr) == "" {
		localProviderAddr, err = resolveKeyAddress(r.Context(), providerKeyName)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to resolve provider key address", err.Error())
			return
		}
	}

	var dealID uint64
	var epochID uint64
	receipts := make([]RetrievalReceipt, 0, len(batch.Receipts))

	for i, env := range batch.Receipts {
		if strings.TrimSpace(env.FetchSession) == "" {
			writeJSONError(w, http.StatusBadRequest, "fetch_session is required", fmt.Sprintf("missing fetch_session at index %d", i))
			return
		}

		receipt := env.Receipt
		if strings.TrimSpace(receipt.Provider) == "" {
			writeJSONError(w, http.StatusBadRequest, "provider is required", fmt.Sprintf("missing provider at index %d", i))
			return
		}
		if strings.TrimSpace(receipt.FilePath) == "" {
			writeJSONError(w, http.StatusBadRequest, "file_path is required", fmt.Sprintf("missing file_path at index %d", i))
			return
		}
		if receipt.RangeLen == 0 {
			writeJSONError(w, http.StatusBadRequest, "range_len is required", fmt.Sprintf("missing range_len at index %d", i))
			return
		}
		if receipt.BytesServed != receipt.RangeLen {
			writeJSONError(w, http.StatusBadRequest, "invalid receipt", fmt.Sprintf("bytes_served must equal range_len at index %d", i))
			return
		}
		if len(receipt.UserSignature) == 0 {
			writeJSONError(w, http.StatusBadRequest, "user_signature is required", fmt.Sprintf("missing user_signature at index %d", i))
			return
		}
		if receipt.Nonce == 0 {
			writeJSONError(w, http.StatusBadRequest, "nonce is required", fmt.Sprintf("missing nonce at index %d", i))
			return
		}
		if len(bytes.TrimSpace(receipt.ProofDetails)) == 0 || bytes.Equal(bytes.TrimSpace(receipt.ProofDetails), []byte("null")) {
			writeJSONError(w, http.StatusBadRequest, "proof_details is required", fmt.Sprintf("missing proof_details at index %d", i))
			return
		}
		if strings.TrimSpace(receipt.Provider) != strings.TrimSpace(localProviderAddr) {
			writeJSONError(
				w,
				http.StatusForbidden,
				"receipt.provider must match this provider",
				fmt.Sprintf("index=%d receipt.provider=%q provider_key=%q addr=%q", i, receipt.Provider, providerKeyName, localProviderAddr),
			)
			return
		}

		if i == 0 {
			dealID = receipt.DealId
			epochID = receipt.EpochId
		} else {
			if receipt.DealId != dealID || receipt.EpochId != epochID {
				writeJSONError(w, http.StatusBadRequest, "batch receipts must match", "all receipts in batch must share deal_id and epoch_id")
				return
			}
		}

		session, ok := takeFetchSession(strings.TrimSpace(env.FetchSession))
		if !ok {
			writeJSONError(w, http.StatusBadRequest, "invalid fetch_session", fmt.Sprintf("session expired or unknown at index %d", i))
			return
		}
		if session.DealID != receipt.DealId || session.EpochID != receipt.EpochId {
			writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "deal_id/epoch_id mismatch")
			return
		}
		if strings.TrimSpace(session.Provider) != strings.TrimSpace(receipt.Provider) {
			writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "provider mismatch")
			return
		}
		if session.BytesServed != receipt.BytesServed {
			writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "bytes_served mismatch")
			return
		}
		if strings.TrimSpace(session.FilePath) != strings.TrimSpace(receipt.FilePath) {
			writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "file_path mismatch")
			return
		}
		if session.RangeStart != receipt.RangeStart {
			writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "range_start mismatch")
			return
		}
		if session.RangeLen != receipt.RangeLen {
			writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "range_len mismatch")
			return
		}

		var chained types.ChainedProof
		if err := json.Unmarshal(receipt.ProofDetails, &chained); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid proof_details", err.Error())
			return
		}
		proofHash, _ := types.HashChainedProof(&chained)
		proofHashHex := "0x" + hex.EncodeToString(proofHash.Bytes())
		if strings.TrimSpace(session.ProofHash) != "" && strings.TrimSpace(session.ProofHash) != strings.TrimSpace(proofHashHex) {
			writeJSONError(w, http.StatusBadRequest, "receipt does not match fetch session", "proof_hash mismatch")
			return
		}

		receipts = append(receipts, receipt)
	}

	// Save batch to temp file for CLI submission.
	tmpFile, err := os.CreateTemp(uploadDir, "signed-receipts-*.json")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create temp file", err.Error())
		return
	}
	defer os.Remove(tmpFile.Name())

	batchJSON, err := json.Marshal(struct {
		Receipts []RetrievalReceipt `json:"receipts"`
	}{Receipts: receipts})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to encode receipt batch", err.Error())
		return
	}
	if _, err := tmpFile.Write(batchJSON); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to write temp file", err.Error())
		return
	}
	tmpFile.Close()

	txHash, err := submitTxAndWait(
		r.Context(),
		"tx", "nilchain", "submit-retrieval-proof",
		tmpFile.Name(),
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas", "auto",
		"--gas-adjustment", "1.6",
		"--gas-prices", gasPrices,
		"--broadcast-mode", "sync",
		"--output", "json",
	)
	if err != nil {
		log.Printf("SpSubmitReceipts: submit failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "submit-retrieval-proof failed", err.Error())
		return
	}

	log.Printf("SpSubmitReceipts success: deal_id=%d epoch_id=%d receipt_count=%d txhash=%s", dealID, epochID, len(receipts), txHash)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":        "success",
		"tx_hash":       txHash,
		"receipt_count": len(receipts),
	})
}

// SpSubmitSessionReceipt accepts a bundled DownloadSessionReceipt, validates it against
// the locally recorded download session chunks, and submits a single on-chain tx.
func SpSubmitSessionReceipt(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !isGatewayAuthorized(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "missing or invalid gateway auth")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	var env SignedSessionReceiptEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "expected {download_session, receipt}")
		return
	}
	sessionID := strings.TrimSpace(env.DownloadSession)
	if sessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "download_session is required", "")
		return
	}

	receipt := env.Receipt
	if receipt.EpochId == 0 {
		writeJSONError(w, http.StatusBadRequest, "epoch_id is required", "")
		return
	}
	if strings.TrimSpace(receipt.Provider) == "" {
		writeJSONError(w, http.StatusBadRequest, "provider is required", "")
		return
	}
	if strings.TrimSpace(receipt.FilePath) == "" {
		writeJSONError(w, http.StatusBadRequest, "file_path is required", "")
		return
	}
	if receipt.TotalBytes == 0 {
		writeJSONError(w, http.StatusBadRequest, "total_bytes is required", "")
		return
	}
	if receipt.ChunkCount == 0 {
		writeJSONError(w, http.StatusBadRequest, "chunk_count is required", "")
		return
	}
	if len(receipt.ChunkLeafRoot) != 32 {
		writeJSONError(w, http.StatusBadRequest, "chunk_leaf_root is required", "must be 32 bytes")
		return
	}
	if len(receipt.UserSignature) == 0 {
		writeJSONError(w, http.StatusBadRequest, "user_signature is required", "")
		return
	}
	if receipt.Nonce == 0 {
		writeJSONError(w, http.StatusBadRequest, "nonce is required", "")
		return
	}

	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	localProviderAddr := cachedProviderAddress(r.Context())
	if strings.TrimSpace(localProviderAddr) == "" {
		localProviderAddr, err = resolveKeyAddress(r.Context(), providerKeyName)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to resolve provider key address", err.Error())
			return
		}
	}
	if strings.TrimSpace(receipt.Provider) != strings.TrimSpace(localProviderAddr) {
		writeJSONError(
			w,
			http.StatusForbidden,
			"receipt.provider must match this provider",
			fmt.Sprintf("receipt.provider=%q provider_key=%q addr=%q", receipt.Provider, providerKeyName, localProviderAddr),
		)
		return
	}

	session, err := loadDownloadSession(sessionID)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid download_session", err.Error())
		return
	}
	if session.DealID != receipt.DealId || session.EpochID != receipt.EpochId {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match download session", "deal_id/epoch_id mismatch")
		return
	}
	if strings.TrimSpace(session.Provider) != strings.TrimSpace(receipt.Provider) {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match download session", "provider mismatch")
		return
	}
	if strings.TrimSpace(session.FilePath) != strings.TrimSpace(receipt.FilePath) {
		writeJSONError(w, http.StatusBadRequest, "receipt does not match download session", "file_path mismatch")
		return
	}
	if len(session.Chunks) == 0 {
		writeJSONError(w, http.StatusBadRequest, "download session has no chunks", "fetch at least one chunk before submitting the session receipt")
		return
	}
	if uint64(len(session.Chunks)) != receipt.ChunkCount {
		writeJSONError(w, http.StatusBadRequest, "chunk_count mismatch", "receipt.chunk_count must equal recorded chunk count")
		return
	}

	chunks := make([]downloadChunk, len(session.Chunks))
	copy(chunks, session.Chunks)
	sort.Slice(chunks, func(i, j int) bool {
		if chunks[i].RangeStart != chunks[j].RangeStart {
			return chunks[i].RangeStart < chunks[j].RangeStart
		}
		return chunks[i].RangeLen < chunks[j].RangeLen
	})

	leaves := make([]common.Hash, len(chunks))
	paths := make([][][]byte, len(chunks))
	var totalBytes uint64
	for i := range chunks {
		if chunks[i].RangeLen == 0 {
			writeJSONError(w, http.StatusBadRequest, "invalid chunk", "chunk range_len must be non-zero")
			return
		}
		if totalBytes > totalBytes+chunks[i].RangeLen {
			writeJSONError(w, http.StatusBadRequest, "invalid chunk", "total_bytes overflow")
			return
		}
		totalBytes += chunks[i].RangeLen

		proofHash, _ := types.HashChainedProof(&chunks[i].ProofDetails)
		leaves[i] = types.HashSessionLeaf(chunks[i].RangeStart, chunks[i].RangeLen, proofHash)
	}

	root, merklePaths := keccakMerkleRootAndPaths(leaves)
	copy(paths, merklePaths)
	if totalBytes != receipt.TotalBytes {
		writeJSONError(w, http.StatusBadRequest, "total_bytes mismatch", "receipt.total_bytes must equal sum of recorded chunks")
		return
	}
	if root != common.BytesToHash(receipt.ChunkLeafRoot) {
		writeJSONError(w, http.StatusBadRequest, "chunk_leaf_root mismatch", "receipt root does not match recorded chunks")
		return
	}

	sessionProof := types.RetrievalSessionProof{
		SessionReceipt: receipt,
		Chunks:         make([]types.SessionChunkProof, len(chunks)),
	}
	for i := range chunks {
		sessionProof.Chunks[i] = types.SessionChunkProof{
			RangeStart:   chunks[i].RangeStart,
			RangeLen:     chunks[i].RangeLen,
			ProofDetails: chunks[i].ProofDetails,
			LeafIndex:    uint32(i),
			MerklePath:   paths[i],
		}
	}

	// Save to temp file for CLI submission.
	tmpFile, err := os.CreateTemp(uploadDir, "session-proof-*.json")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create temp file", err.Error())
		return
	}
	defer os.Remove(tmpFile.Name())

	sessionJSON, err := json.Marshal(sessionProof)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to encode session proof", err.Error())
		return
	}
	if _, err := tmpFile.Write(sessionJSON); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to write temp file", err.Error())
		return
	}
	tmpFile.Close()

	txHash, err := submitTxAndWait(
		r.Context(),
		"tx", "nilchain", "submit-retrieval-proof",
		tmpFile.Name(),
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas", "auto",
		"--gas-adjustment", "1.6",
		"--gas-prices", gasPrices,
		"--broadcast-mode", "sync",
		"--output", "json",
	)
	if err != nil {
		log.Printf("SpSubmitSessionReceipt: submit failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "submit-retrieval-proof failed", err.Error())
		return
	}

	// Consume the download session once it's been successfully submitted.
	_, _ = takeDownloadSession(sessionID)

	log.Printf("SpSubmitSessionReceipt success: deal_id=%d file_path=%s chunk_count=%d txhash=%s", receipt.DealId, receipt.FilePath, len(chunks), txHash)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":      "success",
		"tx_hash":     txHash,
		"chunk_count": len(chunks),
	})
}

type RetrievalSessionProofEnvelope struct {
	SessionID string `json:"session_id"`
}

func parseSessionIDHex(raw string) (string, []byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil, fmt.Errorf("session_id is required")
	}
	s := raw
	if strings.HasPrefix(s, "0x") {
		s = s[2:]
	}
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != 64 {
		return "", nil, fmt.Errorf("session_id must be 32 bytes hex (got %d chars)", len(s))
	}
	bz, err := hex.DecodeString(s)
	if err != nil {
		return "", nil, fmt.Errorf("invalid session_id hex: %w", err)
	}
	return "0x" + s, bz, nil
}

// SpSubmitRetrievalSessionProof submits proof-of-retrieval for an on-chain RetrievalSession.
// It expects the gateway to have recorded per-blob ChainedProofs under the given session_id.
func SpSubmitRetrievalSessionProof(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !isGatewayAuthorized(r) {
		writeJSONError(w, http.StatusForbidden, "forbidden", "missing or invalid gateway auth")
		return
	}

	var env RetrievalSessionProofEnvelope
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON", "expected {session_id}")
		return
	}
	sessionKey, sessionIDBytes, err := parseSessionIDHex(env.SessionID)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid session_id", err.Error())
		return
	}

	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	localProviderAddr := cachedProviderAddress(r.Context())
	if strings.TrimSpace(localProviderAddr) == "" {
		localProviderAddr, err = resolveKeyAddress(r.Context(), providerKeyName)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to resolve provider key address", err.Error())
			return
		}
	}
	if strings.TrimSpace(localProviderAddr) == "" {
		writeJSONError(w, http.StatusInternalServerError, "provider address unavailable", "set NIL_PROVIDER_ADDRESS or NIL_PROVIDER_KEY")
		return
	}

	// Try loading from on-chain proof bucket first
	var proofs []types.ChainedProof
	onChainProofs, err := loadOnChainSessionProofs(sessionKey)
	if err == nil && len(onChainProofs) > 0 {
		proofs = onChainProofs
	} else {
		// Fallback to off-chain download session
		s, err := loadDownloadSession(sessionKey)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid session_id", err.Error())
			return
		}
		if strings.TrimSpace(s.Provider) != "" && strings.TrimSpace(s.Provider) != strings.TrimSpace(localProviderAddr) {
			writeJSONError(w, http.StatusForbidden, "session provider mismatch", "")
			return
		}
		if len(s.Chunks) == 0 {
			writeJSONError(w, http.StatusBadRequest, "session has no recorded chunks", "fetch at least one blob chunk before submitting proofs")
			return
		}

		chunks := make([]downloadChunk, len(s.Chunks))
		copy(chunks, s.Chunks)
		sort.Slice(chunks, func(i, j int) bool {
			if chunks[i].ProofDetails.MduIndex != chunks[j].ProofDetails.MduIndex {
				return chunks[i].ProofDetails.MduIndex < chunks[j].ProofDetails.MduIndex
			}
			return chunks[i].ProofDetails.BlobIndex < chunks[j].ProofDetails.BlobIndex
		})

		seen := make(map[uint64]struct{}, len(chunks))
		for _, c := range chunks {
			key := c.ProofDetails.MduIndex*uint64(types.BLOBS_PER_MDU) + uint64(c.ProofDetails.BlobIndex)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			proofs = append(proofs, c.ProofDetails)
		}
	}

	if len(proofs) == 0 {
		writeJSONError(w, http.StatusBadRequest, "session has no usable proofs", "")
		return
	}

	msg := types.MsgSubmitRetrievalSessionProof{
		Creator:   localProviderAddr,
		SessionId: sessionIDBytes,
		Proofs:    proofs,
	}

	tmpFile, err := os.CreateTemp(uploadDir, "session-proof-v2-*.json")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create temp file", err.Error())
		return
	}
	defer os.Remove(tmpFile.Name())

	bz, err := json.Marshal(msg)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to encode session proof", err.Error())
		return
	}
	if _, err := tmpFile.Write(bz); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to write temp file", err.Error())
		return
	}
	_ = tmpFile.Close()

	txHash, err := submitTxAndWait(
		r.Context(),
		"tx", "nilchain", "submit-retrieval-proof",
		tmpFile.Name(),
		"--from", providerKeyName,
		"--chain-id", chainID,
		"--home", homeDir,
		"--keyring-backend", "test",
		"--yes",
		"--gas", "auto",
		"--gas-adjustment", "1.6",
		"--gas-prices", gasPrices,
		"--broadcast-mode", "sync",
		"--output", "json",
	)
	if err != nil {
		log.Printf("SpSubmitRetrievalSessionProof: submit failed: %v", err)
		writeJSONError(w, http.StatusInternalServerError, "submit session proof failed", err.Error())
		return
	}

	_, _ = takeDownloadSession(sessionKey)
	_ = deleteOnChainSessionProofs(sessionKey)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":      "success",
		"tx_hash":     txHash,
		"proof_count": len(proofs),
		"session_id":  sessionKey,
	})
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

