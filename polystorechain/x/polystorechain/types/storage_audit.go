package types

import (
	"encoding/hex"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"polystorechain/pkg/retrievalchallenge"
)

// These are inactive candidate resource ceilings, not network capacity claims.
// Repair readiness shares this inventory, but never contributes ACTIVE coverage.
const MaxStorageAuditAssignments = 64

// StorageAuditContext reconstructs only the frozen statement. Caller must check
// retained epoch, seed, authority, and response window before proof verification.
func StorageAuditContext(a FrozenStorageAudit, epochLength uint64) (retrievalchallenge.Context, error) {
	c := retrievalchallenge.Context{}
	if a.Assignment == nil || a.Assignment.Snapshot == nil {
		return c, fmt.Errorf("missing storage audit snapshot")
	}
	s := a.Assignment.Snapshot
	if len(a.Assignment.ManifestRoot) != 32 || len(s.SetupDigest) != 32 || s.Layout > 255 || a.Assignment.Kind > 255 {
		return c, fmt.Errorf("invalid storage audit snapshot")
	}
	setup, _ := hex.DecodeString(RetrievalSetupDigest)
	if string(setup) != string(s.SetupDigest) {
		return c, fmt.Errorf("unsupported storage audit setup")
	}
	addr, err := sdk.AccAddressFromBech32(a.Assignment.Provider)
	if err != nil || len(addr) != 20 || addr.String() != a.Assignment.Provider {
		return c, fmt.Errorf("invalid storage audit provider")
	}
	w, issued, err := retrievalchallenge.AuditWindow(a.EpochId, epochLength, s.DealEnd)
	if err != nil || !issued {
		return c, fmt.Errorf("storage audit has no response window")
	}
	c = retrievalchallenge.Context{Version: retrievalchallenge.Version, ChainID: s.ChainId, Kind: uint8(a.Assignment.Kind), DealID: a.Assignment.DealId, Generation: s.Generation, Layout: uint8(s.Layout), K: s.K, M: s.M, Slot: s.Slot, MetadataMDUs: s.MetadataMdus, UserMDUs: s.UserMdus, EpochID: a.EpochId, EpochLength: epochLength, SampleCount: a.SampleCount, Window: w, DealEnd: s.DealEnd}
	copy(c.SetupDigest[:], s.SetupDigest)
	copy(c.Root[:], a.Assignment.ManifestRoot)
	copy(c.Assigned[:], addr)
	copy(c.Payee[:], addr)
	if c.Kind != retrievalchallenge.Audit && c.Kind != retrievalchallenge.Repair {
		return c, fmt.Errorf("invalid storage obligation kind")
	}
	if _, err := c.Bytes(); err != nil {
		return c, err
	}
	return c, nil
}
