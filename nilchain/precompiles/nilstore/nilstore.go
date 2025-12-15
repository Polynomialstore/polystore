package nilstore

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"strings"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/core/vm"
	"nilchain/x/crypto_ffi"
	nilkeeper "nilchain/x/nilchain/keeper"
	"nilchain/x/nilchain/types"
)

const AddressHex = "0x0000000000000000000000000000000000000900"

var Address = common.HexToAddress(AddressHex)

const nilstoreABIJSON = `[
  {
    "type":"function",
    "name":"createDeal",
    "stateMutability":"nonpayable",
    "inputs":[
      {"name":"durationBlocks","type":"uint64"},
      {"name":"serviceHint","type":"string"},
      {"name":"initialEscrow","type":"uint256"},
      {"name":"maxMonthlySpend","type":"uint256"}
    ],
    "outputs":[{"name":"dealId","type":"uint64"}]
  },
  {
    "type":"function",
    "name":"updateDealContent",
    "stateMutability":"nonpayable",
    "inputs":[
      {"name":"dealId","type":"uint64"},
      {"name":"manifestRoot","type":"bytes"},
      {"name":"sizeBytes","type":"uint64"}
    ],
    "outputs":[{"name":"ok","type":"bool"}]
  },
  {
    "type":"function",
    "name":"proveRetrievalBatch",
    "stateMutability":"nonpayable",
    "inputs":[
      {"name":"dealId","type":"uint64"},
      {"name":"provider","type":"string"},
      {"name":"filePath","type":"string"},
      {"name":"nonce","type":"uint64"},
      {"name":"chunks","type":"tuple[]","components":[
        {"name":"rangeStart","type":"uint64"},
        {"name":"rangeLen","type":"uint64"},
        {"name":"proof","type":"tuple","components":[
          {"name":"mduIndex","type":"uint64"},
          {"name":"mduRootFr","type":"bytes"},
          {"name":"manifestOpening","type":"bytes"},
          {"name":"blobCommitment","type":"bytes"},
          {"name":"merklePath","type":"bytes[]"},
          {"name":"blobIndex","type":"uint32"},
          {"name":"zValue","type":"bytes"},
          {"name":"yValue","type":"bytes"},
          {"name":"kzgOpeningProof","type":"bytes"}
        ]}
      ]}
    ],
    "outputs":[{"name":"ok","type":"bool"}]
  },
  {"type":"event","name":"DealCreated","inputs":[{"name":"dealId","type":"uint64","indexed":true},{"name":"owner","type":"address","indexed":true}]},
  {"type":"event","name":"DealContentUpdated","inputs":[{"name":"dealId","type":"uint64","indexed":true},{"name":"manifestRoot","type":"bytes","indexed":false},{"name":"sizeBytes","type":"uint64","indexed":false}]},
  {"type":"event","name":"RetrievalProved","inputs":[{"name":"dealId","type":"uint64","indexed":true},{"name":"owner","type":"address","indexed":true},{"name":"provider","type":"string","indexed":false},{"name":"filePath","type":"string","indexed":false},{"name":"bytesServed","type":"uint64","indexed":false},{"name":"nonce","type":"uint64","indexed":false}]}
]`

type sdkContextGetter interface {
	GetContext() sdk.Context
}

type Precompile struct {
	keeper *nilkeeper.Keeper
	abi    abi.ABI
}

func New(keeper *nilkeeper.Keeper) (*Precompile, error) {
	parsed, err := abi.JSON(strings.NewReader(nilstoreABIJSON))
	if err != nil {
		return nil, err
	}
	return &Precompile{keeper: keeper, abi: parsed}, nil
}

func MustNew(keeper *nilkeeper.Keeper) *Precompile {
	p, err := New(keeper)
	if err != nil {
		panic(err)
	}
	return p
}

func (p *Precompile) Address() common.Address { return Address }

func (p *Precompile) RequiredGas(input []byte) uint64 {
	// Conservative linear model: calldata + fixed overhead; avoids underpricing heavy FFI verification.
	const base = uint64(200_000)
	const perByte = uint64(64)
	return base + perByte*uint64(len(input))
}

