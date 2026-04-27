package keeper_test

import (
	"context"
	"fmt"
	"testing"

	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

type mockStakingKeeper struct {
	bondDenom   string
	validators  map[string]stakingtypes.Validator
	delegations map[string]stakingtypes.Delegation
}

func newMockStakingKeeper() *mockStakingKeeper {
	return &mockStakingKeeper{
		bondDenom:   sdk.DefaultBondDenom,
		validators:  make(map[string]stakingtypes.Validator),
		delegations: make(map[string]stakingtypes.Delegation),
	}
}

func (m *mockStakingKeeper) BondDenom(context.Context) (string, error) {
	if m.bondDenom == "" {
		return sdk.DefaultBondDenom, nil
	}
	return m.bondDenom, nil
}

func (m *mockStakingKeeper) GetValidator(_ context.Context, addr sdk.ValAddress) (stakingtypes.Validator, error) {
	validator, ok := m.validators[addr.String()]
	if !ok {
		return stakingtypes.Validator{}, stakingtypes.ErrNoValidatorFound
	}
	return validator, nil
}

func (m *mockStakingKeeper) GetDelegation(_ context.Context, delAddr sdk.AccAddress, valAddr sdk.ValAddress) (stakingtypes.Delegation, error) {
	delegation, ok := m.delegations[stakingDelegationKey(delAddr, valAddr)]
	if !ok {
		return stakingtypes.Delegation{}, stakingtypes.ErrNoDelegation
	}
	return delegation, nil
}

func (m *mockStakingKeeper) setDelegation(delegator sdk.AccAddress, validator sdk.ValAddress, tokens int64, shares int64) {
	m.validators[validator.String()] = stakingtypes.Validator{
		OperatorAddress: validator.String(),
		Status:          stakingtypes.Bonded,
		Tokens:          math.NewInt(tokens),
		DelegatorShares: math.LegacyNewDec(tokens),
	}
	m.delegations[stakingDelegationKey(delegator, validator)] = stakingtypes.Delegation{
		DelegatorAddress: delegator.String(),
		ValidatorAddress: validator.String(),
		Shares:           math.LegacyNewDec(shares),
	}
}

func stakingDelegationKey(delegator sdk.AccAddress, validator sdk.ValAddress) string {
	return fmt.Sprintf("%s/%s", delegator.String(), validator.String())
}

func validatorForAccount(addr sdk.AccAddress) sdk.ValAddress {
	return sdk.ValAddress(addr.Bytes())
}

func TestProviderCanBindObservedStakeWithoutCollateralCredit(t *testing.T) {
	bank := newTrackingBankKeeper()
	staking := newMockStakingKeeper()
	f := initFixtureWithBankKeeper(t, bank)
	f.keeper.StakingKeeper = staking
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(10)

	params := types.DefaultParams()
	params.MinProviderBond = sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)
	params.AssignmentCollateralPerSlot = sdk.NewInt64Coin(sdk.DefaultBondDenom, 10)
	require.NoError(t, f.keeper.Params.Set(ctx, params))

	provider := makePolicyTestAddr(t, f, 0xA1)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	bank.setAccountBalance(providerAddr, sdk.NewCoins(sdk.NewInt64Coin(sdk.DefaultBondDenom, 100)))
	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
		Bond:         sdk.NewInt64Coin(sdk.DefaultBondDenom, 100),
	})
	require.NoError(t, err)

	validator := validatorForAccount(providerAddr)
	staking.setDelegation(providerAddr, validator, 1_000, 250)

	_, err = msgServer.BindProviderStake(ctx, &types.MsgBindProviderStake{
		Creator:   provider,
		Provider:  provider,
		Validator: validator.String(),
	})
	require.NoError(t, err)

	stakingRes, err := queryServer.GetProviderStaking(ctx, &types.QueryGetProviderStakingRequest{Provider: provider})
	require.NoError(t, err)
	require.Equal(t, provider, stakingRes.Staking.Binding.Provider)
	require.Equal(t, provider, stakingRes.Staking.Binding.Delegator)
	require.Equal(t, validator.String(), stakingRes.Staking.Binding.Validator)
	require.Equal(t, "observed_only_no_provider_slash", stakingRes.Staking.Binding.SlashSemantics)
	require.False(t, stakingRes.Staking.Binding.CountsTowardAssignmentCollateral)
	require.False(t, stakingRes.Staking.CountsTowardAssignmentCollateral)
	require.True(t, stakingRes.Staking.StakingKeeperAvailable)
	require.True(t, stakingRes.Staking.ValidatorFound)
	require.True(t, stakingRes.Staking.DelegationFound)
	require.Equal(t, "250stake", stakingRes.Staking.ObservedStake.String())
	require.Equal(t, "observed_not_slashable", stakingRes.Staking.Status)

	require.NoError(t, f.keeper.Deals.Set(ctx, 1, mode2PolicyTestDeal(1, makePolicyTestAddr(t, f, 0xEE), []string{provider})))
	collateralRes, err := queryServer.GetProviderCollateral(ctx, &types.QueryGetProviderCollateralRequest{Address: provider})
	require.NoError(t, err)
	require.Equal(t, "100stake", collateralRes.Collateral.Bond.String())
	require.Equal(t, "110stake", collateralRes.Collateral.RequiredCollateral.String())
	require.Equal(t, uint64(0), collateralRes.Collateral.AffordableAssignments)
	require.Equal(t, uint64(1), collateralRes.Collateral.OverassignedAssignments)
	require.False(t, collateralRes.Collateral.EligibleForNewAssignment)
	require.Contains(t, collateralRes.Collateral.IneligibilityReason, "below required collateral")
}

