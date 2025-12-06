package keeper_test

import (
	"fmt"
	"os"
	"testing"

	"cosmossdk.io/math"
	"github.com/stretchr/testify/require"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func TestRegisterProvider(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// 1. Register a valid provider
	addrBz := []byte("addr1_______________")
	creator, _ := f.addressCodec.BytesToString(addrBz)

	msg := &types.MsgRegisterProvider{
		Creator:      creator,
		Capabilities: "Archive",
		TotalStorage: 1000000000, // 1 GB
	}

	res, err := msgServer.RegisterProvider(f.ctx, msg)
	require.NoError(t, err)
	require.True(t, res.Success)

	// 2. Verify provider exists in store
	val, err := f.keeper.Providers.Get(f.ctx, creator)
	require.NoError(t, err)
	require.Equal(t, creator, val.Address)
	require.Equal(t, uint64(1000000000), val.TotalStorage)

	// 3. Duplicate registration should fail
	_, err = msgServer.RegisterProvider(f.ctx, msg)
	require.Error(t, err)
}

func TestCreateDeal(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// 1. Register multiple providers to ensure we have enough for a deal
	numProviders := 20
	for i := 0; i < numProviders; i++ {
		addrBz := []byte(fmt.Sprintf("provider____________%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgReg := &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		}
		_, err := msgServer.RegisterProvider(f.ctx, msgReg)
		require.NoError(t, err)
	}

	// 2. Create a Deal
	userBz := []byte("user________________")
	user, _ := f.addressCodec.BytesToString(userBz)

	msg := &types.MsgCreateDeal{
		Creator:             user,
		Cid:                 "bafytestcid",
		Size_:               1024 * 1024 * 100, // 100 MB
		DurationBlocks:      1000,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	}

	res, err := msgServer.CreateDeal(f.ctx, msg)
	require.NoError(t, err)
	t.Logf("Created Deal ID: %d", res.DealId)
	require.GreaterOrEqual(t, res.DealId, uint64(0))
	require.Len(t, res.AssignedProviders, int(types.DealBaseReplication)) // Should be 12

	// 3. Verify Deal in store
	deal, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Equal(t, "bafytestcid", deal.Cid)
	require.Equal(t, user, deal.Owner)
	require.Equal(t, uint64(types.DealBaseReplication), uint64(len(deal.Providers)))

	// Verify providers are unique
	unique := make(map[string]bool)
	for _, p := range deal.Providers {
		unique[p] = true
	}
	require.Equal(t, int(types.DealBaseReplication), len(unique))
}

// TestCreateDeal_UserOwnedViaHint verifies that the logical Deal owner can be
// overridden via the service hint encoding (used by the web gateway), while
// the tx signer (creator) remains a separate account (e.g. faucet/sponsor).
func TestCreateDeal_UserOwnedViaHint(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register enough providers for placement.
	for i := 0; i < int(types.DealBaseReplication); i++ {
		addrBz := []byte(fmt.Sprintf("provider_userown____%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		})
		require.NoError(t, err)
	}

	// Distinct sponsor (creator) and end-user owner.
	sponsorBz := []byte("sponsor_____________")
	sponsor, _ := f.addressCodec.BytesToString(sponsorBz)
	userBz := []byte("end_user____________")
	user, _ := f.addressCodec.BytesToString(userBz)

	msg := &types.MsgCreateDeal{
		Creator:             sponsor,
		Cid:                 "bafyuserownedcid",
		Size_:               8 * 1024 * 1024,
		DurationBlocks:      100,
		// Encode owner override into the service hint as used by the web gateway.
		ServiceHint:         fmt.Sprintf("General:owner=%s", user),
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	}

	res, err := msgServer.CreateDeal(f.ctx, msg)
	require.NoError(t, err)
	require.GreaterOrEqual(t, res.DealId, uint64(0))

	deal, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Equal(t, user, deal.Owner, "deal owner should be overridden via service hint")
	require.Equal(t, "General", deal.ServiceHint, "service hint should be normalised to base value")
}

// TestCreateDeal_BootstrapReplication verifies that on small devnets where the
// active provider set is smaller than DealBaseReplication, we still create a
// deal and cap replication at the number of available providers (bootstrap
// mode) instead of failing placement.
func TestCreateDeal_BootstrapReplication(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register a single provider.
	addrBz := []byte("single_provider_____")
	addr, _ := f.addressCodec.BytesToString(addrBz)
	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      addr,
		Capabilities: "General",
		TotalStorage: 100000000000,
	})
	require.NoError(t, err)

	// Create a Deal; placement should succeed with a single assigned provider.
	userBz := []byte("user_bootstrap______")
	user, _ := f.addressCodec.BytesToString(userBz)

	msg := &types.MsgCreateDeal{
		Creator:             user,
		Cid:                 "bafybootstrapcid",
		Size_:               8 * 1024 * 1024,
		DurationBlocks:      100,
		ServiceHint:         "General",
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	}

	res, err := msgServer.CreateDeal(f.ctx, msg)
	require.NoError(t, err)
	require.Equal(t, uint64(1), uint64(len(res.AssignedProviders)))

	deal, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(1), deal.CurrentReplication)
	require.Equal(t, 1, len(deal.Providers))
}

func TestProveLiveness_Invalid(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// 0. Setup Trusted Setup (Needed even for invalid proofs to init context)
	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping e2e kzg test")
	}

	// 1. Setup Deal (Need to register providers first)
	provBz := []byte("provider_for_proof__")
	provider, _ := f.addressCodec.BytesToString(provBz)

	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{Creator: provider, Capabilities: "General", TotalStorage: 1000})
	require.NoError(t, err)

	// Need enough providers for placement
	for i := 0; i < 15; i++ {
		addrBz := []byte(fmt.Sprintf("extra_prov________%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{Creator: addr, Capabilities: "General", TotalStorage: 1000})
	}

	// Create Deal
	userBz := []byte("user________________")
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator: user, Cid: "cid", Size_: 100, DurationBlocks: 100, ServiceHint: "General",
		InitialEscrowAmount: math.NewInt(100), MaxMonthlySpend: math.NewInt(10),
	})
	require.NoError(t, err)

	assignedProvider := resDeal.AssignedProviders[0]

	// 2. Submit Invalid Proof
	proofMsg := &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_SystemProof{
			SystemProof: &types.KzgProof{
				MduMerkleRoot:                     make([]byte, 32),
				ChallengedKzgCommitment:           make([]byte, 48),
				ChallengedKzgCommitmentMerklePath: [][]byte{make([]byte, 32)},
				ChallengedKzgCommitmentIndex:      0,
				ZValue:                            make([]byte, 32),
				YValue:                            make([]byte, 32),
				KzgOpeningProof:                   make([]byte, 48),
			},
		},
	}

	res, err := msgServer.ProveLiveness(f.ctx, proofMsg)
	require.NoError(t, err)
	require.False(t, res.Success)
}

