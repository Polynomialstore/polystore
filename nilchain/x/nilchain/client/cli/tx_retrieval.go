package cli

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"strconv"
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
				// Assuming CLI/nil_s3 passes binary temp file.
				// But nil-cli outputs hex. So nil_s3 must decode or write binary.
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
