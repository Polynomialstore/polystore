package keeper_test

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"os"
	"testing"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	"github.com/stretchr/testify/require"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

func mustComputeManifestCid(t *testing.T, mduRoots [][]byte) (cid string, manifestBlob []byte) {
	t.Helper()

	commitment, blob, err := crypto_ffi.ComputeManifestCommitment(mduRoots)
	require.NoError(t, err)
	return "0x" + hex.EncodeToString(commitment), blob
}

func mustDecodeHexBytes(t *testing.T, hexStr string) []byte {
	t.Helper()
	s := hexStr
	if len(s) >= 2 && s[:2] == "0x" {
		s = s[2:]
	}
	bz, err := hex.DecodeString(s)
	require.NoError(t, err)
	return bz
}

// dummyManifestCid is a syntactically valid 48-byte hex string used by tests that
// do not exercise KZG verification.
const dummyManifestCid = "0x000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f"

// Legacy alias: a number of tests use this name but only require a 48-byte hex string.
const validManifestCid = dummyManifestCid

var testProviderEndpoints = []string{"/ip4/127.0.0.1/tcp/8080/http"}

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
		Endpoints:    testProviderEndpoints,
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
			Endpoints:    testProviderEndpoints,
		}
		_, err := msgServer.RegisterProvider(f.ctx, msgReg)
		require.NoError(t, err)
	}

	// 2. Create a Deal
	userBz := []byte("user________________")
	user, _ := f.addressCodec.BytesToString(userBz)

	msg := &types.MsgCreateDeal{
		Creator:             user,
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
	require.Nil(t, deal.ManifestRoot)
	require.Equal(t, uint64(0), deal.Size_)
	require.Equal(t, user, deal.Owner)
	require.Equal(t, uint64(types.DealBaseReplication), uint64(len(deal.Providers)))

	// Verify providers are unique
	unique := make(map[string]bool)
	for _, p := range deal.Providers {
		unique[p] = true
	}
	require.Equal(t, int(types.DealBaseReplication), len(unique))
}

func TestCreateDeal_Mode2TypedState(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register providers.
	numProviders := 20
	for i := 0; i < numProviders; i++ {
		addrBz := []byte(fmt.Sprintf("provider_mode2________%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgReg := &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		}
		_, err := msgServer.RegisterProvider(f.ctx, msgReg)
		require.NoError(t, err)
	}

	userBz := []byte("user_mode2___________")
	user, _ := f.addressCodec.BytesToString(userBz)

	msg := &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      1000,
		ServiceHint:         "General:rs=8+4",
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	}

	res, err := msgServer.CreateDeal(f.ctx, msg)
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Equal(t, uint32(2), deal.RedundancyMode)
	require.NotNil(t, deal.Mode2Profile)
	require.Equal(t, uint32(8), deal.Mode2Profile.K)
	require.Equal(t, uint32(4), deal.Mode2Profile.M)
	require.Len(t, deal.Mode2Slots, int(types.DealBaseReplication))
	require.Equal(t, uint64(0), deal.CurrentGen)
	require.Equal(t, uint64(0), deal.WitnessMdus)

	for i, slot := range deal.Mode2Slots {
		require.NotNil(t, slot)
		require.Equal(t, uint32(i), slot.Slot)
		require.Equal(t, deal.Providers[i], slot.Provider)
		require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, slot.Status)
		require.Equal(t, "", slot.PendingProvider)
	}
}

