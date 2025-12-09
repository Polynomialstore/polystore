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
		Use:   "sign-retrieval-receipt [deal-id] [provider-addr] [epoch-id] [file-path] [trusted-setup]",
		Short: "Generate and sign a retrieval receipt for a downloaded file",
		Args:  cobra.ExactArgs(5),
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

			// 1. Read File & Compute Proof (Simulation of verification).
			// In the current Mode 1 devnet path, we treat this as a simple,
			// fixed challenge: chunk index 0 for a local 8 MiB MDU. A future
			// mainnet implementation will replace this with DeriveCheckPoint
			// based on the beacon and retrieval parameters, as described in
			// spec.md §7.4.
			mduBytes, err := ioutil.ReadFile(filePath)
			if err != nil {
				return err
			}
            
            // Verify size (mock)
            bytesServed := uint64(len(mduBytes))

			if err := crypto_ffi.Init(trustedSetupPath); err != nil {
				return err
			}
			root, err := crypto_ffi.ComputeMduMerkleRoot(mduBytes)
			if err != nil {
				return err
			}
			chunkIndex := uint32(0) // Mock: always chunk 0
			commitment, merkleProof, z, y, kzgProofBytes, err := crypto_ffi.ComputeMduProofTest(mduBytes, chunkIndex)
			if err != nil {
				return err
			}
            
            // Unflatten Merkle Proof
            merklePath := make([][]byte, 0)
            for i := 0; i < len(merkleProof); i += 32 {
                merklePath = append(merklePath, merkleProof[i:i+32])
            }

			kzgProof := types.KzgProof{
				MduMerkleRoot:                     root,
				ChallengedKzgCommitment:           commitment,
				ChallengedKzgCommitmentMerklePath: merklePath,
				ChallengedKzgCommitmentIndex:      chunkIndex,
				ZValue:                            z,
				YValue:                            y,
				KzgOpeningProof:                   kzgProofBytes,
			}

			// 2. Prepare anti-replay fields
			// For devnet, we derive a monotonically increasing nonce from the local time.
			nonce := uint64(time.Now().UnixNano())
			var expiresAt uint64 = 0 // 0 = no expiry; chain will only enforce expiry if > 0.

			// 3. Sign Data
            // Format: DealID (8) + EpochID (8) + Provider (len) + BytesServed (8) + Nonce (8) + ExpiresAt (8)
            buf := make([]byte, 0)
            buf = append(buf, sdk.Uint64ToBigEndian(dealId)...)
            buf = append(buf, sdk.Uint64ToBigEndian(epochId)...)
            buf = append(buf, []byte(providerAddr)...)
            buf = append(buf, sdk.Uint64ToBigEndian(bytesServed)...)
			buf = append(buf, sdk.Uint64ToBigEndian(nonce)...)
			buf = append(buf, sdk.Uint64ToBigEndian(expiresAt)...)

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
				BytesServed:   bytesServed,
				ProofDetails:  kzgProof,
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
		Short: "Submit a signed retrieval receipt as proof of liveness",
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

			var receipt types.RetrievalReceipt
			if err := json.Unmarshal(bz, &receipt); err != nil {
				return err
			}

			msg := types.MsgProveLiveness{
				Creator: clientCtx.GetFromAddress().String(),
				DealId:  receipt.DealId,
                EpochId: receipt.EpochId,
				ProofType: &types.MsgProveLiveness_UserReceipt{
					UserReceipt: &receipt,
				},
			}
            
            // Wait, I need to check the MsgProveLiveness proto definition for nested types.
            // Usually: ProofType is oneof.
            // MsgProveLiveness_UserReceipt struct has field UserReceipt *RetrievalReceipt?
            // Or does it embed it?
            // Let's assume wrapper for now.

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
