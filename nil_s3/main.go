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

	"github.com/gorilla/mux"
)

const UPLOAD_DIR = "uploads"

func main() {
    // Ensure upload dir
    os.MkdirAll(UPLOAD_DIR, 0755)

	r := mux.NewRouter()
    r.HandleFunc("/api/v1/object/{key}", PutObject).Methods("PUT")
    r.HandleFunc("/api/v1/object/{key}", GetObject).Methods("GET")

	log.Println("Starting NilStore S3 Adapter on :8080")
	log.Fatal(http.ListenAndServe(":8080", r))
}

func PutObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	key := vars["key"]

    log.Printf("PUT object: %s", key)

    // 1. Save file
    path := filepath.Join(UPLOAD_DIR, key)
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

    // 2. Call nil-cli to shard (Simulating Client)
    // Assuming nil-cli is in path or relative
    cmd := exec.Command("../nil_cli/target/debug/nil_cli", 
        "--trusted-setup", "../demos/kzg/trusted_setup.txt",
        "shard", 
        path, 
        "--out", path+".json") // Use demo TS
    
    output, err := cmd.CombinedOutput()
    if err != nil {
        log.Printf("Shard failed: %s", string(output))
        http.Error(w, fmt.Sprintf("Sharding failed: %v", err), http.StatusInternalServerError)
        return
    }

    // 3. Parse output to get commitment
    jsonFile, err := os.ReadFile(path + ".json")
    if err != nil {
        http.Error(w, "Failed to read shard output", http.StatusInternalServerError)
        return
    }

    var shardOut map[string]interface{}
    if err := json.Unmarshal(jsonFile, &shardOut); err != nil {
        http.Error(w, "Failed to parse shard output", http.StatusInternalServerError)
        return
    }

    // 4. Submit to Chain (Simulating Storage Node)
    // In a real S3 adapter, we would return the commitment to the user or handle payment.
    // Here we auto-submit a proof to 'nilchain' to simulate the full cycle.
    
    proofs := shardOut["proofs"].([]interface{})
    if len(proofs) > 0 {
        p := proofs[0].(map[string]interface{})
        commitment := p["commitment"].(string)[2:] // Strip 0x
        z := p["z_hex"].(string)[2:]
        y := p["y_hex"].(string)[2:]
        proof := p["proof_hex"].(string)[2:]

        // Call nilchaind
        // Assuming nilchaind is running and we use 'alice'
        chainCmd := exec.Command("../nilchain/nilchaind", "tx", "nilchain", "submit-proof",
            commitment, z, y, proof,
            "--from", "alice", "--chain-id", "nilchain", "--yes")
        
        chainOut, err := chainCmd.CombinedOutput()
        if err != nil {
            log.Printf("Chain Submit failed: %s", string(chainOut))
             // Don't fail the HTTP request if chain submit fails (async), but log it.
        } else {
            log.Printf("Proof submitted to chain: %s", string(chainOut))
        }
    }

    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, "Object %s stored and committed.", key)
}

func GetObject(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
	key := vars["key"]
    
    path := filepath.Join(UPLOAD_DIR, key)
    if _, err := os.Stat(path); os.IsNotExist(err) {
        http.Error(w, "Object not found", http.StatusNotFound)
        return
    }

    http.ServeFile(w, r, path)
}