func TestMode2SlotRepairLifecycle(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register providers.
	numProviders := 20
	for i := 0; i < numProviders; i++ {
		addrBz := []byte(fmt.Sprintf("provider_repair_______%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgReg := &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		}
		_, err := msgServer.RegisterProvider(f.ctx, msgReg)
		require.NoError(t, err)
	}

	userBz := []byte("user_repair__________")
	user, _ := f.addressCodec.BytesToString(userBz)

	create := &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      1000,
		ServiceHint:         "General:rs=8+4",
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	}
	res, err := msgServer.CreateDeal(f.ctx, create)
	require.NoError(t, err)

	deal, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Len(t, deal.Mode2Slots, int(types.DealBaseReplication))

	oldProvider := deal.Mode2Slots[0].Provider
	candidate := deal.Mode2Slots[1].Provider
	require.NotEqual(t, oldProvider, candidate)

	_, err = msgServer.StartSlotRepair(f.ctx, &types.MsgStartSlotRepair{
		Creator:         user,
		DealId:          res.DealId,
		Slot:            0,
		PendingProvider: candidate,
	})
	require.NoError(t, err)

	dealAfterStart, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_REPAIRING, dealAfterStart.Mode2Slots[0].Status)
	require.Equal(t, oldProvider, dealAfterStart.Mode2Slots[0].Provider)
	require.Equal(t, candidate, dealAfterStart.Mode2Slots[0].PendingProvider)
	require.Equal(t, oldProvider, dealAfterStart.Providers[0])

	_, err = msgServer.CompleteSlotRepair(f.ctx, &types.MsgCompleteSlotRepair{
		Creator: user,
		DealId:  res.DealId,
		Slot:    0,
	})
	require.NoError(t, err)

	dealAfterComplete, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Equal(t, types.SlotStatus_SLOT_STATUS_ACTIVE, dealAfterComplete.Mode2Slots[0].Status)
	require.Equal(t, candidate, dealAfterComplete.Mode2Slots[0].Provider)
	require.Equal(t, "", dealAfterComplete.Mode2Slots[0].PendingProvider)
	require.Equal(t, candidate, dealAfterComplete.Providers[0])
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
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	// Distinct sponsor (creator) and end-user owner.
	sponsorBz := []byte("sponsor_____________")
	sponsor, _ := f.addressCodec.BytesToString(sponsorBz)
	userBz := []byte("end_user____________")
	user, _ := f.addressCodec.BytesToString(userBz)

	msg := &types.MsgCreateDeal{
		Creator:        sponsor,
		DurationBlocks: 100,
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
	require.Equal(t, fmt.Sprintf("General:owner=%s", user), deal.ServiceHint, "service hint should preserve overrides")
}

// TestCreateDeal_ReplicationViaHint verifies that the requested replication
// factor can be provided via the service hint and that the keeper respects
// it (capped by DealBaseReplication and available providers).
func TestCreateDeal_ReplicationViaHint(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Register more providers than we will request.
	for i := 0; i < 10; i++ {
		addrBz := []byte(fmt.Sprintf("provider_repl______%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      addr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	userBz := []byte("user_repl___________")
	user, _ := f.addressCodec.BytesToString(userBz)

	// Request 3 replicas via the hint.
	msg := &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      100,
		ServiceHint:         "General:replicas=3",
		MaxMonthlySpend:     math.NewInt(500000),
		InitialEscrowAmount: math.NewInt(1000000),
	}

	res, err := msgServer.CreateDeal(f.ctx, msg)
	require.NoError(t, err)
	require.Equal(t, uint64(3), uint64(len(res.AssignedProviders)))

	deal, err := f.keeper.Deals.Get(f.ctx, res.DealId)
	require.NoError(t, err)
	require.Equal(t, uint64(3), deal.CurrentReplication)
	require.Equal(t, "General:replicas=3", deal.ServiceHint)
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
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)

	// Create a Deal; placement should succeed with a single assigned provider.
	userBz := []byte("user_bootstrap______")
	user, _ := f.addressCodec.BytesToString(userBz)

	msg := &types.MsgCreateDeal{
		Creator:             user,
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
	require.NoError(t, crypto_ffi.Init("../../../trusted_setup.txt"))

	// 1. Setup Deal (Need to register providers first)
	provBz := []byte("provider_for_proof__")
	provider, _ := f.addressCodec.BytesToString(provBz)

	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{Creator: provider, Capabilities: "General", TotalStorage: 1000, Endpoints: testProviderEndpoints})
	require.NoError(t, err)

	// Need enough providers for placement
	for i := 0; i < 15; i++ {
		addrBz := []byte(fmt.Sprintf("extra_prov________%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{Creator: addr, Capabilities: "General", TotalStorage: 1000, Endpoints: testProviderEndpoints})
	}

	// Create Deal
	userBz := []byte("user________________")
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator: user, DurationBlocks: 100, ServiceHint: "General",
		InitialEscrowAmount: math.NewInt(100), MaxMonthlySpend: math.NewInt(10),
	})
	require.NoError(t, err)

	// Commit Content
	cid, _ := mustComputeManifestCid(t, [][]byte{make([]byte, 32)})
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user, DealId: resDeal.DealId, Cid: cid, Size_: 100,
	})
	require.NoError(t, err)

	assignedProvider := resDeal.AssignedProviders[0]

	// 2. Submit Invalid Proof
	proofMsg := &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_SystemProof{
			SystemProof: &types.ChainedProof{
				MduIndex:        0,
				MduRootFr:       make([]byte, 32),
				ManifestOpening: make([]byte, 48),

				BlobCommitment: make([]byte, 48),
				MerklePath:     [][]byte{make([]byte, 32)},
				BlobIndex:      0,

				ZValue:          make([]byte, 32),
				YValue:          make([]byte, 32),
				KzgOpeningProof: make([]byte, 48),
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
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)

	// Register extra providers for placement
	for i := 0; i < 15; i++ {
		addrBz := []byte(fmt.Sprintf("extra_prov_happy_%02d", i))
		addr, _ := f.addressCodec.BytesToString(addrBz)
		msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{Creator: addr, Capabilities: "General", TotalStorage: 1000, Endpoints: testProviderEndpoints})
	}

	// 3. Create Deal
	userBz := []byte("user_happy_path_____")
	user, _ := f.addressCodec.BytesToString(userBz)

	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
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

	manifestCid, manifestBlob := mustComputeManifestCid(t, [][]byte{root})
	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, 0)
	require.NoError(t, err)

	// Commit Content with the real ManifestRoot commitment so VerifyChainedProof can succeed.
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user, DealId: resDeal.DealId, Cid: manifestCid, Size_: 8 * 1024 * 1024,
	})
	require.NoError(t, err)

	// Compute Proof for chunk 0
	chunkIdx := uint32(0)
	commitment, merkleProof, z, y, kzgProof, err := crypto_ffi.ComputeMduProofTest(mduData, chunkIdx)
	require.NoError(t, err)

	// Sanity: Hop2+Hop3 should verify in isolation.
	ok, err := crypto_ffi.VerifyMduProof(root, commitment, merkleProof, chunkIdx, 64, z, y, kzgProof)
	require.NoError(t, err)
	require.True(t, ok)

	// Sanity: full chained proof should verify before submitting.
	manifestCommitment := mustDecodeHexBytes(t, manifestCid)
	ok, err = crypto_ffi.VerifyChainedProof(
		manifestCommitment,
		0,
		manifestProof,
		root,
		commitment,
		uint64(chunkIdx),
		64,
		merkleProof,
		z,
		y,
		kzgProof,
	)
	require.NoError(t, err)
	require.True(t, ok)

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
			SystemProof: &types.ChainedProof{
				MduIndex:        0, // Mock
				MduRootFr:       root,
				ManifestOpening: manifestProof,

				BlobCommitment: commitment,
				MerklePath:     merklePath,
				BlobIndex:      chunkIdx,

				ZValue:          z,
				YValue:          y,
				KzgOpeningProof: kzgProof,
			},
		},
	}

	res, err := msgServer.ProveLiveness(f.ctx, proofMsg)
	require.NoError(t, err)
	require.True(t, res.Success)
	require.Equal(t, uint32(0), res.Tier) // Platinum
	t.Logf("Proof Accepted! Reward: %s", res.RewardAmount)

	// Health stub: ensure that no failures are recorded for this
	// (deal, provider) pair after a successful proof.
	_, err = f.keeper.DealProviderFailures.Get(f.ctx, collections.Join(resDeal.DealId, assignedProvider))
	require.ErrorIs(t, err, collections.ErrNotFound)
}