func TestPairedOperatorCanBindObservedProviderStake(t *testing.T) {
	staking := newMockStakingKeeper()
	f := initFixture(t)
	f.keeper.StakingKeeper = staking
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(20)

	provider := makePolicyTestAddr(t, f, 0xA2)
	operator := makePolicyTestAddr(t, f, 0xB3)
	thirdParty := makePolicyTestAddr(t, f, 0xC4)
	_, err := msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)
	require.NoError(t, f.keeper.ProviderPairings.Set(ctx, provider, types.ProviderPairing{
		Provider:     provider,
		Operator:     operator,
		PairedHeight: ctx.BlockHeight(),
	}))

	operatorAddr, err := sdk.AccAddressFromBech32(operator)
	require.NoError(t, err)
	validator := validatorForAccount(operatorAddr)
	staking.setDelegation(operatorAddr, validator, 500, 125)

	_, err = msgServer.BindProviderStake(ctx, &types.MsgBindProviderStake{
		Creator:   thirdParty,
		Provider:  provider,
		Validator: validator.String(),
	})
	require.Error(t, err)

	_, err = msgServer.BindProviderStake(ctx, &types.MsgBindProviderStake{
		Creator:   operator,
		Provider:  provider,
		Validator: validator.String(),
	})
	require.NoError(t, err)

	stakingRes, err := queryServer.GetProviderStaking(ctx, &types.QueryGetProviderStakingRequest{Provider: provider})
	require.NoError(t, err)
	require.Equal(t, operator, stakingRes.Staking.Binding.Delegator)
	require.Equal(t, operator, stakingRes.Staking.Binding.Operator)
	require.Equal(t, "125stake", stakingRes.Staking.ObservedStake.String())

	_, err = msgServer.UnbindProviderStake(ctx, &types.MsgUnbindProviderStake{
		Creator:  operator,
		Provider: provider,
	})
	require.NoError(t, err)
	_, err = queryServer.GetProviderStaking(ctx, &types.QueryGetProviderStakingRequest{Provider: provider})
	require.Error(t, err)
}

func TestProviderStakingSummaryHandlesMissingKeeperAndDelegation(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)
	queryServer := keeper.NewQueryServerImpl(f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(30)

	provider := makePolicyTestAddr(t, f, 0xD5)
	providerAddr, err := sdk.AccAddressFromBech32(provider)
	require.NoError(t, err)
	validator := validatorForAccount(providerAddr)
	_, err = msgServer.RegisterProvider(ctx, &types.MsgRegisterProvider{
		Creator:      provider,
		Capabilities: "General",
		TotalStorage: 1_000_000_000,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)
	_, err = msgServer.BindProviderStake(ctx, &types.MsgBindProviderStake{
		Creator:   provider,
		Provider:  provider,
		Validator: validator.String(),
	})
	require.NoError(t, err)

	res, err := queryServer.GetProviderStaking(ctx, &types.QueryGetProviderStakingRequest{Provider: provider})
	require.NoError(t, err)
	require.False(t, res.Staking.StakingKeeperAvailable)
	require.Equal(t, "staking_keeper_unavailable", res.Staking.Status)
	require.Equal(t, "0stake", res.Staking.ObservedStake.String())

	staking := newMockStakingKeeper()
	f.keeper.StakingKeeper = staking
	queryServer = keeper.NewQueryServerImpl(f.keeper)
	res, err = queryServer.GetProviderStaking(ctx, &types.QueryGetProviderStakingRequest{Provider: provider})
	require.NoError(t, err)
	require.True(t, res.Staking.StakingKeeperAvailable)
	require.False(t, res.Staking.ValidatorFound)
	require.Equal(t, "validator_not_found", res.Staking.Status)

	staking.validators[validator.String()] = stakingtypes.Validator{
		OperatorAddress: validator.String(),
		Status:          stakingtypes.Bonded,
		Tokens:          math.NewInt(500),
		DelegatorShares: math.LegacyNewDec(500),
	}
	res, err = queryServer.GetProviderStaking(ctx, &types.QueryGetProviderStakingRequest{Provider: provider})
	require.NoError(t, err)
	require.True(t, res.Staking.ValidatorFound)
	require.False(t, res.Staking.DelegationFound)
	require.Equal(t, "delegation_not_found", res.Staking.Status)
}
