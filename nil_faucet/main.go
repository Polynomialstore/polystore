package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/gorilla/mux"
)

// FaucetRequest defines the structure of the incoming faucet request
type FaucetRequest struct {
	Address string `json:"address"`
}

// FaucetResponse defines the structure of the outgoing faucet response
type FaucetResponse struct {
	Message string `json:"message"`
	TxHash  string `json:"tx_hash,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Configuration for the faucet
const (
	FaucetAddress  = "nil1qg9273j99n704y66085523g8388t755e34789" // Placeholder for an actual faucet address
	FaucetKeyringBackend = "test" // Or "os" depending on setup
	ChainID        = "nilchain" // Replace with your chain ID
	Denom          = "nil" // Token denomination
	Amount         = "1000000" // 1 NIL (assuming 1_000_000 unils)
	NodeRPC        = "tcp://localhost:26657"
)

func main() {
	router := mux.NewRouter()
	router.HandleFunc("/faucet", handleFaucetRequest).Methods("POST")

	port := os.Getenv("FAUCET_PORT")
	if port == "" {
		port = "8000"
	}

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		IdleTimeout:  time.Minute,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	log.Printf("Starting Faucet server on port %s", port)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Faucet server failed: %v", err)
	}
}

func handleFaucetRequest(w http.ResponseWriter, r *http.Request) {
	var req FaucetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Address == "" {
		sendJSONError(w, "Address cannot be empty", http.StatusBadRequest)
		return
	}

	log.Printf("Received faucet request for address: %s", req.Address)

	// Construct the nilchaind command
	// Example: nilchaind tx bank send FAUCET_ADDR RECIPIENT_ADDR 1000000unil --chain-id nilchain --keyring-backend test --node tcp://localhost:26657 --broadcast-mode block --yes
	cmdArgs := []string{
		"tx", "bank", "send",
		FaucetAddress,
		req.Address,
		fmt.Sprintf("%s%s", Amount, Denom),
		"--chain-id", ChainID,
		"--keyring-backend", FaucetKeyringBackend,
		"--node", NodeRPC,
		"--broadcast-mode", "block", // Wait for inclusion in block
		"--yes", // Skip confirmation
	}

	// For debugging, print the command
	log.Printf("Executing command: nilchaind %v", cmdArgs)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "nilchaind", cmdArgs...)
	
	// Capture stderr to get error messages from nilchaind
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("nilchaind command failed: %v, output: %s", err, string(output))
		sendJSONError(w, fmt.Sprintf("Transaction failed: %s", string(output)), http.StatusInternalServerError)
		return
	}

	// Parse transaction hash from output
	// This part might need adjustment based on actual nilchaind output format
	txHash := extractTxHash(string(output))
	log.Printf("Successfully sent %s%s to %s. Tx Hash: %s", Amount, Denom, req.Address, txHash)

	sendJSONResponse(w, FaucetResponse{
		Message: fmt.Sprintf("Successfully sent %s%s to %s", Amount, Denom, req.Address),
		TxHash:  txHash,
	}, http.StatusOK)
}

func extractTxHash(output string) string {
	// This is a very basic attempt. A more robust solution would parse JSON output
	// or use regex. For a simple faucet, this might be enough if output is consistent.
	// Look for "txhash: XXXXX"
	
	// Example output for parsing:
	// "code":0,"codespace":"","data":"0A040A020801","gas_used":"59124","gas_wanted":"100000","height":"8","info":"",
	// Find "txhash" in the string.
	start := "txhash: "
	startIndex := -1
	
	// Find a JSON key if present
	if idx := findJSONKey(output, "txhash"); idx != -1 {
		startIndex = idx
	} else if idx := findJSONKey(output, "tx_hash"); idx != -1 {
		startIndex = idx
	} else if idx := findString(output, start); idx != -1 {
		startIndex = idx + len(start)
	}

	if startIndex != -1 {
		endIndex := startIndex
		for endIndex < len(output) && output[endIndex] != '\n' && output[endIndex] != '"' && output[endIndex] != ',' && output[endIndex] != ' ' {
			endIndex++
		}
		return output[startIndex:endIndex]
	}
	return "unknown"
}

func findString(s, substr string) int {
	for i := 0; i + len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

func findJSONKey(s, key string) int {
	// Crude JSON key finder
	target := fmt.Sprintf(`"%s":"`, key)
	if idx := findString(s, target); idx != -1 {
		return idx + len(target)
	}
	return -1
}


func sendJSONResponse(w http.ResponseWriter, data interface{}, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Error sending JSON response: %v", err)
	}
}

func sendJSONError(w http.ResponseWriter, message string, statusCode int) {
	sendJSONResponse(w, FaucetResponse{Error: message}, statusCode)
}
