package keeper_test

import (
	"bytes"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

func activateLegacyMigrationFixture(t *testing.T, f *fixture) sdk.Context {
	t.Helper()
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(11).WithChainID("retrieval-migration-test").WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	params, err := f.keeper.Params.Get(ctx)
	require.NoError(t, err)
	params.EpochLenBlocks = 10
	params.RetrievalV2ActivationHeight = 11
	require.NoError(t, f.keeper.Params.Set(ctx, params))
	require.NoError(t, f.keeper.BeginBlock(ctx))
	active, err := f.keeper.RetrievalV2Active(ctx)
	require.NoError(t, err)
	require.True(t, active)
	return ctx
}

func migrationBankBalances(bank *trackingBankKeeper) map[string]string {
	balances := make(map[string]string)
	for account, coins := range bank.accountBalances {
		balances["account/"+account] = coins.String()
	}
	for module, coins := range bank.moduleBalances {
		balances["module/"+module] = coins.String()
	}
	return balances
}

func TestRetrievalV2MigrationPreservesLegacyLiabilities(t *testing.T) {
	states := []struct {
		name   string
		status types.RetrievalSessionStatus
		pin    bool
	}{
		{"open", types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN, false},
		{"user_confirmed", types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED, false},
		{"proof_submitted_pinned", types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, true},
		{"proof_submitted_missing_pin", types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED, false},
	}
	for _, funding := range []string{"deal_escrow", "unspecified_legacy_escrow", "requester", "protocol"} {
		for _, state := range states {
			t.Run(funding+"/"+state.name, func(t *testing.T) {
				var f *fixture
				var bank *trackingBankKeeper
				var server types.MsgServer
				var id []byte
				var err error
				if funding == "protocol" {
					setup := setupProtocolRepairSession(t)
					f, bank, server = setup.f, setup.bank, setup.msgServer
					opened, openErr := server.OpenProtocolRetrievalSession(setup.ctx, &types.MsgOpenProtocolRetrievalSession{
						Creator: setup.pending, DealId: setup.deal.Id, Provider: setup.active, ManifestRoot: setup.deal.ManifestRoot,
						StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 20, MaxTotalFee: math.ZeroInt(),
						Purpose: types.RetrievalSessionPurpose_RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR,
						Auth:    &types.MsgOpenProtocolRetrievalSession_Repair{Repair: &types.RepairAuth{Slot: 0}},
					})
					require.NoError(t, openErr)
					id = opened.SessionId
				} else {
					var owner string
					var created types.MsgCreateDealResponse
					var deal types.Deal
					f, bank, server, owner, created, deal = setupRetrievalExpiryDeal(t)
					ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
					if funding == "requester" {
						_, err = server.UpdateDealRetrievalPolicy(ctx, &types.MsgUpdateDealRetrievalPolicy{Creator: owner, DealId: deal.Id, Policy: types.RetrievalPolicy{Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC}})
						require.NoError(t, err)
						requester := sdk.AccAddress(bytes.Repeat([]byte{0x71}, 20))
						bank.setAccountBalance(requester, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
						opened, openErr := server.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{
							Creator: requester.String(), DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot,
							StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 20, MaxTotalFee: math.ZeroInt(),
						})
						require.NoError(t, openErr)
						id = opened.SessionId
					} else {
						opened, openErr := server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{
							Creator: owner, DealId: deal.Id, Provider: created.AssignedProviders[0], ManifestRoot: deal.ManifestRoot,
							StartMduIndex: 2, BlobCount: 1, Nonce: 1, ExpiresAt: 20,
						})
						require.NoError(t, openErr)
						id = opened.SessionId
					}
				}
				legacyCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
				session, err := f.keeper.RetrievalSessions.Get(legacyCtx, id)
				require.NoError(t, err)
				require.Zero(t, session.ChallengeVersion)
				require.True(t, session.LockedFee.IsPositive())
				if state.status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED {
					_, err = server.ConfirmRetrievalSession(legacyCtx, &types.MsgConfirmRetrievalSession{Creator: session.Owner, SessionId: id})
					require.NoError(t, err)
					session, err = f.keeper.RetrievalSessions.Get(legacyCtx, id)
					require.NoError(t, err)
				}
				// Synthetic persisted-state injection models pre-upgrade proof records,
				// including missing pins, and the original schema's omitted funding enum.
				// The fee liabilities above came from real legacy open handlers; these
				// injections do not claim historical proof transaction execution.
				session.Status = state.status
				if funding == "unspecified_legacy_escrow" {
					session.Funding = types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_UNSPECIFIED
				}
				require.NoError(t, f.keeper.RetrievalSessions.Set(legacyCtx, id, session))
				if state.pin {
					require.NoError(t, f.keeper.RetrievalSessionProofProvider.Set(legacyCtx, id, session.Provider))
				}
				dealBefore, err := f.keeper.Deals.Get(legacyCtx, session.DealId)
				require.NoError(t, err)
				balancesBefore, transfersBefore := migrationBankBalances(bank), len(bank.transfers)
				assertUnchanged := func(ctx sdk.Context) {
					t.Helper()
					after, err := f.keeper.RetrievalSessions.Get(ctx, id)
					require.NoError(t, err)
					require.Equal(t, session, after)
					dealAfter, err := f.keeper.Deals.Get(ctx, session.DealId)
					require.NoError(t, err)
					require.Equal(t, dealBefore, dealAfter)
					require.Equal(t, balancesBefore, migrationBankBalances(bank))
					require.Len(t, bank.transfers, transfersBefore)
					pin, err := f.keeper.RetrievalSessionProofProvider.Get(ctx, id)
					if state.pin {
						require.NoError(t, err)
						require.Equal(t, session.Provider, pin)
					} else {
						require.ErrorIs(t, err, collections.ErrNotFound)
					}
				}
				ctx := activateLegacyMigrationFixture(t, f)
				assertUnchanged(ctx)
				_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{Creator: session.Provider, SessionId: id, Proofs: []types.ChainedProof{{}}})
				require.ErrorContains(t, err, "expiry-refund-only")
				assertUnchanged(ctx)
				_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: session.Owner, SessionId: id})
				require.ErrorContains(t, err, "expiry-refund-only")
				assertUnchanged(ctx)
				_, err = server.CancelRetrievalSession(ctx.WithBlockHeight(20), &types.MsgCancelRetrievalSession{Creator: session.Owner, SessionId: id})
				require.ErrorContains(t, err, "not expired")
				assertUnchanged(ctx)

				ctx = ctx.WithBlockHeight(21)
				_, err = server.CancelRetrievalSession(ctx, &types.MsgCancelRetrievalSession{Creator: session.Owner, SessionId: id})
				require.NoError(t, err)
				canceled := session
				canceled.Status = types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_CANCELED
				canceled.LockedFee = math.ZeroInt()
				canceled.UpdatedHeight = ctx.BlockHeight()
				expectedTransfers := transfersBefore
				switch funding {
				case "deal_escrow", "unspecified_legacy_escrow":
					dealBefore.EscrowBalance = dealBefore.EscrowBalance.Add(session.LockedFee)
					require.Equal(t, "98", dealBefore.EscrowBalance.String(), "the burned base fee is not refundable")
				case "requester":
					balancesBefore["account/"+session.Payer] = "98stake"
					balancesBefore["module/"+types.ModuleName] = "100stake"
					expectedTransfers++
				case "protocol":
					balancesBefore["module/"+types.ProtocolBudgetModuleName] = "999stake"
					balancesBefore["module/"+types.ModuleName] = ""
					expectedTransfers++
				}
				for retry := 0; retry < 2; retry++ {
					after, err := f.keeper.RetrievalSessions.Get(ctx, id)
					require.NoError(t, err)
					require.Equal(t, canceled, after)
					dealAfter, err := f.keeper.Deals.Get(ctx, session.DealId)
					require.NoError(t, err)
					require.Equal(t, dealBefore, dealAfter)
					require.Equal(t, balancesBefore, migrationBankBalances(bank))
					require.Len(t, bank.transfers, expectedTransfers)
					_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, id)
					require.ErrorIs(t, err, collections.ErrNotFound)
					if retry == 0 {
						_, err = server.CancelRetrievalSession(ctx.WithBlockHeight(22), &types.MsgCancelRetrievalSession{Creator: session.Owner, SessionId: id})
						require.NoError(t, err)
					}
				}
				_, err = f.keeper.DealActivityStates.Get(ctx, session.DealId)
				require.ErrorIs(t, err, collections.ErrNotFound, "quarantined liabilities must not earn retrieval activity")
				_, err = f.keeper.DealProviderFailures.Get(ctx, collections.Join(session.DealId, session.Provider))
				require.ErrorIs(t, err, collections.ErrNotFound, "legacy refund must not penalize the provider")
				cases, err := f.keeper.EvidenceCases.Iterate(ctx, nil)
				require.NoError(t, err)
				defer cases.Close()
				require.False(t, cases.Valid(), "legacy refund must not create non-response evidence")
			})
		}
	}
}

