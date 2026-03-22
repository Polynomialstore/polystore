package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

// Config (overridable via env)
var (
	chainID     = envDefault("NIL_CHAIN_ID", "test-1")
	homeDir     = envDefault("NIL_HOME", "../.nilchain")
	nodeAddr    = envDefault("NIL_NODE", "tcp://127.0.0.1:26657")
	listenAddr  = envDefault("NIL_LISTEN_ADDR", "127.0.0.1:8081")
	amount      = envDefault("NIL_AMOUNT", "1000000000000000000aatom,1000000stake")
	denom       = envDefault("NIL_DENOM", "stake")
	gasPrices   = envDefault("NIL_GAS_PRICES", "0.001aatom")
	cooldown    = time.Duration(envInt("NIL_COOLDOWN_SECONDS", 30)) * time.Second
	nilchaindBin = envDefault("NILCHAIND_BIN", "nilchaind")
	cmdTimeout   = time.Duration(envInt("NIL_CMD_TIMEOUT_SECONDS", 20)) * time.Second

	// Optional: when set, POST endpoints require X-Nil-Faucet-Auth header.
	authToken = envDefault("NIL_FAUCET_AUTH_TOKEN", "")
)

var (
	mu          sync.Mutex
	lastRequest = make(map[string]time.Time) // IP -> Time
)

type FaucetRequest struct {
	Address string `json:"address"`
}

func main() {
	r := mux.NewRouter()
	r.HandleFunc("/faucet", RequestFunds).Methods("POST", "OPTIONS")
	r.HandleFunc("/health", HealthCheck).Methods("GET")

	// Enable CORS
	r.Use(mux.CORSMethodMiddleware(r))

	log.Printf("Starting NilChain Faucet on %s (chain-id=%s, home=%s)\n", listenAddr, chainID, homeDir)
	log.Fatal(http.ListenAndServe(listenAddr, r))
}

// deriveNilchaindDir attempts to find a working directory where nilchaind
// can locate its trusted setup file via the default relative path
// "nilchain/trusted_setup.txt". This keeps faucet CLI calls reliable even when
// the faucet process runs from a subdirectory.
func deriveNilchaindDir() string {
	if root := os.Getenv("NIL_ROOT_DIR"); root != "" {
		return root
	}

	// Walk upwards from homeDir (if absolute) to find nilchain/trusted_setup.txt.
	if homeDir != "" {
		dir := homeDir
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

	// Fallback: walk up from current working directory.
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

func execNilchaind(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, nilchaindBin, args...)
	if dir := deriveNilchaindDir(); dir != "" {
		cmd.Dir = dir
	}
	return cmd
}

func RequestFunds(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == "OPTIONS" {
		return
	}
	if !authorizeRequest(w, r) {
		return
	}

	var req FaucetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	// Rate Limit (Simple IP based)
	ip := clientIP(r)
	mu.Lock()
	if last, ok := lastRequest[ip]; ok {
		if time.Since(last) < cooldown {
			mu.Unlock()
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}
	}
	lastRequest[ip] = time.Now()
	mu.Unlock()

	log.Printf("Sending funds to %s", req.Address)

	amount := envDefault("NIL_AMOUNT", "1000000000000000000aatom,1000000stake")
	log.Printf("Faucet effective amount for sending: %s", amount) // Debug log
	ctx, cancel := context.WithTimeout(r.Context(), cmdTimeout)
	defer cancel()
	cmd := execNilchaind(ctx, "tx", "bank", "send",
		"faucet", req.Address, amount,
		"--chain-id", chainID,
		"--node", nodeAddr,
		"--yes",
		"--keyring-backend", "test",
		"--home", homeDir,
		"--gas-prices", gasPrices,
	)

	output, err := cmd.CombinedOutput()
	outStr := string(output)
	if err != nil {
		log.Printf("Faucet tx failed: %s", outStr)
		http.Error(w, fmt.Sprintf("Tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	txHash := extractTxHash(outStr)
	log.Printf("Success: %s txhash=%s", outStr, txHash)
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"tx_hash": txHash,
	})
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Nil-Faucet-Auth")
}

func authorizeRequest(w http.ResponseWriter, r *http.Request) bool {
	if authToken == "" {
		return true
	}
	given := strings.TrimSpace(r.Header.Get("X-Nil-Faucet-Auth"))
	if given == "" || subtle.ConstantTimeCompare([]byte(given), []byte(authToken)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func clientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			ip := strings.TrimSpace(parts[0])
			if ip != "" {
				return ip
			}
		}
	}
	if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
		return xrip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

var txHashRe = regexp.MustCompile(`txhash:\s*([A-Fa-f0-9]+)`)

func extractTxHash(out string) string {
	// Prefer a line-based parse for robustness against formatting changes.
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

	// Fallback to regex search across the full output.
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

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	var out int
	_, err := fmt.Sscanf(strings.TrimSpace(v), "%d", &out)
	if err != nil {
		return def
	}
	return out
}
