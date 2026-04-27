package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/cosmos/cosmos-sdk/client"
	"polystorechain/x/polystorechain/types"
)

// GetTxCmd returns the transaction commands for this module
func GetTxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:                        types.ModuleName,
		Short:                      fmt.Sprintf("%s transactions subcommands", types.ModuleName),
		DisableFlagParsing:         true,
		SuggestionsMinimumDistance: 2,
		RunE:                       client.ValidateCmd,
	}

	cmd.AddCommand(CmdProveLivenessLocal())
	cmd.AddCommand(CmdProveLivenessSystem())
	cmd.AddCommand(CmdSignRetrievalReceipt())
	cmd.AddCommand(CmdSubmitRetrievalProof())
	cmd.AddCommand(CmdOpenRetrievalSession())
	cmd.AddCommand(CmdCancelRetrievalSession())
	cmd.AddCommand(CmdRegisterProvider())
	cmd.AddCommand(CmdAddProviderBond())
	cmd.AddCommand(CmdWithdrawProviderBond())
	cmd.AddCommand(CmdUpdateProviderEndpoints())
	cmd.AddCommand(CmdRequestProviderLink())
	cmd.AddCommand(CmdApproveProviderLink())
	cmd.AddCommand(CmdCancelProviderLink())
	cmd.AddCommand(CmdUnpairProvider())
	cmd.AddCommand(CmdCreateDeal())
	cmd.AddCommand(CmdUpdateDealContent())
	cmd.AddCommand(CmdCreateDealFromEvm())
	cmd.AddCommand(CmdUpdateDealContentFromEvm())
	cmd.AddCommand(CmdSignalSaturation())
	cmd.AddCommand(CmdAddCredit())
	cmd.AddCommand(CmdWithdrawRewards())
	return cmd
}