func (p *Precompile) Run(evm *vm.EVM, contract *vm.Contract, readonly bool) ([]byte, error) {
	if readonly {
		return nil, errors.New("nilstore precompile: readonly calls are not supported")
	}
	if evm == nil || contract == nil {
		return nil, errors.New("nilstore precompile: missing evm/contract")
	}
	if p.keeper == nil {
		return nil, errors.New("nilstore precompile: missing keeper")
	}

	stateGetter, ok := evm.StateDB.(sdkContextGetter)
	if !ok {
		return nil, errors.New("nilstore precompile: statedb does not expose sdk context")
	}
	ctx := stateGetter.GetContext()

	input := contract.Input
	if len(input) < 4 {
		return nil, errors.New("nilstore precompile: missing selector")
	}
	method, err := p.abi.MethodById(input[:4])
	if err != nil {
		return nil, fmt.Errorf("nilstore precompile: unknown selector: %w", err)
	}

	switch method.Name {
	case "createDeal":
		return p.runCreateDeal(ctx, evm, contract, method, input[4:])
	case "updateDealContent":
		return p.runUpdateDealContent(ctx, evm, contract, method, input[4:])
	case "proveRetrievalBatch":
		return p.runProveRetrievalBatch(ctx, evm, contract, method, input[4:])
	default:
		return nil, fmt.Errorf("nilstore precompile: unsupported method %q", method.Name)
	}
}

func (p *Precompile) runCreateDeal(ctx sdk.Context, evm *vm.EVM, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	args := make(map[string]any)
	if err := method.Inputs.UnpackIntoMap(args, data); err != nil {
		return nil, fmt.Errorf("createDeal: failed to unpack args: %w", err)
	}

	duration, err := asUint64(args["durationBlocks"])
	if err != nil || duration == 0 {
		return nil, errors.New("createDeal: durationBlocks must be > 0")
	}
	serviceHint, err := asString(args["serviceHint"])
	if err != nil {
		return nil, errors.New("createDeal: invalid serviceHint")
	}
	initialEscrow, err := asMathInt(args["initialEscrow"])
	if err != nil {
		return nil, fmt.Errorf("createDeal: invalid initialEscrow: %w", err)
	}
	maxMonthlySpend, err := asMathInt(args["maxMonthlySpend"])
	if err != nil {
		return nil, fmt.Errorf("createDeal: invalid maxMonthlySpend: %w", err)
	}

	caller := contract.Caller()
	creator := sdk.AccAddress(caller.Bytes()).String()

	msgServer := nilkeeper.NewMsgServerImpl(*p.keeper)
	res, err := msgServer.CreateDeal(sdk.WrapSDKContext(ctx), &types.MsgCreateDeal{
		Creator:             creator,
		DurationBlocks:      duration,
		ServiceHint:         strings.TrimSpace(serviceHint),
		MaxMonthlySpend:     maxMonthlySpend,
		InitialEscrowAmount: initialEscrow,
	})
	if err != nil {
		return nil, err
	}

	p.emitEventDealCreated(evm, res.DealId, caller)

	out, err := method.Outputs.Pack(res.DealId)
	if err != nil {
		return nil, fmt.Errorf("createDeal: failed to pack outputs: %w", err)
	}
	return out, nil
}

func (p *Precompile) runUpdateDealContent(ctx sdk.Context, evm *vm.EVM, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	args := make(map[string]any)
	if err := method.Inputs.UnpackIntoMap(args, data); err != nil {
		return nil, fmt.Errorf("updateDealContent: failed to unpack args: %w", err)
	}

	dealID, err := asUint64(args["dealId"])
	if err != nil {
		return nil, errors.New("updateDealContent: invalid dealId")
	}
	manifestRoot, err := asBytes(args["manifestRoot"])
	if err != nil {
		return nil, errors.New("updateDealContent: invalid manifestRoot")
	}
	if len(manifestRoot) != 48 {
		return nil, errors.New("updateDealContent: manifestRoot must be 48 bytes")
	}
	sizeBytes, err := asUint64(args["sizeBytes"])
	if err != nil || sizeBytes == 0 {
		return nil, errors.New("updateDealContent: sizeBytes must be > 0")
	}

	caller := contract.Caller()
	creator := sdk.AccAddress(caller.Bytes()).String()
	cid := "0x" + hex.EncodeToString(manifestRoot)

	msgServer := nilkeeper.NewMsgServerImpl(*p.keeper)
	_, err = msgServer.UpdateDealContent(sdk.WrapSDKContext(ctx), &types.MsgUpdateDealContent{
		Creator: creator,
		DealId:  dealID,
		Cid:     cid,
		Size_:   sizeBytes,
	})
	if err != nil {
		return nil, err
	}

	p.emitEventDealContentUpdated(evm, dealID, manifestRoot, sizeBytes)

	out, err := method.Outputs.Pack(true)
	if err != nil {
		return nil, fmt.Errorf("updateDealContent: failed to pack outputs: %w", err)
	}
	return out, nil
}

