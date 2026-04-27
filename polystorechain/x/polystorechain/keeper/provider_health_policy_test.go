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