// TestProveLiveness_InvalidUserReceipt verifies that user-receipt proofs are
// rejected when the nonce is stale or the signature is invalid.
func TestProveLiveness_InvalidUserReceipt(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// Setup trusted setup; skip if not available.
	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping retrieval receipt tests")
	}

	// Register one provider and extras for placement.
	addrBz := []byte("provider_user_path___")
	providerAddr, _ := f.addressCodec.BytesToString(addrBz)
	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      providerAddr,
		Capabilities: "General",
		TotalStorage: 100000000000,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)
	for i := 0; i < 5; i++ {
		extraBz := []byte(fmt.Sprintf("extra_prov_user__%02d", i))
		extraAddr, _ := f.addressCodec.BytesToString(extraBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      extraAddr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	// Create a Deal owned by the provider address so that the owner account
	// exists in AccountKeeper and signature verification can be exercised.
	owner := providerAddr
	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             owner,
		DurationBlocks:      100,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(100000000),
		MaxMonthlySpend:     math.NewInt(10000000),
	})
	require.NoError(t, err)

	// Build a valid 1-MDU manifest so ProveLiveness reaches the signature checks.
	require.NoError(t, crypto_ffi.Init("../../../trusted_setup.txt"))
	mduData := make([]byte, 8*1024*1024)
	root, err := crypto_ffi.ComputeMduMerkleRoot(mduData)
	require.NoError(t, err)
	manifestCid, manifestBlob := mustComputeManifestCid(t, [][]byte{root})
	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, 0)
	require.NoError(t, err)

	chunkIdx := uint32(0)
	commitment, merkleProof, z, y, kzgProof, err := crypto_ffi.ComputeMduProofTest(mduData, chunkIdx)
	require.NoError(t, err)
	merklePath := make([][]byte, 0)
	for i := 0; i < len(merkleProof); i += 32 {
		merklePath = append(merklePath, merkleProof[i:i+32])
	}

	// Commit Content
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: owner, DealId: resDeal.DealId, Cid: manifestCid, Size_: 8 * 1024 * 1024,
	})
	require.NoError(t, err)

	assignedProvider := resDeal.AssignedProviders[0]

	// Construct a RetrievalReceipt with a bogus signature (proof is valid).
	receipt := types.RetrievalReceipt{
		DealId:      resDeal.DealId,
		EpochId:     1,
		Provider:    assignedProvider,
		BytesServed: 1024,
		FilePath:    "file.txt",
		RangeStart:  0,
		RangeLen:    1024,
		ProofDetails: types.ChainedProof{
			MduIndex:        0,
			MduRootFr:       root,
			ManifestOpening: manifestProof,
			BlobCommitment:  commitment,
			MerklePath:      merklePath,
			BlobIndex:       chunkIdx,
			ZValue:          z,
			YValue:          y,
			KzgOpeningProof: kzgProof,
		},
		UserSignature: []byte("not-a-real-signature"),
		Nonce:         1,
		ExpiresAt:     0,
	}

	// First attempt should fail on signature verification once the owner
	// account has a pubkey.
	proofMsg := &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_UserReceipt{
			UserReceipt: &receipt,
		},
	}

	_, err = msgServer.ProveLiveness(f.ctx, proofMsg)
	require.Error(t, err, "invalid retrieval receipt signature should be rejected")

	// Simulate a stored nonce, and then try to submit a receipt with a stale
	// nonce to exercise the anti-replay check.
	err = f.keeper.ReceiptNoncesByDealFile.Set(f.ctx, collections.Join(resDeal.DealId, receipt.FilePath), 5)
	require.NoError(t, err)
	receipt.Nonce = 3

	proofMsg2 := &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_UserReceipt{
			UserReceipt: &receipt,
		},
	}
	_, err = msgServer.ProveLiveness(f.ctx, proofMsg2)
	require.Error(t, err, "stale retrieval receipt nonce should be rejected")
}

