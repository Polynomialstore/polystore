package cli

import (
	"strconv"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/spf13/cobra"
    
    "nilchain/x/nilchain/types"
    "cosmossdk.io/math"
)

func CmdRegisterProvider() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "register-provider [capabilities] [total-storage]",
        Short: "Register a new storage provider",
        Args:  cobra.ExactArgs(2),
        RunE: func(cmd *cobra.Command, args []string) (err error) {
            clientCtx, err := client.GetClientTxContext(cmd)
            if err != nil {
                return err
            }

            capabilities := args[0]
            totalStorage, err := strconv.ParseUint(args[1], 10, 64)
            if err != nil {
                return err
            }

            msg := types.MsgRegisterProvider{
                Creator:      clientCtx.GetFromAddress().String(),
                Capabilities: capabilities,
                TotalStorage: totalStorage,
            }

            return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
        },
    }
    flags.AddTxFlagsToCmd(cmd)
    return cmd
}

func CmdCreateDeal() *cobra.Command {
    cmd := &cobra.Command{
        Use:   "create-deal [cid] [size] [duration] [initial-escrow] [max-monthly-spend]",
        Short: "Create a new storage deal",
        Args:  cobra.ExactArgs(5),
        RunE: func(cmd *cobra.Command, args []string) (err error) {
            clientCtx, err := client.GetClientTxContext(cmd)
            if err != nil {
                return err
            }

            cid := args[0]
            size, err := strconv.ParseUint(args[1], 10, 64)
            if err != nil { return err }
            duration, err := strconv.ParseUint(args[2], 10, 64)
            if err != nil { return err }
            
            initialEscrow, ok := math.NewIntFromString(args[3])
            if !ok { return strconv.ErrSyntax }
            maxMonthly, ok := math.NewIntFromString(args[4])
            if !ok { return strconv.ErrSyntax }
            hint, err := cmd.Flags().GetString("service-hint")
            if err != nil {
                return err
            }
            if hint == "" {
                hint = "General"
            }

            msg := types.MsgCreateDeal{
                Creator:             clientCtx.GetFromAddress().String(),
                Cid:                 cid,
                Size_:               size,
                DurationBlocks:      duration,
                ServiceHint:         hint,
                InitialEscrowAmount: initialEscrow,
                MaxMonthlySpend:     maxMonthly,
            }

            return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
        },
    }
    cmd.Flags().String("service-hint", "General", "Service hint for placement (e.g. General:owner=<nilAddress>:replicas=<N>)")
    flags.AddTxFlagsToCmd(cmd)
    return cmd
}