func (p *Precompile) runProveRetrievalBatch(ctx sdk.Context, evm *vm.EVM, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	args := make(map[string]any)
	if err := method.Inputs.UnpackIntoMap(args, data); err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: failed to unpack args: %w", err)
	}

	dealID, err := asUint64(args["dealId"])
	if err != nil {
		return nil, errors.New("proveRetrievalBatch: invalid dealId")
	}
	provider, err := asString(args["provider"])
	if err != nil || strings.TrimSpace(provider) == "" {
		return nil, errors.New("proveRetrievalBatch: provider is required")
	}
	filePath, err := asString(args["filePath"])
	if err != nil || strings.TrimSpace(filePath) == "" {
		return nil, errors.New("proveRetrievalBatch: filePath is required")
	}
	nonce, err := asUint64(args["nonce"])
	if err != nil || nonce == 0 {
		return nil, errors.New("proveRetrievalBatch: nonce must be > 0")
	}

	caller := contract.Caller()
	owner := sdk.AccAddress(caller.Bytes()).String()

	deal, err := p.keeper.Deals.Get(ctx, dealID)
	if err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: deal not found: %w", err)
	}
	if deal.Owner != owner {
		return nil, errors.New("proveRetrievalBatch: caller is not deal owner")
	}
	isAssignedProvider := false
	for _, paddr := range deal.Providers {
		if paddr == provider {
			isAssignedProvider = true
			break
		}
	}
	if !isAssignedProvider {
		return nil, errors.New("proveRetrievalBatch: provider is not assigned to deal")
	}
	if len(deal.ManifestRoot) != 48 {
		return nil, errors.New("proveRetrievalBatch: deal has no committed manifest_root")
	}

	lastNonce, err := p.keeper.ReceiptNoncesByDealFile.Get(ctx, collections.Join(dealID, filePath))
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return nil, fmt.Errorf("proveRetrievalBatch: failed to load last receipt nonce: %w", err)
	}
	if nonce <= lastNonce {
		return nil, errors.New("proveRetrievalBatch: nonce must be strictly increasing")
	}

	chunks, err := decodeChunks(args["chunks"])
	if err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: invalid chunks: %w", err)
	}
	if len(chunks) == 0 {
		return nil, errors.New("proveRetrievalBatch: chunks is empty")
	}

	var bytesServed uint64
	for _, c := range chunks {
		if c.RangeLen == 0 {
			return nil, errors.New("proveRetrievalBatch: rangeLen must be > 0")
		}
		if bytesServed > bytesServed+c.RangeLen {
			return nil, errors.New("proveRetrievalBatch: bytes overflow")
		}

		ok, err := verifyChainedProof(ctx, deal.ManifestRoot, c.Proof)
		if err != nil {
			return nil, fmt.Errorf("proveRetrievalBatch: triple proof verification error: %w", err)
		}
		if !ok {
			return nil, errors.New("proveRetrievalBatch: invalid triple proof")
		}

		bytesServed += c.RangeLen
		if err := p.keeper.IncrementHeat(ctx, deal.Id, c.RangeLen, false); err != nil {
			ctx.Logger().Error("failed to increment heat", "error", err)
		}
	}

	// Bandwidth payment (devnet): 1 unit per KiB (rounded up), deducted from escrow.
	const bytesPerUnit = uint64(1024)
	units := (bytesServed + bytesPerUnit - 1) / bytesPerUnit
	if units == 0 {
		units = 1
	}
	bandwidthPayment := math.NewIntFromUint64(units)
	newEscrowBalance := deal.EscrowBalance.Sub(bandwidthPayment)
	if newEscrowBalance.IsNegative() {
		return nil, errors.New("proveRetrievalBatch: escrow exhausted")
	}
	deal.EscrowBalance = newEscrowBalance
	if err := p.keeper.Deals.Set(ctx, dealID, deal); err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: failed to update deal state: %w", err)
	}

	currentRewards, err := p.keeper.ProviderRewards.Get(ctx, provider)
	if err != nil {
		if !errors.Is(err, collections.ErrNotFound) {
			return nil, fmt.Errorf("proveRetrievalBatch: failed to load provider rewards: %w", err)
		}
		currentRewards = math.ZeroInt()
	}
	if err := p.keeper.ProviderRewards.Set(ctx, provider, currentRewards.Add(bandwidthPayment)); err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: failed to set provider rewards: %w", err)
	}

	if err := p.keeper.ReceiptNoncesByDealFile.Set(ctx, collections.Join(dealID, filePath), nonce); err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: failed to update receipt nonce: %w", err)
	}
	if err := p.keeper.DealProviderStatus.Set(ctx, collections.Join(dealID, provider), uint64(ctx.BlockHeight())); err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: failed to update deal provider status: %w", err)
	}

	p.emitEventRetrievalProved(evm, dealID, caller, provider, filePath, bytesServed, nonce)

	out, err := method.Outputs.Pack(true)
	if err != nil {
		return nil, fmt.Errorf("proveRetrievalBatch: failed to pack outputs: %w", err)
	}
	return out, nil
}

