package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func replacePackedFATHeaderV3(wire []byte, header retrievalchallenge.FATV3Header) error {
	if len(wire) != types.MDU_SIZE {
		return fmt.Errorf("invalid MDU #0 size")
	}
	raw, err := header.Bytes()
	if err != nil {
		return err
	}
	start := 16 * types.BLOB_SIZE
	for i, value := range raw {
		scalar := i / 31
		wire[start+scalar*32] = 0
		wire[start+scalar*32+1+i%31] = value
	}
	return nil
}

// The upload result is a proposal input, never a legacy update-deal-content input.
type generationCandidateV3 struct {
	DealID                    uint64 `json:"deal_id,string"`
	ExpectedCurrentGeneration uint64 `json:"expected_current_generation,string"`
	PreviousPolyfsRoot        string `json:"previous_polyfs_root"`
	PolyfsRoot                string `json:"polyfs_root"`
	IntegrityRoot             string `json:"integrity_root"`
	SizeBytes                 uint64 `json:"size_bytes,string"`
	TotalMDUs                 uint64 `json:"total_mdus,string"`
	WitnessMDUs               uint64 `json:"witness_mdus,string"`
	IntegrityLeafCount        uint64 `json:"integrity_leaf_count,string"`
	CommitAction              string `json:"commit_action"`
	RequiredAcceptances       uint32 `json:"required_acceptances"`
}

func uploadFATVersion(r *http.Request) (uint16, error) {
	values, present := r.URL.Query()["fat_version"]
	if !present {
		return 2, nil
	}
	if len(values) != 1 || (values[0] != "2" && values[0] != "3") {
		return 0, fmt.Errorf("fat_version must be 2 or 3")
	}
	if values[0] == "3" {
		return 3, nil
	}
	return 2, nil
}

func validateUploadDealV3(deal *types.Deal, height uint64) ([]mode2SlotAssignment, error) {
	if deal == nil || height == 0 || deal.EndBlock <= height || len(deal.ManifestRoot) != 0 || deal.Size_ != 0 || deal.TotalMdus != 0 || deal.WitnessMdus != 0 || deal.CurrentGen != 0 {
		return nil, fmt.Errorf("FAT v3 ingest requires an existing empty, unexpired generation-zero deal")
	}
	if _, err := rawProviderV3(deal.Owner); err != nil {
		return nil, err
	}
	if deal.RedundancyMode != 2 || deal.Mode2Profile == nil || deal.Mode2Profile.K != 8 || deal.Mode2Profile.M != 4 || len(deal.Mode2Slots) != 12 {
		return nil, fmt.Errorf("FAT v3 requires the fixed Mode 2 K=8,M=4 profile with 12 slots")
	}
	slots := make([]mode2SlotAssignment, 12)
	seen := make(map[string]bool, 12)
	for i, slot := range deal.Mode2Slots {
		if slot == nil || slot.Slot != uint32(i) || slot.Status != types.SlotStatus_SLOT_STATUS_ACTIVE || slot.PendingProvider != "" || seen[slot.Provider] {
			return nil, fmt.Errorf("FAT v3 requires twelve ordered, distinct, active providers without pending replacements")
		}
		if _, err := rawProviderV3(slot.Provider); err != nil {
			return nil, err
		}
		seen[slot.Provider] = true
		slots[i] = mode2SlotAssignment{Provider: slot.Provider, Status: 1}
	}
	return slots, nil
}

func ingestGenerationV3(ctx context.Context, path, recordPath, owner string, dealID uint64) (*generationCandidateV3, error) {
	deal, height, err := queryRetrievalDeal(ctx, dealID, 0)
	if err != nil {
		return nil, err
	}
	slots, err := validateUploadDealV3(deal, height)
	if err != nil {
		return nil, err
	}
	if owner != "" && owner != deal.Owner {
		return nil, uploadFailure{status: http.StatusForbidden, message: "owner does not match deal"}
	}
	var releasePublished func()
	ctx = context.WithValue(ctx, generationPublicationLeaseKey{}, &releasePublished)
	defer func() {
		if releasePublished != nil {
			releasePublished()
		}
	}()
	const hint = "General:rs=8+4"
	res, dir, err := mode2BuildArtifactsWithOptions(ctx, path, dealID, hint, recordPath, 0, mode2BuildOptions{fatVersion: 3})
	if err != nil {
		return nil, err
	}
	if err := mode2UploadArtifactsToProvidersWithOptions(ctx, dealID, res.manifestRoot, "", hint, dir, res.witnessMdus, res.userMdus, mode2UploadOptions{strictV3: true, expectedV3Slots: slots}); err != nil {
		return nil, err
	}
	fresh, freshHeight, err := queryRetrievalDeal(ctx, dealID, 0)
	if err != nil {
		return nil, err
	}
	freshSlots, err := validateUploadDealV3(fresh, freshHeight)
	if err != nil {
		return nil, err
	}
	if fresh.Owner != deal.Owner || fresh.CurrentGen != deal.CurrentGen || !slices.Equal(slots, freshSlots) {
		return nil, fmt.Errorf("deal changed during FAT v3 upload; retry against current assignments")
	}
	return &generationCandidateV3{DealID: dealID, ExpectedCurrentGeneration: deal.CurrentGen,
		PolyfsRoot: res.manifestRoot.Canonical, IntegrityRoot: "0x" + hex.EncodeToString(res.integrityRoot[:]),
		SizeBytes: res.sizeBytes, TotalMDUs: res.allocatedLength, WitnessMDUs: res.witnessMdus,
		IntegrityLeafCount: res.integrityLeaves, CommitAction: "propose-deal-generation-v3", RequiredAcceptances: 12}, nil
}

// This guard covers local gateway relays. The legacy chain cannot inspect MDU0.
func rejectLegacyV3Commit(dealID uint64, rootString string) error {
	root, err := parseManifestRoot(rootString)
	if err != nil {
		return err
	}
	dir := dealScopedDir(dealID, root)
	release, err := leaseGenerationPaths(dir)
	if err != nil {
		return err
	}
	defer release()
	wire, err := os.ReadFile(filepath.Join(dir, "mdu_0.bin"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	header, err := fatV3HeaderFromEncodedMDU0(wire)
	if err != nil {
		return nil
	} // Legacy layouts retain their existing validation.
	if binary.LittleEndian.Uint16(header[4:6]) == 3 {
		return fmt.Errorf("FAT v3 requires propose-deal-generation-v3, all twelve provider acceptances, then finalize-deal-generation-v3")
	}
	return nil
}
