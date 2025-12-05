package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
    "sync"
    "time"

	"github.com/gorilla/mux"
)

// Config
const (
    CHAIN_ID = "nilchain"
    FAUCET_ADDR = "nil1..." // Placeholder, will be derived from key
    AMOUNT = "10000000token" // 10 NIL
    COOLDOWN = 24 * time.Hour
)

var (
    mu sync.Mutex
    lastRequest = make(map[string]time.Time) // IP -> Time
)

type FaucetRequest struct {
    Address string `json:"address"`
}

func main() {
	r := mux.NewRouter()
    r.HandleFunc("/faucet", RequestFunds).Methods("POST")
    r.HandleFunc("/health", HealthCheck).Methods("GET")

    // Enable CORS
    r.Use(mux.CORSMethodMiddleware(r))

	log.Println("Starting NilChain Faucet on :8081")
	log.Fatal(http.ListenAndServe(":8081", r))
}

func RequestFunds(w http.ResponseWriter, r *http.Request) {
    // CORS
    w.Header().Set("Access-Control-Allow-Origin", "*")
    w.Header().Set("Access-Control-Allow-Methods", "POST")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
    
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
        if time.Since(last) < COOLDOWN {
            mu.Unlock()
            http.Error(w, "Rate limit exceeded (24h)", http.StatusTooManyRequests)
            return
        }
    }
    lastRequest[ip] = time.Now()
    mu.Unlock()

    log.Printf("Sending funds to %s", req.Address)

    // Execute tx
    // Assumes 'faucet' key exists in the keyring of the running user/container
    cmd := exec.Command("nilchaind", "tx", "bank", "send", 
        "faucet", req.Address, AMOUNT,
        "--chain-id", CHAIN_ID, 
        "--yes", 
        "--keyring-backend", "test",
        "--home", "../.nilchain", // Assuming standard home for now
    )
    
    output, err := cmd.CombinedOutput()
    if err != nil {
        log.Printf("Faucet tx failed: %s", string(output))
        http.Error(w, fmt.Sprintf("Tx failed: %v", err), http.StatusInternalServerError)
        // Reset rate limit on failure? Maybe.
        return
    }

    log.Printf("Success: %s", string(output))
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{"status": "success", "tx_hash": "check logs"})
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}