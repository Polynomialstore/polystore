package polystore

import (
	"bytes"
	"math/big"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

func TestRetrievalV2EVMOverloadsUseNativeAuthorityAndIDs(t *testing.T) {
	f := initFixture(t)
	p := MustNew(&f.keeper)
	ctx := sdk.UnwrapSDKContext(f.ctx).WithBlockHeight(1).WithConsensusParams(cmtproto.ConsensusParams{Block: &cmtproto.BlockParams{MaxGas: types.MaxRetrievalV2BlockGas, MaxBytes: types.MaxRetrievalV2BlockBytes}})
	params := types.DefaultParams()
	params.RetrievalV2ActivationHeight = 1
	require.NoError(t, f.keeper.Params.Set(ctx, params))
	require.NoError(t, f.keeper.BeginBlock(ctx))
	ctx = ctx.WithBlockHeight(2)
	caller := common.BytesToAddress(bytes.Repeat([]byte{0x21}, 20))
	owner := sdk.AccAddress(caller.Bytes()).String()
	assigned := sdk.AccAddress(bytes.Repeat([]byte{0x31}, 20)).String()
	deputy := sdk.AccAddress(bytes.Repeat([]byte{0x32}, 20)).String()
	for _, addr := range []string{assigned, deputy} {
		require.NoError(t, f.keeper.Providers.Set(ctx, addr, types.Provider{Address: addr, Status: "Active"}))
	}
	deal := types.Deal{Id: 7, Owner: owner, ManifestRoot: bytes.Repeat([]byte{0x42}, 32), TotalMdus: 3, WitnessMdus: 1, EndBlock: 100, Providers: []string{assigned}, EscrowBalance: math.NewInt(1000000), CurrentGen: 4, RetrievalPolicy: types.RetrievalPolicy{Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_PUBLIC}}
	require.NoError(t, f.keeper.Deals.Set(ctx, deal.Id, deal))
	methodV2 := func(name string) abi.Method {
		for _, m := range p.abi.Methods {
			if m.RawName == name && sessionVersionForMethod(&m) == 2 {
				return m
			}
		}
		t.Fatalf("missing v2 overload %s", name)
		return abi.Method{}
	}
	contract := vm.NewPrecompile(caller, Address, uint256.NewInt(0), 10000000)
	// Single open: empty payee and explicit assignment normalize to the same ID.
	method := methodV2("openRetrievalSession")
	data, err := method.Inputs.Pack(deal.Id, assigned, deal.ManifestRoot, uint64(2), uint32(0), uint64(1), uint64(1), uint64(10), "")
	require.NoError(t, err)
	require.NoError(t, validateABIAdmission(method.Inputs, data))
	out, err := p.runOpenRetrievalSession(ctx, nil, contract, &method, data)
	require.NoError(t, err)
	decoded, err := method.Outputs.Unpack(out)
	require.NoError(t, err)
	id := decoded[0].([32]byte)
	session, err := f.keeper.RetrievalSessions.Get(ctx, id[:])
	require.NoError(t, err)
	require.Equal(t, assigned, session.AuthorizedProofProvider)
	require.Equal(t, uint32(2), session.ChallengeVersion)
	legacy, err := types.HashRetrievalSessionID(caller.Bytes(), deal.Id, sdk.MustAccAddressFromBech32(assigned), deal.ManifestRoot, 2, 0, 1, 1, 10)
	require.NoError(t, err)
	expected, err := types.HashRetrievalSessionIDV2(legacy, ctx.ChainID(), sdk.MustAccAddressFromBech32(assigned))
	require.NoError(t, err)
	require.Equal(t, expected, id[:])
	// Both compute overloads and batch opens use the same effective deputy.
	input := openSessionInput{DealId: deal.Id, Provider: assigned, ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 2, ExpiresAt: 10, AuthorizedProofProvider: deputy}
	compute := methodV2("computeRetrievalSessionIds")
	packed, err := compute.Inputs.Pack([]openSessionInput{input})
	require.NoError(t, err)
	calculated, err := p.runComputeRetrievalSessionIds(ctx, nil, contract, &compute, packed)
	require.NoError(t, err)
	ids, err := compute.Outputs.Unpack(calculated)
	require.NoError(t, err)
	expectedIDs := ids[1].([][32]byte)
	batch := methodV2("openRetrievalSessions")
	packed, err = batch.Inputs.Pack([]openSessionInput{input})
	require.NoError(t, err)
	require.NoError(t, validateABIAdmission(batch.Inputs, packed))
	out, err = p.runOpenRetrievalSessions(ctx, nil, contract, &batch, packed)
	require.NoError(t, err)
	ids, err = batch.Outputs.Unpack(out)
	require.NoError(t, err)
	require.Equal(t, expectedIDs, ids[0])
	deputyID := expectedIDs[0]
	deputySession, err := f.keeper.RetrievalSessions.Get(ctx, deputyID[:])
	require.NoError(t, err)
	require.Equal(t, deputy, deputySession.AuthorizedProofProvider)
	// Sponsored open must return the native v2 ID rather than recomputing a v1 ID.
	sponsored := methodV2("openRetrievalSessionsSponsored")
	sponsorInput := openSponsoredSessionInput{DealId: deal.Id, Provider: assigned, ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: 3, ExpiresAt: 10, AuthorizedProofProvider: deputy, MaxTotalFee: big.NewInt(0)}
	packed, err = sponsored.Inputs.Pack([]openSponsoredSessionInput{sponsorInput})
	require.NoError(t, err)
	out, err = p.runOpenRetrievalSessionsSponsored(ctx, nil, contract, &sponsored, packed)
	require.NoError(t, err)
	ids, err = sponsored.Outputs.Unpack(out)
	require.NoError(t, err)
	sponsoredID := ids[0].([][32]byte)[0]
	funded, err := f.keeper.RetrievalSessions.Get(ctx, sponsoredID[:])
	require.NoError(t, err)
	require.Equal(t, deputy, funded.AuthorizedProofProvider)
	require.Equal(t, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER, funded.Funding)
	// The EVM proof route forwards caller bytes; a provider argument cannot redirect it.
	submit := p.abi.Methods["submitRetrievalSessionProof"]
	packed, err = submit.Inputs.Pack(deputyID, []sessionProofInput{{MduIndex: 2}})
	require.NoError(t, err)
	require.NoError(t, validateABIAdmission(submit.Inputs, packed))
	_, err = p.runSubmitRetrievalSessionProof(ctx, contract, &submit, packed)
	require.ErrorContains(t, err, "authorized proof provider")
	_, err = f.keeper.RetrievalSessionProofProvider.Get(ctx, deputyID[:])
	require.ErrorIs(t, err, collections.ErrNotFound)
	providerContract := vm.NewPrecompile(common.BytesToAddress(sdk.MustAccAddressFromBech32(deputy)), Address, uint256.NewInt(0), 10000000)
	_, err = p.runSubmitRetrievalSessionProof(ctx, providerContract, &submit, packed)
	require.ErrorContains(t, err, "response window")
	// Legacy selectors are preserved but admission refuses new opens after activation.
	legacyMethod := p.abi.Methods["openRetrievalSession"]
	packed, err = legacyMethod.Inputs.Pack(deal.Id, assigned, deal.ManifestRoot, uint64(2), uint32(0), uint64(1), uint64(4), uint64(10))
	require.NoError(t, err)
	_, err = p.runOpenRetrievalSession(ctx, nil, contract, &legacyMethod, packed)
	require.ErrorContains(t, err, "unsupported retrieval challenge version")
}
