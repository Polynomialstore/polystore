package keeper_test

import (
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

func TestRetrievalSessionUsesRequestedSlotWhenProviderHasMultipleAssignments(t *testing.T) {
	for _, sponsored := range []bool{false, true} {
		for _, pending := range []bool{false, true} {
			name := "owner/active"
			if sponsored {
				name = "sponsored/active"
			}
			if pending {
				name += "/earlier-pending"
			}
			t.Run(name, func(t *testing.T) {
				f, bank, server, owner, created, deal := setupRetrievalExpiryDeal(t)
				provider := deal.Mode2Slots[2].Provider
				if pending {
					deal.Mode2Slots[1].Status = types.SlotStatus_SLOT_STATUS_REPAIRING
					deal.Mode2Slots[1].PendingProvider = provider
					deal.Mode2Slots[1].RepairTargetGen = deal.CurrentGen
				} else {
					deal.Mode2Slots[1].Provider = provider
					deal.Providers[1] = provider
				}
				deal.RetrievalPolicy.Mode = types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC
				require.NoError(t, f.keeper.Deals.Set(f.ctx, deal.Id, deal))
				ctx := activateSessionFixture(t, f)
				requester := created.AssignedProviders[0]
				requesterAddr, err := sdk.AccAddressFromBech32(requester)
				require.NoError(t, err)
				bank.setAccountBalance(requesterAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 1000)))
				for index, slot := range []uint32{1, 2} {
					var opened *types.MsgOpenRetrievalSessionResponse
					if sponsored {
						response, err := server.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{
							Creator: requester, DealId: deal.Id, Provider: provider, ManifestRoot: deal.ManifestRoot,
							StartMduIndex: 2, StartBlobIndex: slot * 32, BlobCount: 1, Nonce: uint64(index + 1), ExpiresAt: 20,
							ChallengeVersion: 2, MaxTotalFee: math.NewInt(5),
						})
						require.NoError(t, err)
						opened = &types.MsgOpenRetrievalSessionResponse{SessionId: response.SessionId}
					} else {
						opened, err = server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{
							Creator: owner, DealId: deal.Id, Provider: provider, ManifestRoot: deal.ManifestRoot,
							StartMduIndex: 2, StartBlobIndex: slot * 32, BlobCount: 1, Nonce: uint64(index + 1), ExpiresAt: 20, ChallengeVersion: 2,
						})
						require.NoError(t, err)
					}
					session, err := f.keeper.RetrievalSessions.Get(ctx, opened.SessionId)
					require.NoError(t, err)
					require.Equal(t, slot, session.ChallengeSnapshot.Slot)
					require.Equal(t, provider, session.Provider)
					require.Equal(t, provider, session.AuthorizedProofProvider)
				}
			})
		}
	}
}

func TestRetrievalSessionRejectsWrongRequestedSlotBeforeBilling(t *testing.T) {
	for _, sponsored := range []bool{false, true} {
		for _, staleLegacy := range []bool{false, true} {
			name := "owner/wrong-slot"
			if sponsored {
				name = "sponsored/wrong-slot"
			}
			if staleLegacy {
				name += "/stale-legacy-provider"
			}
			t.Run(name, func(t *testing.T) {
				f, bank, server, owner, _, deal := setupRetrievalExpiryDeal(t)
				provider := deal.Mode2Slots[0].Provider
				if staleLegacy {
					// providers[] must not override an initialized canonical slot map.
					deal.Providers[2] = provider
				}
				deal.RetrievalPolicy.Mode = types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC
				require.NoError(t, f.keeper.Deals.Set(f.ctx, deal.Id, deal))
				ctx := activateSessionFixture(t, f)
				before := sessionStoreSnapshot(t, ctx, f.storeService)
				transfers := len(bank.transfers)
				var err error
				if sponsored {
					_, err = server.OpenRetrievalSessionSponsored(ctx, &types.MsgOpenRetrievalSessionSponsored{
						Creator: owner, DealId: deal.Id, Provider: provider, ManifestRoot: deal.ManifestRoot,
						StartMduIndex: 2, StartBlobIndex: 64, BlobCount: 1, Nonce: 1, ExpiresAt: 20, ChallengeVersion: 2, MaxTotalFee: math.NewInt(5),
					})
				} else {
					_, err = server.OpenRetrievalSession(ctx, &types.MsgOpenRetrievalSession{
						Creator: owner, DealId: deal.Id, Provider: provider, ManifestRoot: deal.ManifestRoot,
						StartMduIndex: 2, StartBlobIndex: 64, BlobCount: 1, Nonce: 1, ExpiresAt: 20, ChallengeVersion: 2,
					})
				}
				require.ErrorContains(t, err, "provider does not match slot")
				require.Equal(t, before, sessionStoreSnapshot(t, ctx, f.storeService))
				require.Len(t, bank.transfers, transfers)
			})
		}
	}
}
