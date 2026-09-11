package cli

import (
	"fmt"
	"os"

	"github.com/cosmos/cosmos-sdk/client/flags"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/spf13/cobra"

	"polystorechain/x/polystorechain/types"
)

func CmdRetrievalSessionV3() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "retrieval-session-v3 [open|open-sponsored|prove|prove-batch|ack|refund] [message.json]",
		Short: "Submit a native v3 session message using protobuf JSON",
		Long: `Submit a native v3 session message using its protobuf JSON schema:
  open           MsgOpenRetrievalSessionV3
  open-sponsored MsgOpenRetrievalSessionV3Sponsored
  prove          MsgSubmitRetrievalSessionProofV3
  prove-batch    MsgSubmitRetrievalSessionProofBatchV3
  ack            MsgAcknowledgeRetrievalObligationV3
  refund         MsgRefundRetrievalSessionV3

The JSON creator must equal --from. Encode bytes as base64 and uint64 values
as decimal strings. Use --generate-only to inspect the transaction before signing.
Example open JSON:
{"creator":"<owner-address>","deal_id":"1","generation":"2","range":{"file_record_index":1,"file_start_offset":"0","file_length":"1024","range_start":"0","range_length":"1024"},"nonce":"1","deadline_height":"100"}

The v3 protocol must be activated on the chain. Proofs and ACK digests must
match the frozen session and its committed anchor; this command does not
generate proofs or acknowledge downloaded bytes automatically.`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			phase := beginSubmissionPhase(cmd)
			defer phase.finish(&err)
			var msg sdk.Msg
			switch args[0] {
			case "open":
				msg = &types.MsgOpenRetrievalSessionV3{}
			case "open-sponsored":
				msg = &types.MsgOpenRetrievalSessionV3Sponsored{}
			case "prove":
				msg = &types.MsgSubmitRetrievalSessionProofV3{}
			case "prove-batch":
				msg = &types.MsgSubmitRetrievalSessionProofBatchV3{}
			case "ack":
				msg = &types.MsgAcknowledgeRetrievalObligationV3{}
			case "refund":
				msg = &types.MsgRefundRetrievalSessionV3{}
			default:
				return fmt.Errorf("unknown v3 session action %q", args[0])
			}
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}
			data, err := os.ReadFile(args[1])
			if err != nil {
				return err
			}
			if err := clientCtx.Codec.UnmarshalJSON(data, msg); err != nil {
				return fmt.Errorf("invalid %s message JSON: %w", args[0], err)
			}
			creator := msg.(interface{ GetCreator() string }).GetCreator()
			if creator == "" || creator != clientCtx.GetFromAddress().String() {
				return fmt.Errorf("message creator must equal --from")
			}
			clientCtx, err = phase.track(clientCtx)
			if err != nil {
				return err
			}
			return generateOrBroadcastTxCLIFn(clientCtx, cmd.Flags(), msg)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	cmd.Flags().String(submissionPhaseFlag, "", "Write a final pre-broadcast failure marker for the invoking gateway")
	return cmd
}
