package cli

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"strconv"
	"strings"
	"time"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	"github.com/spf13/cobra"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

func CmdSignRetrievalReceipt() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sign-retrieval-receipt [deal-id] [provider-addr] [epoch-id] [file-path] [trusted-setup] [manifest-path] [mdu-index]",
		Short: "Generate and sign a retrieval receipt for a downloaded file",
		Args:  cobra.ExactArgs(7),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}
			providerAddr := args[1]
			epochId, err := strconv.ParseUint(args[2], 10, 64)
			if err != nil {
				return err
			}
			filePath := args[3]
			trustedSetupPath := args[4]
			manifestPath := args[5]
			mduIndex, err := strconv.ParseUint(args[6], 10, 64)
			if err != nil {
				return err
			}

			// 1. Read File & Compute Proof
			mduBytes, err := ioutil.ReadFile(filePath)
			if err != nil {
				return err
			}

			// Verify size (mock)
			bytesServed := uint64(len(mduBytes))
			rangeStart := uint64(0)
			rangeLen := bytesServed

			if err := crypto_ffi.Init(trustedSetupPath); err != nil {
				return err
			}
			root, err := crypto_ffi.ComputeMduMerkleRoot(mduBytes)
			if err != nil {
				return err
			}
			chunkIndex := uint32(0) // Mock: always chunk 0 of MDU
			commitment, merkleProof, z, y, kzgProofBytes, err := crypto_ffi.ComputeMduProofTest(mduBytes, chunkIndex)
			if err != nil {
				return err
			}

			// Unflatten Merkle Proof
			merklePath := make([][]byte, 0)
			for i := 0; i < len(merkleProof); i += 32 {
				merklePath = append(merklePath, merkleProof[i:i+32])
			}

			// --- Hop 1: Manifest Proof ---
			// Read Manifest Blob
			manifestBlob, err := ioutil.ReadFile(manifestPath)
			if err != nil {
				return fmt.Errorf("failed to read manifest: %w", err)
			}
			if len(manifestBlob) != 131072 {
				// Try to decode if it's hex string?
				// Assuming CLI/nil_gateway passes binary temp file.
				// But nil-cli outputs hex. So nil_gateway must decode or write binary.
				// Let's assume it is binary 128KB.
				// If not, try hex decode.
			}

			manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, mduIndex)
			if err != nil {
				return fmt.Errorf("ComputeManifestProof failed: %w", err)
			}

			chainedProof := types.ChainedProof{
				MduIndex:        mduIndex,
				MduRootFr:       root,
				ManifestOpening: manifestProof,

				BlobCommitment: commitment,
				MerklePath:     merklePath,
				BlobIndex:      chunkIndex,

				ZValue:          z,
				YValue:          y,
				KzgOpeningProof: kzgProofBytes,
			}

			// 2. Prepare anti-replay fields
			// For devnet, we derive a monotonically increasing nonce from the local time.
			nonce := uint64(time.Now().UnixNano())
			var expiresAt uint64 = 0 // 0 = no expiry; chain will only enforce expiry if > 0.

			// 3. Sign Data
			// Format: DealID (8) + EpochID (8) + Provider (len) + FilePath (len) + RangeStart (8) + RangeLen (8)
			// + BytesServed (8) + Nonce (8) + ExpiresAt (8) + ProofHash (32)
			buf := make([]byte, 0)
			buf = append(buf, sdk.Uint64ToBigEndian(dealId)...)
			buf = append(buf, sdk.Uint64ToBigEndian(epochId)...)
			buf = append(buf, []byte(providerAddr)...)
			buf = append(buf, []byte(filePath)...)
			buf = append(buf, sdk.Uint64ToBigEndian(rangeStart)...)
			buf = append(buf, sdk.Uint64ToBigEndian(rangeLen)...)
			buf = append(buf, sdk.Uint64ToBigEndian(bytesServed)...)
			buf = append(buf, sdk.Uint64ToBigEndian(nonce)...)
			buf = append(buf, sdk.Uint64ToBigEndian(expiresAt)...)
			if proofHash, err := types.HashChainedProof(&chainedProof); err == nil {
				buf = append(buf, proofHash.Bytes()...)
			}

			// Sign with Keyring
			name := clientCtx.GetFromName()
			if name == "" {
				return fmt.Errorf("--from flag required")
			}

			sig, _, err := clientCtx.Keyring.Sign(name, buf, signing.SignMode_SIGN_MODE_DIRECT)
			if err != nil {
				return err
			}

			// 4. Construct Receipt
			receipt := types.RetrievalReceipt{
				DealId:        dealId,
				EpochId:       epochId,
				Provider:      providerAddr,
				FilePath:      filePath,
				RangeStart:    rangeStart,
				RangeLen:      rangeLen,
				BytesServed:   bytesServed,
				ProofDetails:  chainedProof,
				UserSignature: sig,
				Nonce:         nonce,
				ExpiresAt:     expiresAt,
			}

			// 5. Output JSON
			bz, err := json.MarshalIndent(receipt, "", "  ")
			if err != nil {
				return err
			}

			fmt.Println(string(bz))

			// Optionally write to file if flag provided?
			// For now, stdout is fine or user redirects.
			return nil
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdSubmitRetrievalProof() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "submit-retrieval-proof [receipt-json-file]",
		Short: "Submit a signed retrieval receipt (or batch/session proof) as proof of liveness",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			receiptPath := args[0]
			bz, err := ioutil.ReadFile(receiptPath)
			if err != nil {
				return err
			}

			var obj map[string]json.RawMessage
			if err := json.Unmarshal(bz, &obj); err != nil {
				return err
			}

			creator := clientCtx.GetFromAddress().String()

			// Dispatch based on top-level fields:
			// - { "session_receipt": ..., "chunks": [...] } -> RetrievalSessionProof
			// - { "session_id": ..., "proofs": [...] } -> MsgSubmitRetrievalSessionProof
			// - { "receipts": [...] } -> RetrievalReceiptBatch
			// - otherwise -> RetrievalReceipt
			if _, ok := obj["session_receipt"]; ok {
				var session types.RetrievalSessionProof
				if err := json.Unmarshal(bz, &session); err != nil {
					return err
				}
				msg := types.MsgProveLiveness{
					Creator: creator,
					DealId:  session.SessionReceipt.DealId,
					EpochId: session.SessionReceipt.EpochId,
					ProofType: &types.MsgProveLiveness_SessionProof{
						SessionProof: &session,
					},
				}
				return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
			}

			if _, ok := obj["session_id"]; ok {
				var sp types.MsgSubmitRetrievalSessionProof
				if err := json.Unmarshal(bz, &sp); err != nil {
					return err
				}
				sp.Creator = creator
				return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &sp)
			}

			if _, ok := obj["receipts"]; ok {
				var batch types.RetrievalReceiptBatch
				if err := json.Unmarshal(bz, &batch); err != nil {
					return err
				}
				if len(batch.Receipts) == 0 {
					return fmt.Errorf("empty receipts batch")
				}
				dealID := batch.Receipts[0].DealId
				epochID := batch.Receipts[0].EpochId
				for i := range batch.Receipts {
					if batch.Receipts[i].DealId != dealID || batch.Receipts[i].EpochId != epochID {
						return fmt.Errorf("all receipts in batch must have same deal_id and epoch_id")
					}
				}
				msg := types.MsgProveLiveness{
					Creator: creator,
					DealId:  dealID,
					EpochId: epochID,
					ProofType: &types.MsgProveLiveness_UserReceiptBatch{
						UserReceiptBatch: &batch,
					},
				}
				return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
			}

			var receipt types.RetrievalReceipt
			if err := json.Unmarshal(bz, &receipt); err != nil {
				return err
			}
			msg := types.MsgProveLiveness{
				Creator: creator,
				DealId:  receipt.DealId,
				EpochId: receipt.EpochId,
				ProofType: &types.MsgProveLiveness_UserReceipt{
					UserReceipt: &receipt,
				},
			}
			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdOpenRetrievalSession() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "open-retrieval-session",
		Short: "Open a retrieval session for a blob range",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := cmd.Flags().GetUint64("deal-id")
			if err != nil {
				return err
			}
			provider, err := cmd.Flags().GetString("provider")
			if err != nil {
				return err
			}
			manifestHex, err := cmd.Flags().GetString("manifest-root")
			if err != nil {
				return err
			}
			manifestRoot, err := decodeHexBytes(manifestHex, 48)
			if err != nil {
				return err
			}
			startMduIndex, err := cmd.Flags().GetUint64("start-mdu-index")
			if err != nil {
				return err
			}
			startBlobIndex, err := cmd.Flags().GetUint32("start-blob-index")
			if err != nil {
				return err
			}
			blobCount, err := cmd.Flags().GetUint64("blob-count")
			if err != nil {
				return err
			}
			nonce, err := cmd.Flags().GetUint64("nonce")
			if err != nil {
				return err
			}
			if nonce == 0 && !cmd.Flags().Changed("nonce") {
				nonce = uint64(time.Now().UnixNano())
			}
			expiresAt, err := cmd.Flags().GetUint64("expires-at")
			if err != nil {
				return err
			}

			if strings.TrimSpace(provider) == "" {
				return fmt.Errorf("provider is required")
			}
			if blobCount == 0 {
				return fmt.Errorf("blob-count must be > 0")
			}

			msg := types.MsgOpenRetrievalSession{
				Creator:        clientCtx.GetFromAddress().String(),
				DealId:         dealId,
				Provider:       provider,
				ManifestRoot:   manifestRoot,
				StartMduIndex:  startMduIndex,
				StartBlobIndex: startBlobIndex,
				BlobCount:      blobCount,
				Nonce:          nonce,
				ExpiresAt:      expiresAt,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	cmd.Flags().Uint64("deal-id", 0, "Deal ID")
	cmd.Flags().String("provider", "", "Assigned provider address")
	cmd.Flags().String("manifest-root", "", "Manifest root (48-byte hex)")
	cmd.Flags().Uint64("start-mdu-index", 0, "Starting MDU index")
	cmd.Flags().Uint32("start-blob-index", 0, "Starting blob index within the MDU")
	cmd.Flags().Uint64("blob-count", 0, "Number of blobs in the retrieval range")
	cmd.Flags().Uint64("nonce", 0, "Nonce (monotonic per owner/deal/provider)")
	cmd.Flags().Uint64("expires-at", 0, "Expiry block height (0 = no expiry)")
	_ = cmd.MarkFlagRequired("deal-id")
	_ = cmd.MarkFlagRequired("provider")
	_ = cmd.MarkFlagRequired("manifest-root")
	_ = cmd.MarkFlagRequired("blob-count")
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdCancelRetrievalSession() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cancel-retrieval-session [session-id]",
		Short: "Cancel an expired retrieval session and unlock fees",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			sessionID, err := decodeSessionID(args[0])
			if err != nil {
				return err
			}

			msg := types.MsgCancelRetrievalSession{
				Creator:   clientCtx.GetFromAddress().String(),
				SessionId: sessionID,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func decodeHexBytes(value string, expectedLen int) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, fmt.Errorf("hex value is required")
	}
	raw := strings.TrimPrefix(trimmed, "0x")
	if len(raw)%2 != 0 || !isHexString(raw) {
		return nil, fmt.Errorf("invalid hex value: %s", value)
	}
	bz, err := hex.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	if expectedLen > 0 && len(bz) != expectedLen {
		return nil, fmt.Errorf("expected %d bytes, got %d", expectedLen, len(bz))
	}
	return bz, nil
}

func decodeSessionID(value string) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, fmt.Errorf("session id is required")
	}

	raw := strings.TrimPrefix(trimmed, "0x")
	if trimmed != raw || len(raw) == 64 {
		if isHexString(raw) {
			bz, err := hex.DecodeString(raw)
			if err == nil {
				if len(bz) != 32 {
					return nil, fmt.Errorf("session id must be 32 bytes")
				}
				return bz, nil
			}
		}
	}

	for _, decoder := range []func(string) ([]byte, error){
		base64.StdEncoding.DecodeString,
		base64.RawStdEncoding.DecodeString,
	} {
		if bz, err := decoder(trimmed); err == nil {
			if len(bz) != 32 {
				return nil, fmt.Errorf("session id must be 32 bytes")
			}
			return bz, nil
		}
	}

	if isHexString(raw) {
		if bz, err := hex.DecodeString(raw); err == nil {
			if len(bz) != 32 {
				return nil, fmt.Errorf("session id must be 32 bytes")
			}
			return bz, nil
		}
	}

	return nil, fmt.Errorf("invalid session id: expected hex or base64")
}

func isHexString(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}