func TestRetrievalV2MigrationKeepsHistoricalCompletedTerminal(t *testing.T) {
	f, bank, server, owner, created, deal := setupRetrievalExpiryDeal(t)
	legacyCtx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(5)
	// Synthetic settled pre-upgrade history, not a historical proof execution.
	// There is no outstanding fee or payee pin to recover or settle again.
	session := types.RetrievalSession{
		SessionId: bytes.Repeat([]byte{0x62}, 32), DealId: deal.Id, Owner: owner, Provider: created.AssignedProviders[0],
		ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, TotalBytes: types.BlobSizeBytes,
		Nonce: 1, ExpiresAt: 20, OpenedHeight: 3, UpdatedHeight: 5,
		Status: types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_COMPLETED, LockedFee: math.ZeroInt(),
	}
	require.NoError(t, f.keeper.RetrievalSessions.Set(legacyCtx, session.SessionId, session))
	require.NoError(t, f.keeper.RecordDealActivity(legacyCtx, deal.Id, session.TotalBytes, false))
	activity, err := f.keeper.DealActivityStates.Get(legacyCtx, deal.Id)
	require.NoError(t, err)
	bank.setAccountBalance(sdk.MustAccAddressFromBech32(session.Provider), sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 2)))
	balancesBefore, transfersBefore := migrationBankBalances(bank), len(bank.transfers)
	ctx := activateLegacyMigrationFixture(t, f)
	for _, height := range []int64{11, 20, 21} {
		ctx = ctx.WithBlockHeight(height)
		_, err = server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{Creator: session.Provider, SessionId: session.SessionId, Proofs: []types.ChainedProof{{}}})
		if height <= 20 {
			require.NoError(t, err)
		} else {
			require.ErrorContains(t, err, "expired")
		}
		_, err = server.ConfirmRetrievalSession(ctx, &types.MsgConfirmRetrievalSession{Creator: owner, SessionId: session.SessionId})
		if height <= 20 {
			require.NoError(t, err)
		} else {
			require.ErrorContains(t, err, "expired")
		}
		_, err = server.CancelRetrievalSession(ctx, &types.MsgCancelRetrievalSession{Creator: owner, SessionId: session.SessionId})
		require.NoError(t, err)
		after, err := f.keeper.RetrievalSessions.Get(ctx, session.SessionId)
		require.NoError(t, err)
		require.Equal(t, session, after)
		dealAfter, err := f.keeper.Deals.Get(ctx, deal.Id)
		require.NoError(t, err)
		require.Equal(t, deal, dealAfter)
		activityAfter, err := f.keeper.DealActivityStates.Get(ctx, deal.Id)
		require.NoError(t, err)
		require.Equal(t, activity, activityAfter)
		require.Equal(t, balancesBefore, migrationBankBalances(bank))
		require.Len(t, bank.transfers, transfersBefore)
		_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, session.SessionId)
		require.ErrorIs(t, err, collections.ErrNotFound)
	}
}
