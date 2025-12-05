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
    "strconv"

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

    // 2. Call nil-cli to shard (Compute CID)
    // Use absolute paths or relative to cwd
    cliPath := "../nil_cli/target/debug/nil_cli"
    tsPath := "../nilchain/trusted_setup.txt"
    outPath := path + ".json"

    cmd := exec.Command(cliPath, 
        "--trusted-setup", tsPath,
        "shard", 
        path, 
        "--out", outPath) 
    
    output, err := cmd.CombinedOutput()
    if err != nil {
        log.Printf("Shard failed: %s", string(output))
        http.Error(w, fmt.Sprintf("Sharding failed: %v", err), http.StatusInternalServerError)
        return
    }

    // 3. Parse output to get commitment (CID) and Size
    jsonFile, err := os.ReadFile(outPath)
    if err != nil {
        http.Error(w, "Failed to read shard output", http.StatusInternalServerError)
        return
    }

    var shardOut map[string]interface{}
    if err := json.Unmarshal(jsonFile, &shardOut); err != nil {
        http.Error(w, "Failed to parse shard output", http.StatusInternalServerError)
        return
    }

    cid := shardOut["du_c_root_hex"].(string)
    // Strip 0x if present (nil_cli output has 0x)
    if len(cid) > 2 && cid[0:2] == "0x" {
        cid = cid[2:]
    }
    
    sizeVal := shardOut["file_size_bytes"].(float64) // JSON numbers are float64
    size := uint64(sizeVal)
    sizeStr := strconv.FormatUint(size, 10)

    // 4. Create Deal on Chain
    // nilchaind tx nilchain create-deal [cid] [size] [duration] [hint] [max_spend] [initial_escrow]
    duration := "1000"
    hint := "Hot"
    maxSpend := "1000"
    escrow := "100"

    chainCmd := exec.Command("../nilchaind", "tx", "nilchain", "create-deal",
        cid, sizeStr, duration, hint, maxSpend, escrow,
        "--from", "user", "--chain-id", "nilchain", "--yes", "--home", "../.nilchain_elasticity") // Use elasticity home for E2E testing context or default?
    
    // Note: For a generic adapter, we shouldn't hardcode the home dir. 
    // But for the purpose of the "E2E" flow where we just ran e2e_elasticity.sh, we can point there.
    // OR we can rely on default ~/.nilchain if we run `install.sh` style.
    // Let's try to use the generic `nilchaind` from root, and assume config is there or environment variable.
    // For this demo, I'll assume `../.nilchain` (default from e2e_flow.sh) or just omit home if env is set.
    // Let's use a relative home that we know exists if we ran `e2e_elasticity.sh` previously? 
    // No, better to use a dedicated home for S3 adapter tests.
    // I'll default to `../.nilchain` which is standard.
    
    // Actually, I should probably pass the home dir as an env var or flag to the binary.
    // For now, let's hardcode `../.nilchain_s3` and ensure we setup that chain.
    
    chainOut, err := chainCmd.CombinedOutput()
    if err != nil {
        log.Printf("Create Deal failed: %s", string(chainOut))
        // Don't fail, maybe just log (async)
    } else {
        log.Printf("Deal Created: %s", string(chainOut))
    }

    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, "Object stored. CID: %s, Size: %d. Deal creation attempted.", cid, size)
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