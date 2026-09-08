package cli

import (
	"context"
	"os"
	"sync/atomic"

	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/spf13/cobra"
)

// Opt-in gateway/CLI contract. Missing or partial output proves nothing. Only a
// returned command error before any broadcast call can write this final marker.
const submissionPhaseFlag = "submission-phase-file"
const submissionNotBroadcast = "polystore-submission-v1:not-broadcast\n"

type submissionPhase struct {
	path    string
	started atomic.Bool
}

func beginSubmissionPhase(cmd *cobra.Command) *submissionPhase {
	path, _ := cmd.Flags().GetString(submissionPhaseFlag)
	return &submissionPhase{path: path}
}

func (p *submissionPhase) finish(err *error) {
	if value := recover(); value != nil {
		panic(value) // Crashes never emit final pre-broadcast evidence.
	}
	if p.path != "" && *err != nil && !p.started.Load() {
		// A failed write leaves the caller quarantined; it cannot authorize retry.
		_ = os.WriteFile(p.path, []byte(submissionNotBroadcast), 0600)
	}
}

func (p *submissionPhase) track(ctx client.Context) (client.Context, error) {
	if p.path == "" {
		return ctx, nil
	}
	node, err := ctx.GetNode()
	if err != nil {
		return ctx, err
	}
	return ctx.WithClient(&submissionPhaseRPC{CometRPC: node, phase: p}), nil
}

type submissionPhaseRPC struct {
	client.CometRPC
	phase *submissionPhase
}

func (r *submissionPhaseRPC) BroadcastTxSync(ctx context.Context, tx cmttypes.Tx) (*coretypes.ResultBroadcastTx, error) {
	r.phase.started.Store(true)
	return r.CometRPC.BroadcastTxSync(ctx, tx)
}

func (r *submissionPhaseRPC) BroadcastTxAsync(ctx context.Context, tx cmttypes.Tx) (*coretypes.ResultBroadcastTx, error) {
	r.phase.started.Store(true)
	return r.CometRPC.BroadcastTxAsync(ctx, tx)
}

func (r *submissionPhaseRPC) BroadcastTxCommit(ctx context.Context, tx cmttypes.Tx) (*coretypes.ResultBroadcastTxCommit, error) {
	r.phase.started.Store(true)
	return r.CometRPC.BroadcastTxCommit(ctx, tx)
}