type decodedChunk struct {
	RangeStart uint64
	RangeLen   uint64
	Proof      types.ChainedProof
}

func decodeChunks(v any) ([]decodedChunk, error) {
	rv := reflect.ValueOf(v)
	if !rv.IsValid() || rv.Kind() != reflect.Slice {
		return nil, fmt.Errorf("chunks must be a slice, got %T", v)
	}

	out := make([]decodedChunk, 0, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		cv := rv.Index(i)
		if cv.Kind() == reflect.Pointer {
			cv = cv.Elem()
		}
		if cv.Kind() != reflect.Struct {
			return nil, fmt.Errorf("chunk[%d] must be struct, got %s", i, cv.Kind())
		}

		rangeStart, err := asUint64(cv.FieldByName("RangeStart").Interface())
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].rangeStart invalid: %w", i, err)
		}
		rangeLen, err := asUint64(cv.FieldByName("RangeLen").Interface())
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].rangeLen invalid: %w", i, err)
		}

		pv := cv.FieldByName("Proof")
		if pv.Kind() == reflect.Pointer {
			pv = pv.Elem()
		}
		if pv.Kind() != reflect.Struct {
			return nil, fmt.Errorf("chunk[%d].proof must be struct", i)
		}

		proof := types.ChainedProof{}
		if proof.MduIndex, err = asUint64(pv.FieldByName("MduIndex").Interface()); err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.mduIndex invalid: %w", i, err)
		}
		if proof.MduRootFr, err = asBytes(pv.FieldByName("MduRootFr").Interface()); err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.mduRootFr invalid: %w", i, err)
		}
		if proof.ManifestOpening, err = asBytes(pv.FieldByName("ManifestOpening").Interface()); err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.manifestOpening invalid: %w", i, err)
		}
		if proof.BlobCommitment, err = asBytes(pv.FieldByName("BlobCommitment").Interface()); err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.blobCommitment invalid: %w", i, err)
		}
		mpAny := pv.FieldByName("MerklePath").Interface()
		mpRv := reflect.ValueOf(mpAny)
		if !mpRv.IsValid() || mpRv.Kind() != reflect.Slice {
			return nil, fmt.Errorf("chunk[%d].proof.merklePath invalid", i)
		}
		merklePath := make([][]byte, 0, mpRv.Len())
		for j := 0; j < mpRv.Len(); j++ {
			b, err := asBytes(mpRv.Index(j).Interface())
			if err != nil {
				return nil, fmt.Errorf("chunk[%d].proof.merklePath[%d] invalid: %w", i, j, err)
			}
			merklePath = append(merklePath, b)
		}
		proof.MerklePath = merklePath

		blobIndex, err := asUint64(pv.FieldByName("BlobIndex").Interface())
		if err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.blobIndex invalid: %w", i, err)
		}
		proof.BlobIndex = uint32(blobIndex)

		if proof.ZValue, err = asBytes(pv.FieldByName("ZValue").Interface()); err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.zValue invalid: %w", i, err)
		}
		if proof.YValue, err = asBytes(pv.FieldByName("YValue").Interface()); err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.yValue invalid: %w", i, err)
		}
		if proof.KzgOpeningProof, err = asBytes(pv.FieldByName("KzgOpeningProof").Interface()); err != nil {
			return nil, fmt.Errorf("chunk[%d].proof.kzgOpeningProof invalid: %w", i, err)
		}

		out = append(out, decodedChunk{
			RangeStart: rangeStart,
			RangeLen:   rangeLen,
			Proof:      proof,
		})
	}
	return out, nil
}

