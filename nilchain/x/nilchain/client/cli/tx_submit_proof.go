package cli

import (
	"encoding/hex"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"nilchain/x/nilchain/types"
)

func CmdSubmitProof() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "submit-proof [commitment] [z] [y] [proof]",
		Short: "Submit a KZG proof",
		Args:  cobra.ExactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			commitment, err := hex.DecodeString(args[0])
			if err != nil {
				return fmt.Errorf("invalid commitment hex: %w", err)
			}
			z, err := hex.DecodeString(args[1])
			if err != nil {
				return fmt.Errorf("invalid z hex: %w", err)
			}
			y, err := hex.DecodeString(args[2])
			if err != nil {
				return fmt.Errorf("invalid y hex: %w", err)
			}
			proof, err := hex.DecodeString(args[3])
			if err != nil {
				return fmt.Errorf("invalid proof hex: %w", err)
			}

			msg := types.MsgSubmitProof{
				Creator:    clientCtx.GetFromAddress().String(),
				Commitment: commitment,
				Z:          z,
				Y:          y,
				Proof:      proof,
			}

			if err := msg.ValidateBasic(); err != nil {
				return err
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)

	return cmd
}