func TestProveLiveness_HappyPath(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// 1. Setup Trusted Setup
	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping e2e kzg test")
	}

	// 2. Register Provider
	addrBz := []byte("provider_happy_path_")
	providerAddr, _ := f.addressCodec.BytesToString(addrBz)

	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      providerAddr,
		Capabilities: "General",
		TotalStorage: 100000000000,
	})
	require.NoError(t, err)

	// Register extra providers for placement
	for i := 0; i < 15; i++ {
		addrBz := []byte(fmt.Sprintf("extra_prov_happy_%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{Creator: addr, Capabilities: "General", TotalStorage: 1000})
	}

	// 3. Create Deal
	userBz := []byte("user_happy_path_____")
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		Cid:                 "bafyhappy",
		Size_:               8 * 1024 * 1024, // 8 MB (Exact MDU size)
		DurationBlocks:      1000,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(100000000),
		MaxMonthlySpend:     math.NewInt(10000000),
	})
	require.NoError(t, err)

	assignedProvider := resDeal.AssignedProviders[0]

	// 4. Generate Proof
	mduData := make([]byte, 8*1024*1024)
	// Keep data zeroed to avoid modulus overflow in simple test gen

	// Init KZG for test generation
	err = crypto_ffi.Init("../../../trusted_setup.txt")
	require.NoError(t, err)

	// Calculate Merkle Root
	root, err := crypto_ffi.ComputeMduMerkleRoot(mduData)
	require.NoError(t, err)

	// Compute Proof for chunk 0
	chunkIdx := uint32(0)
	commitment, merkleProof, z, y, kzgProof, err := crypto_ffi.ComputeMduProofTest(mduData, chunkIdx)
	require.NoError(t, err)

	// Unflatten Merkle Proof
	merklePath := make([][]byte, 0)
	for i := 0; i < len(merkleProof); i += 32 {
		merklePath = append(merklePath, merkleProof[i:i+32])
	}

	// 5. Submit Proof
	proofMsg := &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_SystemProof{
			SystemProof: &types.KzgProof{
				MduMerkleRoot:                     root,
				ChallengedKzgCommitment:           commitment,
				ChallengedKzgCommitmentMerklePath: merklePath,
				ChallengedKzgCommitmentIndex:      chunkIdx,
				ZValue:                            z,
				YValue:                            y,
				KzgOpeningProof:                   kzgProof,
			},
		},
	}

	res, err := msgServer.ProveLiveness(f.ctx, proofMsg)
	require.NoError(t, err)
	require.True(t, res.Success)
	require.Equal(t, uint32(0), res.Tier) // Platinum
	t.Logf("Proof Accepted! Reward: %s", res.RewardAmount)
}

