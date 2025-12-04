package main

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"time"
    "encoding/json"
    "net/http"
    "encoding/hex"
    "crypto/ecdsa"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// Simple Tendermint RPC Response Structures
type BlockResponse struct {
    Result struct {
        Block struct {
            Header struct {
                Height  string `json:"height"`
                AppHash string `json:"app_hash"`
            } `json:"header"`
        } `json:"block"`
    } `json:"result"`
}

const (
    L1_RPC_URL = "http://localhost:26657"
    L2_RPC_URL = "http://127.0.0.1:8545" // Anvil
    // NOTE: This needs to be updated after deployment
    BRIDGE_CONTRACT_ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3" 
    // Private key for Anvil account #0
    PRIVATE_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
)

func main() {
    log.Println("Starting NilStore Relayer...")

    // 1. Connect to L2 (Ethereum/Anvil)
    client, err := ethclient.Dial(L2_RPC_URL)
    if err != nil {
        log.Fatalf("Failed to connect to L2: %v", err)
    }
    log.Println("Connected to L2")

    // 2. Load Private Key
    privateKey, err := crypto.HexToECDSA(PRIVATE_KEY)
    if err != nil {
        log.Fatal(err)
    }

    // 3. Bind Contract
    address := common.HexToAddress(BRIDGE_CONTRACT_ADDR)
    bridge, err := NewNilBridge(address, client)
    if err != nil {
        log.Fatalf("Failed to bind contract: %v", err)
    }

    // 4. Loop
    ticker := time.NewTicker(5 * time.Second)
    var lastHeight int64 = 0

    for range ticker.C {
        // Fetch L1 Block
        height, appHash, err := fetchL1State()
        if err != nil {
            log.Printf("Error fetching L1 state: %v", err)
            continue
        }

        if height <= lastHeight {
            continue
        }

        log.Printf("New L1 Block: %d, AppHash: %s", height, appHash)

        // Update L2
        err = updateL2(client, bridge, privateKey, height, appHash)
        if err != nil {
            log.Printf("Error updating L2: %v", err)
        } else {
            log.Printf("Successfully updated L2 with block %d", height)
            lastHeight = height
        }
    }
}

func fetchL1State() (int64, string, error) {
    resp, err := http.Get(L1_RPC_URL + "/block")
    if err != nil {
        return 0, "", err
    }
    defer resp.Body.Close()

    var res BlockResponse
    if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
        return 0, "", err
    }

    h := res.Result.Block.Header.Height
    var height int64
    fmt.Sscanf(h, "%d", &height)
    
    return height, res.Result.Block.Header.AppHash, nil
}

// ... (fetchL1State)

func updateL2(client *ethclient.Client, bridge *NilBridge, key *ecdsa.PrivateKey, height int64, appHash string) error {
    // Convert AppHash (hex) to [32]byte
    appHashBytes, err := hex.DecodeString(appHash)
    if err != nil {
        return fmt.Errorf("invalid hex: %v", err)
    }
    var root [32]byte
    copy(root[:], appHashBytes)

    // Create Auth
    chainID, err := client.NetworkID(context.Background())
    if err != nil {
        return err
    }

    auth, err := bind.NewKeyedTransactorWithChainID(key, chainID)
    if err != nil {
        return err
    }
    
    tx, err := bridge.UpdateStateRoot(auth, big.NewInt(height), root)
    if err != nil {
        return err
    }

    log.Printf("Tx Sent: %s", tx.Hash().Hex())
    return nil
}