func TestProveLiveness_StrictBinding(t *testing.T) {
	f := initFixture(t)
	msgServer := keeper.NewMsgServerImpl(f.keeper)

	// 1. Setup trusted setup
	os.Setenv("KZG_TRUSTED_SETUP", "../../../trusted_setup.txt")
	if _, err := os.Stat("../../../trusted_setup.txt"); os.IsNotExist(err) {
		t.Skip("trusted_setup.txt not found at ../../../trusted_setup.txt, skipping strict binding test")
	}

	// 2. Register a provider
	addrBz := []byte("provider_strict_bind_")
	providerAddr, _ := f.addressCodec.BytesToString(addrBz)
	_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
		Creator:      providerAddr,
		Capabilities: "General",
		TotalStorage: 100000000000,
		Endpoints:    testProviderEndpoints,
	})
	require.NoError(t, err)

	// Register extra providers for placement.
	for i := 0; i < 15; i++ {
		extraBz := []byte(fmt.Sprintf("extra_prov_bind_%02d", i))
		extraAddr, _ := f.addressCodec.BytesToString(extraBz)
		_, err := msgServer.RegisterProvider(f.ctx, &types.MsgRegisterProvider{
			Creator:      extraAddr,
			Capabilities: "General",
			TotalStorage: 100000000000,
			Endpoints:    testProviderEndpoints,
		})
		require.NoError(t, err)
	}

	// 3. Create a deal and commit a real ManifestRoot so VerifyChainedProof is meaningful.
	userBz := []byte("user_strict_bind_____")
	user, _ := f.addressCodec.BytesToString(userBz)
	resDeal, err := msgServer.CreateDeal(f.ctx, &types.MsgCreateDeal{
		Creator:             user,
		DurationBlocks:      100,
		ServiceHint:         "General",
		InitialEscrowAmount: math.NewInt(100000000),
		MaxMonthlySpend:     math.NewInt(10000000),
	})
	require.NoError(t, err)

	assignedProvider := resDeal.AssignedProviders[0]

	require.NoError(t, crypto_ffi.Init("../../../trusted_setup.txt"))
	mduData := make([]byte, 8*1024*1024)
	root, err := crypto_ffi.ComputeMduMerkleRoot(mduData)
	require.NoError(t, err)

	manifestCid, manifestBlob := mustComputeManifestCid(t, [][]byte{root})
	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, 0)
	require.NoError(t, err)

	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user, DealId: resDeal.DealId, Cid: manifestCid, Size_: 8 * 1024 * 1024,
	})
	require.NoError(t, err)

	chunkIdx := uint32(0)
	commitment, merkleProof, z, y, kzgProof, err := crypto_ffi.ComputeMduProofTest(mduData, chunkIdx)
	require.NoError(t, err)

	// Sanity: Hop2+Hop3 should verify in isolation.
	ok, err := crypto_ffi.VerifyMduProof(root, commitment, merkleProof, chunkIdx, 64, z, y, kzgProof)
	require.NoError(t, err)
	require.True(t, ok)

	// Sanity: full chained proof should verify before submitting.
	manifestCommitment := mustDecodeHexBytes(t, manifestCid)
	ok, err = crypto_ffi.VerifyChainedProof(
		manifestCommitment,
		0,
		manifestProof,
		root,
		commitment,
		uint64(chunkIdx),
		64,
		merkleProof,
		z,
		y,
		kzgProof,
	)
	require.NoError(t, err)
	require.True(t, ok)

	merklePath := make([][]byte, 0)
	for i := 0; i < len(merkleProof); i += 32 {
		merklePath = append(merklePath, merkleProof[i:i+32])
	}

	okMsg := &types.MsgProveLiveness{
		Creator: assignedProvider,
		DealId:  resDeal.DealId,
		EpochId: 1,
		ProofType: &types.MsgProveLiveness_SystemProof{
			SystemProof: &types.ChainedProof{
				MduIndex:        0,
				MduRootFr:       root,
				ManifestOpening: manifestProof,
				BlobCommitment:  commitment,
				MerklePath:      merklePath,
				BlobIndex:       chunkIdx,
				ZValue:          z,
				YValue:          y,
				KzgOpeningProof: kzgProof,
			},
		},
	}

	res, err := msgServer.ProveLiveness(f.ctx, okMsg)
	require.NoError(t, err)
	require.True(t, res.Success)

	deal, err := f.keeper.Deals.Get(f.ctx, resDeal.DealId)
	require.NoError(t, err)
	deal.ManifestRoot = bytes.Repeat([]byte{0x42}, 48)
	require.NoError(t, f.keeper.Deals.Set(f.ctx, resDeal.DealId, deal))

	res2, err := msgServer.ProveLiveness(f.ctx, okMsg)
	require.NoError(t, err)
	require.False(t, res2.Success)
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
			Endpoints:    testProviderEndpoints,
		}
		_, err := msgServer.RegisterProvider(f.ctx, msgReg)
		require.NoError(t, err)
	}

	// 2. Create Deal
	userBz := []byte("user_saturation_____")
	user, _ := f.addressCodec.BytesToString(userBz)
	msgDeal := &types.MsgCreateDeal{
		Creator: user, DurationBlocks: 100, ServiceHint: "General",
		InitialEscrowAmount: math.NewInt(1000), MaxMonthlySpend: math.NewInt(1000),
	}
	resDeal, err := msgServer.CreateDeal(f.ctx, msgDeal)
	require.NoError(t, err)
	dealID := resDeal.DealId

	// Commit Content
	_, err = msgServer.UpdateDealContent(f.ctx, &types.MsgUpdateDealContent{
		Creator: user, DealId: dealID, Cid: dummyManifestCid, Size_: 100,
	})
	require.NoError(t, err)

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

	// Elasticity cost should be debited from escrow and tracked in the spend window.
	params := f.keeper.GetParams(f.ctx)
	elasticityCost := math.NewIntFromUint64(params.BaseStripeCost).Mul(math.NewIntFromUint64(types.DealBaseReplication))
	require.Equal(t, math.NewInt(1000).Sub(elasticityCost), deal.EscrowBalance)
	require.Equal(t, elasticityCost, deal.SpendWindowSpent)

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
