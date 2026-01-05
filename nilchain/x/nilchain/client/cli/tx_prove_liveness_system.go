package cli

import (
	"encoding/json"
	"os"
	"strconv"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/spf13/cobra"

	"nilchain/x/nilchain/types"
)

func CmdProveLivenessSystem() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "prove-liveness-system [deal-id] [epoch-id] [proof-json-path]",
		Short: "Submit a synthetic system liveness proof (MsgProveLiveness)",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealID, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}
			epochID, err := strconv.ParseUint(args[1], 10, 64)
			if err != nil {
				return err
			}

			proofBytes, err := os.ReadFile(args[2])
			if err != nil {
				return err
			}

			var proof types.ChainedProof
			if err := json.Unmarshal(proofBytes, &proof); err != nil {
				return err
			}

			msg := types.MsgProveLiveness{
				Creator: clientCtx.GetFromAddress().String(),
				DealId:  dealID,
				EpochId: epochID,
				ProofType: &types.MsgProveLiveness_SystemProof{
					SystemProof: &proof,
				},
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