func TestSignalSaturation(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// 1. Register Providers (Need at least 24 to simulate 2 stripes)
	numProviders := 30
	for i := 0; i < numProviders; i++ {
		addrBz := []byte(fmt.Sprintf("prov_saturation_%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgReg := &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
		}
		_, err := msgServer.RegisterProvider(f.ctx, msgReg)
		require.NoError(t, err)
	}

	// 2. Create Deal
	userBz := []byte("user_saturation_____")
	user, _ := f.addressCodec.BytesToString(userBz)
	msgDeal := &types.MsgCreateDeal{
		Creator: user, Cid: "sat_cid", Size_: 100, DurationBlocks: 100, ServiceHint: "General",
		InitialEscrowAmount: math.NewInt(1000), MaxMonthlySpend: math.NewInt(1000),
	}
	resDeal, err := msgServer.CreateDeal(f.ctx, msgDeal)
	require.NoError(t, err)
	dealID := resDeal.DealId

	// 3. Signal Saturation (Authorized)
	assignedProv := resDeal.AssignedProviders[0]
	msgSig := &types.MsgSignalSaturation{
		Creator: assignedProv,
		DealId:  dealID,
	}

	resSig, err := msgServer.SignalSaturation(f.ctx, msgSig)
	require.NoError(t, err)
	require.True(t, resSig.Success)
	require.Len(t, resSig.NewProviders, 12) // Should have added a full stripe

	// Verify Deal state updated
	deal, err := f.keeper.Deals.Get(f.ctx, dealID)
	require.NoError(t, err)
	// Base (12) + New Stripe (12) = 24
	require.Equal(t, uint64(24), deal.CurrentReplication)
	require.Len(t, deal.Providers, 24)

	// 4. Signal Saturation (Unauthorized)
	unassignedBz := []byte("unassigned_prov_____")
	unassigned, _ := f.addressCodec.BytesToString(unassignedBz)
	msgSigBad := &types.MsgSignalSaturation{
		Creator: unassigned,
		DealId:  dealID,
	}
	_, err = msgServer.SignalSaturation(f.ctx, msgSigBad)
	require.Error(t, err) // Should be unauthorized
}
