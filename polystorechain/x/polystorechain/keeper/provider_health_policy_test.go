package keeper_test

import (
	"testing"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func TestProviderHealthEpochDecayRestoresSoftFaultLifecycle(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	params := types.DefaultParams()
	params.EpochLenBlocks = 10
	params.ProviderHealthDecayEpochs = 1
	params.ProviderHealthDecayBps = 10000
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA3)
	_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)
	require.NoError(t, f.keeper.ProviderHealthStates.Set(ctx, provider, types.ProviderHealthState{
		Provider:           provider,
		LifecycleStatus:    types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_DELINQUENT,
		Reason:             "quota_miss_repair_started",
		EvidenceClass:      types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT,
		LastEpochId:        1,
		UpdatedHeight:      1,
		SoftFaultCount:     2,
		ConsequenceCeiling: "repair and reward exclusion; no soft-fault slash by default",
	}))

	require.NoError(t, f.keeper.CheckMissedProofs(ctx.WithBlockHeight(30)))

	health, err := f.keeper.ProviderHealthStates.Get(ctx, provider)
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE, health.LifecycleStatus)
	require.Equal(t, "provider_health_decay", health.Reason)
	require.Zero(t, health.SoftFaultCount)
	require.Equal(t, types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO, health.Severity)
}

func TestProviderJailExpiresAtEpochBoundary(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1)

	params := types.DefaultParams()
	params.EpochLenBlocks = 10
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA4)
	_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)

	record, err := f.keeper.Providers.Get(ctx, provider)
	require.NoError(t, err)
	record.Status = "Jailed"
	require.NoError(t, f.keeper.Providers.Set(ctx, provider, record))
	require.NoError(t, f.keeper.ProviderJailUntil.Set(ctx, provider, 30))
	require.NoError(t, f.keeper.ProviderHealthStates.Set(ctx, provider, types.ProviderHealthState{
		Provider:           provider,
		LifecycleStatus:    types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED,
		Reason:             "hard_fault_jailed",
		EvidenceClass:      types.EvidenceClass_EVIDENCE_CLASS_CRYPTOGRAPHIC_HARD,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD,
		UpdatedHeight:      1,
		ConsequenceCeiling: "jailed until height 30",
	}))

	require.NoError(t, f.keeper.CheckMissedProofs(ctx.WithBlockHeight(30)))

	record, err = f.keeper.Providers.Get(ctx, provider)
	require.NoError(t, err)
	require.Equal(t, "Active", record.Status)
	_, err = f.keeper.ProviderJailUntil.Get(ctx, provider)
	require.ErrorIs(t, err, collections.ErrNotFound)

	health, err := f.keeper.ProviderHealthStates.Get(ctx, provider)
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE, health.LifecycleStatus)
	require.Equal(t, "provider_jail_expired", health.Reason)
	require.Equal(t, types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO, health.Severity)
}

func TestProviderJailExpiryDoesNotEarnEndingEpochBaseReward(t *testing.T) {
	bank := newTrackingBankKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	ctx2, dealID, _ := setupBaseRewardMode2Deal(t, f, bank, "rjailexp")

	deal, err := f.keeper.Deals.Get(ctx2, dealID)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, 3)
	jailedProvider := deal.Mode2Slots[0].Provider

	provider, err := f.keeper.Providers.Get(ctx2, jailedProvider)
	require.NoError(t, err)
	provider.Status = "Jailed"
	require.NoError(t, f.keeper.Providers.Set(ctx2, jailedProvider, provider))
	require.NoError(t, f.keeper.ProviderJailUntil.Set(ctx2, jailedProvider, 10))
	require.NoError(t, f.keeper.ProviderHealthStates.Set(ctx2, jailedProvider, types.ProviderHealthState{
		Provider:           jailedProvider,
		LifecycleStatus:    types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_JAILED,
		Reason:             "hard_fault_jailed",
		EvidenceClass:      types.EvidenceClass_EVIDENCE_CLASS_CRYPTOGRAPHIC_HARD,
		Severity:           types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD,
		UpdatedHeight:      2,
		ConsequenceCeiling: "jailed until height 10",
	}))

	epochID := uint64(1)
	for _, slot := range deal.Mode2Slots {
		if slot == nil {
			continue
		}
		setMode2BaseRewardCredits(t, f, ctx2, dealID, epochID, slot.Slot)
	}

	ctx10 := ctx2.WithBlockHeight(10)
	require.NoError(t, f.keeper.CheckMissedProofs(ctx10))

	requireProviderBalance(t, bank, jailedProvider, "0stake")
	requireProviderBalance(t, bank, deal.Mode2Slots[1].Provider, "42stake")
	requireProviderBalance(t, bank, deal.Mode2Slots[2].Provider, "42stake")

	provider, err = f.keeper.Providers.Get(ctx10, jailedProvider)
	require.NoError(t, err)
	require.Equal(t, "Active", provider.Status)
	_, err = f.keeper.ProviderJailUntil.Get(ctx10, jailedProvider)
	require.ErrorIs(t, err, collections.ErrNotFound)

	health, err := f.keeper.ProviderHealthStates.Get(ctx10, jailedProvider)
	require.NoError(t, err)
	require.Equal(t, types.ProviderLifecycleStatus_PROVIDER_LIFECYCLE_STATUS_ACTIVE, health.LifecycleStatus)
	require.Equal(t, "provider_jail_expired", health.Reason)
}
