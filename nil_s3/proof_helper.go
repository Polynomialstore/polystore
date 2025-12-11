package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// submitRetrievalProofNew submits a retrieval proof for a specific MDU.
// mduPath must point to the RAW MDU (or padded raw data).
// mduIndex is the index in the Deal Slab (0=Manifest, 1..W=Witness, W+1..=Data).
func submitRetrievalProofNew(dealID uint64, mduIndex uint64, mduPath string, manifestPath string) (string, error) {
	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")
	providerAddr, err := resolveKeyAddress(providerKeyName)
	if err != nil {
		return "", fmt.Errorf("resolveKeyAddress failed: %w", err)
	}

	dealIDStr := strconv.FormatUint(dealID, 10)
	epochStr := "1" // Default
	mduIndexStr := strconv.FormatUint(mduIndex, 10)

	// 1. Encode Target MDU
	prefix := mduPath + ".proof"
	_, err = shardFile(mduPath, false, prefix)
	if err != nil {
		return "", fmt.Errorf("failed to encode MDU for proof: %w", err)
	}
	encodedMduPath := fmt.Sprintf("%s.mdu.0.bin", prefix)
	defer os.Remove(encodedMduPath)
	defer os.Remove(prefix + ".json")

	// 2. Encode Manifest (MDU #0)
	// manifestPath points to "manifest.bin", which is the Encoded Manifest Blob.
	// So we don't need to encode or extract it. It IS the blob.
	
	manifestBlobPath := manifestPath

	// 4. Sign Receipt
	signCmd := execCommand(
		nilchaindBin,
		"tx", "nilchain", "sign-retrieval-receipt",
		dealIDStr,
		providerAddr,
		epochStr,
		encodedMduPath,
		trustedSetup,
		manifestBlobPath, // Pass the specific 128KB Blob
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

	// 5. Submit Proof
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