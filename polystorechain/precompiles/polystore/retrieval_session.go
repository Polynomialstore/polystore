package polystore

import (
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/core/vm"
	nilkeeper "polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

// A v2 overload adds the authorized payee field. The selector chooses the wire
// version, including when an empty payee explicitly defaults to the assignment.
func sessionVersionForMethod(method *abi.Method) uint32 {
	for _, input := range method.Inputs {
		if input.Name == "authorizedProofProvider" {
			return 2
		}
		if input.Type.T == abi.SliceTy && input.Type.Elem.T == abi.TupleTy {
			for _, name := range input.Type.Elem.TupleRawNames {
				if name == "authorizedProofProvider" {
					return 2
				}
			}
		}
	}
	return 0
}

// This is the exact existing chained-proof ABI tuple order, shared by the legacy
// chunk wrapper and this session route. No unauthenticated provider argument is
// accepted: caller bytes are the native message signer and frozen payee.
type sessionProofInput struct {
	MduIndex              uint64
	MduRootFr             []byte
	ManifestOpening       []byte
	RootTableDuCommitment []byte
	RootTableDuMerklePath [][]byte
	BlobCommitment        []byte
	MerklePath            [][]byte
	BlobIndex             uint32
	ZValue                []byte
	YValue                []byte
	KzgOpeningProof       []byte
}

func (p *Precompile) runSubmitRetrievalSessionProof(ctx sdk.Context, contract *vm.Contract, method *abi.Method, data []byte) ([]byte, error) {
	var input struct {
		SessionId [32]byte
		Proofs    []sessionProofInput
	}
	values, err := method.Inputs.Unpack(data)
	if err != nil {
		return nil, err
	}
	if err := method.Inputs.Copy(&input, values); err != nil {
		return nil, err
	}
	if err := nilkeeper.ValidateProofCount(uint64(len(input.Proofs))); err != nil {
		return nil, err
	}
	proofs := make([]types.ChainedProof, len(input.Proofs))
	for i, wire := range input.Proofs {
		proofs[i] = types.ChainedProof{
			MduIndex: wire.MduIndex, MduRootFr: wire.MduRootFr, ManifestOpening: wire.ManifestOpening,
			RootTableDuCommitment: wire.RootTableDuCommitment, RootTableDuMerklePath: wire.RootTableDuMerklePath,
			BlobCommitment: wire.BlobCommitment, MerklePath: wire.MerklePath, BlobIndex: wire.BlobIndex,
			ZValue: wire.ZValue, YValue: wire.YValue, KzgOpeningProof: wire.KzgOpeningProof,
		}
	}
	server := nilkeeper.NewMsgServerImpl(*p.keeper)
	response, err := server.SubmitRetrievalSessionProof(ctx, &types.MsgSubmitRetrievalSessionProof{
		Creator: sdk.AccAddress(contract.Caller().Bytes()).String(), SessionId: input.SessionId[:], Proofs: proofs,
	})
	if err != nil {
		return nil, err
	}
	return method.Outputs.Pack(response.Success)
}
