package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

// Config (overridable via env)
var (
	chainID   = envDefault("NIL_CHAIN_ID", "test-1")
	homeDir   = envDefault("NIL_HOME", "../.nilchain")
	amount    = envDefault("NIL_AMOUNT", "1000000000000000000aatom,1000000stake")
	denom     = envDefault("NIL_DENOM", "stake")
	gasPrices = envDefault("NIL_GAS_PRICES", "0.001aatom")
	cooldown  = time.Duration(envInt("NIL_COOLDOWN_SECONDS", 30)) * time.Second
)

var (
	mu          sync.Mutex
	lastRequest = make(map[string]time.Time) // IP -> Time
)

type FaucetRequest struct {
	Address string `json:"address"`
}

type DealRequest struct {
	Creator         string `json:"creator"`
	Cid             string `json:"cid"`
	Size            uint64 `json:"size"`
	Duration        uint64 `json:"duration"`
	InitialEscrow   string `json:"initialEscrow"`
	MaxMonthlySpend string `json:"maxMonthlySpend"`
}

func main() {
	r := mux.NewRouter()
	r.HandleFunc("/faucet", RequestFunds).Methods("POST", "OPTIONS")
	r.HandleFunc("/create-deal", CreateDeal).Methods("POST", "OPTIONS")
	r.HandleFunc("/health", HealthCheck).Methods("GET")

	// Enable CORS
	r.Use(mux.CORSMethodMiddleware(r))

	log.Printf("Starting NilChain Faucet on :8081 (chain-id=%s, home=%s)\n", chainID, homeDir)
	log.Fatal(http.ListenAndServe(":8081", r))
}

func RequestFunds(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == "OPTIONS" {
		return
	}

	var req FaucetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	// Rate Limit (Simple IP based)
	ip := r.RemoteAddr // In prod, use X-Forwarded-For
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

	cmd := exec.Command("nilchaind", "tx", "bank", "send",
		"faucet", req.Address, amount,
		"--chain-id", chainID,
		"--yes",
		"--keyring-backend", "test",
		"--home", homeDir,
		"--gas-prices", gasPrices,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("Faucet tx failed: %s", string(output))
		http.Error(w, fmt.Sprintf("Tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("Success: %s", string(output))
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "success", "tx_hash": "check logs"})
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func CreateDeal(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == "OPTIONS" {
		return
	}

	var req DealRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	if req.Creator == "" || req.Cid == "" || req.Size == 0 || req.Duration == 0 {
		http.Error(w, "Missing fields", http.StatusBadRequest)
		return
	}

	log.Printf("CreateDeal for %s cid=%s size=%d duration=%d", req.Creator, req.Cid, req.Size, req.Duration)

	cmd := exec.Command("nilchaind", "tx", "nilchain", "create-deal",
		req.Cid,
		fmt.Sprintf("%d", req.Size),
		fmt.Sprintf("%d", req.Duration),
		req.InitialEscrow,
		req.MaxMonthlySpend,
		"--chain-id", chainID,
		"--from", "faucet",
		"--yes",
		"--keyring-backend", "test",
		"--home", homeDir,
		"--gas-prices", gasPrices,
		"--gas", "auto",
		"--gas-adjustment", "1.4",
		"--broadcast-mode", "block",
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("CreateDeal failed: %s", string(output))
		http.Error(w, fmt.Sprintf("Tx failed: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("CreateDeal success: %s", string(output))
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"tx_hash": "check faucet logs",
	})
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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
