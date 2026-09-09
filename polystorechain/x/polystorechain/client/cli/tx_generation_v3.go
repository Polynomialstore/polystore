package cli

import (
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/spf13/cobra"

	"polystorechain/x/polystorechain/types"
)

func decodeV3HexFlag(cmd *cobra.Command, name string) ([]byte, error) {
	raw, err := cmd.Flags().GetString(name)
	if err != nil {
		return nil, err
	}
	b, err := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid --%s hex: %w", name, err)
	}
	return b, nil
}

func CmdProposeDealGenerationV3() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "propose-deal-generation-v3",
		Short: "Propose an inactive FAT v3 content generation for provider admission",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}
			previous, err := decodeV3HexFlag(cmd, "previous-polyfs-root")
			if err != nil {
				return err
			}
			root, err := decodeV3HexFlag(cmd, "polyfs-root")
			if err != nil {
				return err
			}
			integrity, err := decodeV3HexFlag(cmd, "integrity-root")
			if err != nil {
				return err
			}
			dealID, _ := cmd.Flags().GetUint64("deal-id")
			size, _ := cmd.Flags().GetUint64("size")
			total, _ := cmd.Flags().GetUint64("total-mdus")
			witness, _ := cmd.Flags().GetUint64("witness-mdus")
			leaves, _ := cmd.Flags().GetUint64("integrity-leaf-count")
			generation, _ := cmd.Flags().GetUint64("expected-current-generation")
			msg := &types.MsgProposeDealGenerationV3{Creator: clientCtx.GetFromAddress().String(), DealId: dealID, PreviousPolyfsRoot: previous, PolyfsRoot: root, IntegrityRoot: integrity, Size_: size, TotalMdus: total, WitnessMdus: witness, IntegrityLeafCount: leaves, ExpectedCurrentGeneration: generation}
			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), msg)
		},
	}
	cmd.Flags().Uint64("deal-id", 0, "Deal ID")
	cmd.Flags().String("previous-polyfs-root", "", "Current 32-byte PolyFS root in hex")
	cmd.Flags().String("polyfs-root", "", "Proposed 32-byte PolyFS root in hex")
	cmd.Flags().String("integrity-root", "", "Proposed 32-byte integrity root in hex")
	cmd.Flags().Uint64("size", 0, "Logical content size")
	cmd.Flags().Uint64("total-mdus", 0, "Total committed MDUs")
	cmd.Flags().Uint64("witness-mdus", 0, "Witness MDUs")
	cmd.Flags().Uint64("integrity-leaf-count", 0, "Integrity tree leaf count")
	cmd.Flags().Uint64("expected-current-generation", 0, "Current generation compare-and-swap value")
	for _, name := range []string{"deal-id", "previous-polyfs-root", "polyfs-root", "integrity-root", "size", "total-mdus", "witness-mdus", "integrity-leaf-count", "expected-current-generation"} {
		_ = cmd.MarkFlagRequired(name)
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdAcceptDealGenerationV3() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "accept-deal-generation-v3",
		Short: "Accept one frozen FAT v3 slot assignment",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}
			digest, err := decodeV3HexFlag(cmd, "acceptance-digest")
			if err != nil {
				return err
			}
			dealID, _ := cmd.Flags().GetUint64("deal-id")
			slot, _ := cmd.Flags().GetUint32("slot")
			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &types.MsgAcceptDealGenerationV3{Creator: clientCtx.GetFromAddress().String(), DealId: dealID, Slot: slot, AcceptanceDigest: digest})
		},
	}
	cmd.Flags().Uint64("deal-id", 0, "Deal ID")
	cmd.Flags().Uint32("slot", 0, "Frozen provider slot 0..11")
	cmd.Flags().String("acceptance-digest", "", "Canonical generation acceptance digest in hex")
	for _, name := range []string{"deal-id", "slot", "acceptance-digest"} {
		_ = cmd.MarkFlagRequired(name)
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdFinalizeDealGenerationV3() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "finalize-deal-generation-v3",
		Short: "Finalize a fully accepted FAT v3 generation",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}
			root, err := decodeV3HexFlag(cmd, "polyfs-root")
			if err != nil {
				return err
			}
			dealID, _ := cmd.Flags().GetUint64("deal-id")
			generation, _ := cmd.Flags().GetUint64("generation")
			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), &types.MsgFinalizeDealGenerationV3{Creator: clientCtx.GetFromAddress().String(), DealId: dealID, Generation: generation, PolyfsRoot: root})
		},
	}
	cmd.Flags().Uint64("deal-id", 0, "Deal ID")
	cmd.Flags().Uint64("generation", 0, "Proposed generation")
	cmd.Flags().String("polyfs-root", "", "Proposed 32-byte PolyFS root in hex")
	for _, name := range []string{"deal-id", "generation", "polyfs-root"} {
		_ = cmd.MarkFlagRequired(name)
	}
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}
