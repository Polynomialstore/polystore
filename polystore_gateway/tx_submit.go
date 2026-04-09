package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func submitTxAndWait(ctx context.Context, args ...string) (string, error) {
	submitOut, err := runTxWithRetry(ctx, args...)
	outStr := strings.TrimSpace(string(submitOut))
	if err != nil {
		return "", fmt.Errorf("tx submission failed: %w output: %s", err, outStr)
	}

	var txRes txBroadcastResponse
	bodyJSON := extractJSONBody(submitOut)
	if bodyJSON != nil {
		if err := json.Unmarshal(bodyJSON, &txRes); err != nil {
			return "", fmt.Errorf("failed to parse tx response: %w", err)
		}
	} else {
		txRes.TxHash = extractTxHash(outStr)
	}

	if txRes.Code != 0 {
		return "", fmt.Errorf("tx failed: %s", txRes.RawLog)
	}

	txHash := strings.TrimSpace(txRes.TxHash)
	if txHash == "" {
		return "", fmt.Errorf("missing txhash in broadcast response")
	}

	// Confirm DeliverTx inclusion (sync broadcast only covers CheckTx).
	client := &http.Client{Timeout: 2 * time.Second}
	for i := 0; i < 30; i++ {
		time.Sleep(500 * time.Millisecond)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/cosmos/tx/v1beta1/txs/%s", lcdBase, txHash), nil)
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
			continue
		}

		var txResp struct {
			TxResponse struct {
				Code   uint32 `json:"code"`
				RawLog string `json:"raw_log"`
			} `json:"tx_response"`
		}
		if err := json.Unmarshal(body, &txResp); err != nil {
			continue
		}
		if txResp.TxResponse.Code != 0 {
			return "", fmt.Errorf("tx failed: %s", txResp.TxResponse.RawLog)
		}
		return txHash, nil
	}

	return "", fmt.Errorf("tx not found after broadcast: %s", txHash)
}