func verifyChainedProof(ctx sdk.Context, manifestRoot []byte, chainedProof types.ChainedProof) (bool, error) {
	if len(manifestRoot) != 48 {
		return false, nil
	}
	if len(chainedProof.ManifestOpening) != 48 || len(chainedProof.MduRootFr) != 32 ||
		len(chainedProof.BlobCommitment) != 48 || len(chainedProof.MerklePath) == 0 ||
		len(chainedProof.ZValue) != 32 || len(chainedProof.YValue) != 32 || len(chainedProof.KzgOpeningProof) != 48 {
		return false, nil
	}

	flattenedMerkle := make([]byte, 0, len(chainedProof.MerklePath)*32)
	for _, node := range chainedProof.MerklePath {
		if len(node) != 32 {
			return false, nil
		}
		flattenedMerkle = append(flattenedMerkle, node...)
	}

	ok, err := crypto_ffi.VerifyChainedProof(
		manifestRoot,
		chainedProof.MduIndex,
		chainedProof.ManifestOpening,
		chainedProof.MduRootFr,
		chainedProof.BlobCommitment,
		uint64(chainedProof.BlobIndex),
		flattenedMerkle,
		chainedProof.ZValue,
		chainedProof.YValue,
		chainedProof.KzgOpeningProof,
	)
	if err != nil {
		ctx.Logger().Error("VerifyChainedProof error", "error", err)
		return false, err
	}
	return ok, nil
}

func (p *Precompile) emitEventDealCreated(evm *vm.EVM, dealID uint64, owner common.Address) {
	ev, ok := p.abi.Events["DealCreated"]
	if !ok {
		return
	}
	data, err := ev.Inputs.NonIndexed().Pack()
	if err != nil {
		return
	}
	evm.StateDB.AddLog(&ethtypes.Log{
		Address: p.Address(),
		Topics:  []common.Hash{ev.ID, common.BigToHash(new(big.Int).SetUint64(dealID)), common.BytesToHash(owner.Bytes())},
		Data:    data,
	})
}

func (p *Precompile) emitEventDealContentUpdated(evm *vm.EVM, dealID uint64, manifestRoot []byte, sizeBytes uint64) {
	ev, ok := p.abi.Events["DealContentUpdated"]
	if !ok {
		return
	}
	data, err := ev.Inputs.NonIndexed().Pack(manifestRoot, sizeBytes)
	if err != nil {
		return
	}
	evm.StateDB.AddLog(&ethtypes.Log{
		Address: p.Address(),
		Topics:  []common.Hash{ev.ID, common.BigToHash(new(big.Int).SetUint64(dealID))},
		Data:    data,
	})
}

func (p *Precompile) emitEventRetrievalProved(evm *vm.EVM, dealID uint64, owner common.Address, provider string, filePath string, bytesServed uint64, nonce uint64) {
	ev, ok := p.abi.Events["RetrievalProved"]
	if !ok {
		return
	}
	data, err := ev.Inputs.NonIndexed().Pack(provider, filePath, bytesServed, nonce)
	if err != nil {
		return
	}
	evm.StateDB.AddLog(&ethtypes.Log{
		Address: p.Address(),
		Topics:  []common.Hash{ev.ID, common.BigToHash(new(big.Int).SetUint64(dealID)), common.BytesToHash(owner.Bytes())},
		Data:    data,
	})
}

func asUint64(v any) (uint64, error) {
	switch t := v.(type) {
	case uint64:
		return t, nil
	case uint32:
		return uint64(t), nil
	case int:
		if t < 0 {
			return 0, errors.New("negative int")
		}
		return uint64(t), nil
	case *big.Int:
		if t.Sign() < 0 {
			return 0, errors.New("negative big int")
		}
		if t.BitLen() > 64 {
			return 0, errors.New("big int overflows uint64")
		}
		return t.Uint64(), nil
	default:
		return 0, fmt.Errorf("unsupported uint type %T", v)
	}
}

func asString(v any) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("not a string: %T", v)
	}
	return s, nil
}

func asBytes(v any) ([]byte, error) {
	switch b := v.(type) {
	case []byte:
		return b, nil
	default:
		return nil, fmt.Errorf("not bytes: %T", v)
	}
}

func asMathInt(v any) (math.Int, error) {
	switch t := v.(type) {
	case *big.Int:
		if t.Sign() < 0 {
			return math.Int{}, errors.New("negative")
		}
		return math.NewIntFromBigInt(t), nil
	case uint64:
		return math.NewIntFromUint64(t), nil
	default:
		return math.Int{}, fmt.Errorf("unsupported int type %T", v)
	}
}
