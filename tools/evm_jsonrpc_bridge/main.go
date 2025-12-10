package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"
)

type rpcRequest struct {
	JSONRPC string            `json:"jsonrpc"`
	Method  string            `json:"method"`
	Params  []json.RawMessage `json:"params"`
	ID      interface{}       `json:"id"`
}

type rpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
	ID      interface{} `json:"id"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

var (
	lcdURL  = strings.TrimRight(env("EVM_BRIDGE_LCD", "http://localhost:1317"), "/")
	chainID = env("EVM_BRIDGE_CHAIN_ID", "0x7a69") // 31337
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleRPC)

	addr := env("EVM_BRIDGE_ADDR", ":8545")
	log.Printf("Starting EVM JSON-RPC bridge on %s (lcd=%s chainId=%s)", addr, lcdURL, chainID)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("bridge failed: %v", err)
	}
}

func handleRPC(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, nil, -32700, "invalid JSON")
		return
	}

	var result interface{}
	var err error

	switch req.Method {
	case "eth_chainId", "net_version":
		result = chainID
	case "eth_blockNumber":
		result, err = latestBlockNumber(ctx)
	case "eth_getBalance":
		result, err = getBalance(ctx, req.Params)
	case "eth_gasPrice":
		// return 1 gwei
		result = "0x3b9aca00"
	default:
		writeErr(w, req.ID, -32601, "method not implemented")
		return
	}

	if err != nil {
		writeErr(w, req.ID, -32000, err.Error())
		return
	}

	writeOK(w, req.ID, result)
}

func latestBlockNumber(ctx context.Context) (string, error) {
	type latestBlockResp struct {
		Block struct {
			Header struct {
				Height string `json:"height"`
			} `json:"header"`
		} `json:"block"`
	}
	var out latestBlockResp
	if err := httpGetJSON(ctx, lcdURL+"/cosmos/base/tendermint/v1beta1/blocks/latest", &out); err != nil {
		return "", err
	}
	h, ok := new(big.Int).SetString(out.Block.Header.Height, 10)
	if !ok {
		return "", fmt.Errorf("invalid height")
	}
	return "0x" + h.Text(16), nil
}

func getBalance(ctx context.Context, params []json.RawMessage) (string, error) {
	if len(params) < 1 {
		return "", fmt.Errorf("missing address")
	}
	var addr string
	if err := json.Unmarshal(params[0], &addr); err != nil {
		return "", fmt.Errorf("bad address")
	}
	addr = strings.TrimSpace(addr)
	if !strings.HasPrefix(addr, "0x") {
		return "", fmt.Errorf("only hex addresses supported")
	}
	// Cosmos EVM balance endpoint accepts hex address
	type balResp struct {
		Balance string `json:"balance"`
	}
	var out balResp
	if err := httpGetJSON(ctx, fmt.Sprintf("%s/cosmos/evm/vm/v1/balances/%s", lcdURL, strings.TrimPrefix(addr, "0x")), &out); err != nil {
		return "", err
	}
	val, ok := new(big.Int).SetString(out.Balance, 10)
	if !ok {
		return "", fmt.Errorf("invalid balance")
	}
	return "0x" + val.Text(16), nil
}

func httpGetJSON(ctx context.Context, url string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

func writeOK(w http.ResponseWriter, id interface{}, result interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rpcResponse{JSONRPC: "2.0", Result: result, ID: id})
}

func writeErr(w http.ResponseWriter, id interface{}, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rpcResponse{
		JSONRPC: "2.0",
		Error:   &rpcError{Code: code, Message: msg},
		ID:      id,
	})
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
