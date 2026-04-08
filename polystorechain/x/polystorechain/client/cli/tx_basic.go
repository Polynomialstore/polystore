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
	"polystorechain/x/polystorechain/types"
)

var (
	getClientTxContextFn       = client.GetClientTxContext
	generateOrBroadcastTxCLIFn = tx.GenerateOrBroadcastTxCLI
)

func CmdRegisterProvider() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "register-provider [capabilities] [total-storage]",
		Short: "Register a new storage provider",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := getClientTxContextFn(cmd)
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

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	cmd.Flags().StringArray("endpoint", nil, "Provider endpoint multiaddr (repeatable), e.g. /dns4/host/tcp/8080/http")
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdUpdateProviderEndpoints() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "update-provider-endpoints",
		Short: "Update the registered endpoints for an existing storage provider",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := getClientTxContextFn(cmd)
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

			msg := types.MsgUpdateProviderEndpoints{
				Creator:   clientCtx.GetFromAddress().String(),
				Endpoints: endpoints,
			}

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	cmd.Flags().StringArray("endpoint", nil, "Provider endpoint multiaddr (repeatable), e.g. /dns4/host/tcp/8080/http")
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdRequestProviderLink() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "request-provider-link [operator]",
		Short: "Request linking this provider key to an operator wallet",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}

			msg := types.MsgRequestProviderLink{
				Creator:  clientCtx.GetFromAddress().String(),
				Operator: args[0],
			}

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdApproveProviderLink() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "approve-provider-link [provider]",
		Short: "Approve a pending provider link request as the operator wallet",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}

			msg := types.MsgApproveProviderLink{
				Creator:   clientCtx.GetFromAddress().String(),
				Provider:  args[0],
			}

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdCancelProviderLink() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cancel-provider-link",
		Short: "Cancel this provider key's pending provider link request",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}

			msg := types.MsgCancelProviderLink{
				Creator: clientCtx.GetFromAddress().String(),
			}

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdUnpairProvider() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "unpair-provider [provider]",
		Short: "Remove an existing provider/operator pairing",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}

			msg := types.MsgUnpairProvider{
				Creator:  clientCtx.GetFromAddress().String(),
				Provider: args[0],
			}

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdCreateDeal() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "create-deal [duration-seconds] [initial-escrow] [max-monthly-spend]",
		Short: "Create a new storage deal (allocate capacity with dynamic sizing)",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := getClientTxContextFn(cmd)
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

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	cmd.Flags().String("service-hint", "General", "Service hint for placement (e.g. General[:owner=<polystoreAddress>][:rs=K+M]). replicas-only hints are deprecated; omit rs= to auto-select Mode 2.")
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdUpdateDealContent() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "update-deal-content",
		Short: "Update/Commit content for an existing deal",
		Args:  cobra.NoArgs, // No positional arguments
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			clientCtx, err := getClientTxContextFn(cmd)
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

			totalMdus, err := cmd.Flags().GetUint64("total-mdus")
			if err != nil {
				return err
			}

			witnessMdus, err := cmd.Flags().GetUint64("witness-mdus")
			if err != nil {
				return err
			}
			previousManifestRoot, err := cmd.Flags().GetString("previous-manifest-root")
			if err != nil {
				return err
			}

			msg := types.MsgUpdateDealContent{
				Creator:              clientCtx.GetFromAddress().String(),
				DealId:               dealId,
				PreviousManifestRoot: previousManifestRoot,
				Cid:                  cid,
				Size_:                size,
				TotalMdus:            totalMdus,
				WitnessMdus:          witnessMdus,
			}

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	cmd.Flags().Uint64("deal-id", 0, "ID of the deal to update")
	cmd.Flags().String("cid", "", "New CID (manifest root) for the deal content")
	cmd.Flags().Uint64("size", 0, "New size of the content in bytes")
	cmd.Flags().Uint64("total-mdus", 0, "Total committed MDUs (metadata + witness + user)")
	cmd.Flags().Uint64("witness-mdus", 0, "Witness MDUs committed after MDU #0")
	cmd.Flags().String("previous-manifest-root", "", "Previous committed manifest root (empty on first commit)")
	_ = cmd.MarkFlagRequired("deal-id")
	_ = cmd.MarkFlagRequired("cid")
	_ = cmd.MarkFlagRequired("size")
	_ = cmd.MarkFlagRequired("total-mdus")
	_ = cmd.MarkFlagRequired("witness-mdus")
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
			clientCtx, err := getClientTxContextFn(cmd)
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

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
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
			clientCtx, err := getClientTxContextFn(cmd)
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

			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
