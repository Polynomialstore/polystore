package cli

import (
	"strconv"
    "io/ioutil"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/spf13/cobra"
    
    "nilchain/x/nilchain/types"
    "nilchain/x/crypto_ffi"
)

func CmdProveLivenessLocal() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "prove-liveness-local [deal-id] [file-path] [trusted-setup-path]",
		Short: "Compute KZG proof for a local file and submit MsgProveLiveness",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}
            
            filePath := args[1]
            trustedSetupPath := args[2]
            
            // 1. Read File (MDU)
            mduBytes, err := ioutil.ReadFile(filePath)
            if err != nil {
                return err
            }
            
            // 2. Init Crypto
            if err := crypto_ffi.Init(trustedSetupPath); err != nil {
                return err
            }
            
            // 3. Compute Root
            root, err := crypto_ffi.ComputeMduMerkleRoot(mduBytes)
            if err != nil {
                return err
            }
            
            // 4. Compute Proof for a chunk (Mocking the challenge logic: pick index 0)
            // In a real client, we would query the chain to get the challenge for the current epoch
            chunkIndex := uint32(0) 
            
            commitment, merkleProof, z, y, kzgProof, err := crypto_ffi.ComputeMduProofTest(mduBytes, chunkIndex)
            if err != nil {
                return err
            }

            // Unflatten Merkle Proof
            merklePath := make([][]byte, 0)
            for i := 0; i < len(merkleProof); i += 32 {
                merklePath = append(merklePath, merkleProof[i:i+32])
            }
            
            // 5. Construct Msg
			msg := types.MsgProveLiveness{
				Creator: clientCtx.GetFromAddress().String(),
				DealId:  dealId,
                EpochId: 1, // Placeholder
                ProofType: &types.MsgProveLiveness_SystemProof{
                    SystemProof: &types.ChainedProof{
						MduIndex:        0,    // Mock
						MduRootFr:       root, // Mock
						ManifestOpening: nil,  // Mock
                        
						BlobCommitment:  commitment,
						MerklePath:      merklePath,
						BlobIndex:       chunkIndex,
						
                        ZValue:          z,
                        YValue:          y,
                        KzgOpeningProof: kzgProof,
                    },
                },
			}

			// if err := msg.ValidateBasic(); err != nil {
			// 	return err
			// }

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)

	return cmd
}
