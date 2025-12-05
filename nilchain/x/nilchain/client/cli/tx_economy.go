package cli

import (
	"strconv"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/spf13/cobra"
    "cosmossdk.io/math"

	"nilchain/x/nilchain/types"
)

func CmdSignalSaturation() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "signal-saturation [deal-id]",
		Short: "Signal that a deal's stripe is saturated and request scaling",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}

			msg := types.MsgSignalSaturation{
				Creator: clientCtx.GetFromAddress().String(),
				DealId:  dealId,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdAddCredit() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "add-credit [deal-id] [amount]",
		Short: "Add credit to a deal's escrow balance",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}
            
            amount, ok := math.NewIntFromString(args[1])
            if !ok {
                return strconv.ErrSyntax
            }

			msg := types.MsgAddCredit{
				Creator: clientCtx.GetFromAddress().String(),
				DealId:  dealId,
                Amount:  amount,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdWithdrawRewards() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "withdraw-rewards",
		Short: "Withdraw accumulated rewards",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			msg := types.MsgWithdrawRewards{
				Creator: clientCtx.GetFromAddress().String(),
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
