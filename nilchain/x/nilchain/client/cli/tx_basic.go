package cli

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/spf13/cobra"

	"cosmossdk.io/math"
	"nilchain/x/nilchain/types"
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

			endpoints, err := cmd.Flags().GetStringArray("endpoint")
			if err != nil {
				return err
			}
			if len(endpoints) == 0 {
				return fmt.Errorf("at least one --endpoint multiaddr is required")
			}

			msg := types.MsgRegisterProvider{
				Creator:      clientCtx.GetFromAddress().String(),
				Capabilities: capabilities,
				TotalStorage: totalStorage,
				Endpoints:    endpoints,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	cmd.Flags().StringArray("endpoint", nil, "Provider endpoint multiaddr (repeatable), e.g. /dns4/host/tcp/8080/http")
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdCreateDeal() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "create-deal [duration] [initial-escrow] [max-monthly-spend]",
		Short: "Create a new storage deal (allocate capacity with dynamic sizing)",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			duration, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}

			initialEscrow, ok := math.NewIntFromString(args[1])
			if !ok {
				return strconv.ErrSyntax
			}
			maxMonthly, ok := math.NewIntFromString(args[2])
			if !ok {
				return strconv.ErrSyntax
			}
			hint, err := cmd.Flags().GetString("service-hint")
			if err != nil {
				return err
			}
			if hint == "" {
				hint = "General"
			}

			msg := types.MsgCreateDeal{
				Creator:             clientCtx.GetFromAddress().String(),
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

func CmdUpdateDealContent() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "update-deal-content",
		Short: "Update/Commit content for an existing deal",
		Args:  cobra.NoArgs, // No positional arguments
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := cmd.Flags().GetUint64("deal-id")
			if err != nil {
				return err
			}

			cid, err := cmd.Flags().GetString("cid")
			if err != nil {
				return err
			}

			size, err := cmd.Flags().GetUint64("size")
			if err != nil {
				return err
			}

			msg := types.MsgUpdateDealContent{
				Creator: clientCtx.GetFromAddress().String(),
				DealId:  dealId,
				Cid:     cid,
				Size_:   size,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	cmd.Flags().Uint64("deal-id", 0, "ID of the deal to update")
	cmd.Flags().String("cid", "", "New CID (manifest root) for the deal content")
	cmd.Flags().Uint64("size", 0, "New size of the content in bytes")
	_ = cmd.MarkFlagRequired("deal-id")
	_ = cmd.MarkFlagRequired("cid")
	_ = cmd.MarkFlagRequired("size")
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

// CmdCreateDealFromEvm creates a new storage deal from an EVM-signed intent.
// It expects a JSON file on disk containing:
//
//	{ "intent": { ...EvmCreateDealIntent... }, "evm_signature": "0x..." }
func CmdCreateDealFromEvm() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "create-deal-from-evm [payload-json-file]",
		Short: "Create a storage deal from an EVM-signed intent",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			path := args[0]
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}

			var payload struct {
				Intent       types.EvmCreateDealIntent `json:"intent"`
				EvmSignature string                    `json:"evm_signature"`
			}
			if err := json.Unmarshal(data, &payload); err != nil {
				return err
			}

			sig := payload.EvmSignature
			if len(sig) >= 2 && (sig[0:2] == "0x" || sig[0:2] == "0X") {
				sig = sig[2:]
			}
			sigBz, err := hex.DecodeString(sig)
			if err != nil {
				return err
			}

			msg := types.MsgCreateDealFromEvm{
				Sender:       clientCtx.GetFromAddress().String(),
				Intent:       &payload.Intent,
				EvmSignature: sigBz,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

// CmdUpdateDealContentFromEvm updates deal content from an EVM-signed intent.
func CmdUpdateDealContentFromEvm() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "update-deal-content-from-evm [payload-json-file]",
		Short: "Update deal content from an EVM-signed intent",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			path := args[0]
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}

			var payload struct {
				Intent       types.EvmUpdateContentIntent `json:"intent"`
				EvmSignature string                       `json:"evm_signature"`
			}
			if err := json.Unmarshal(data, &payload); err != nil {
				return err
			}

			sig := payload.EvmSignature
			if len(sig) >= 2 && (sig[0:2] == "0x" || sig[0:2] == "0X") {
				sig = sig[2:]
			}
			sigBz, err := hex.DecodeString(sig)
			if err != nil {
				return err
			}

			msg := types.MsgUpdateDealContentFromEvm{
				Sender:       clientCtx.GetFromAddress().String(),
				Intent:       &payload.Intent,
				EvmSignature: sigBz,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
