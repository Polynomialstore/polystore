package keeper

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"polystorechain/x/polystorechain/types"
)

var evidenceSeedTag = []byte("polystore/evidence/v1")

func deriveEvidenceID(kind string, dealID uint64, epochID uint64, extra []byte) [32]byte {
	buf := make([]byte, 0, len(evidenceSeedTag)+len(kind)+8+8+len(extra))
	buf = append(buf, evidenceSeedTag...)
	buf = append(buf, []byte(kind)...)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = binary.BigEndian.AppendUint64(buf, epochID)
	buf = append(buf, extra...)
	return sha256.Sum256(buf)
}

type evidenceCaseInput struct {
	DealID             uint64
	Slot               uint32
	Provider           string
	Reporter           string
	Reason             string
	Class              types.EvidenceClass
	Severity           types.EvidenceSeverity
	Status             types.EvidenceCaseStatus
	Slashable          bool
	CountsAsFailure    bool
	EpochID            uint64
	Count              uint64
	EvidenceID         []byte
	SessionID          []byte
	Summary            string
	ConsequenceCeiling string
}

type slotHealthUpdate struct {
	DealID             uint64
	Slot               uint32
	Provider           string
	Status             types.SlotHealthStatus
	Reason             string
	Class              types.EvidenceClass
	Severity           types.EvidenceSeverity
	MissedEpochs       uint64
	DeputyMissedEpochs uint64
	EpochID            uint64
	EvidenceCaseID     uint64
	PendingProvider    string
	RepairTargetGen    uint64
	ResetCounters      bool
}

func classifyEvidenceReason(reason string) (types.EvidenceClass, types.EvidenceSeverity, types.EvidenceCaseStatus, string, bool) {
	normalized := strings.TrimSpace(strings.ToLower(reason))
	switch normalized {
	case "slot_repair_ready":
		return types.EvidenceClass_EVIDENCE_CLASS_POSITIVE_READINESS,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_INFO,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
			"promotion guardrail only",
			false
	case "slot_repair_completed":
		return types.EvidenceClass_EVIDENCE_CLASS_POSITIVE_READINESS,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_RESOLVED,
			"repair completed; no penalty by itself",
			false
	}

	switch normalized {
	case "system_proof_invalid", "system_proof_wrong_challenge", "system_proof_wrong_provider":
		return types.EvidenceClass_EVIDENCE_CLASS_CRYPTOGRAPHIC_HARD,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_HARD,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
			"slash or jail candidate after hard-fault policy is enabled",
			true
	case "provider_delinquent", "quota_miss_repair_started", "deputy_miss_repair_started", "provider_degraded_repair_started":
		return types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_DELINQUENT,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_CONVICTED,
			"repair and reward exclusion; no soft-fault slash by default",
			false
	case "provider_degraded", "quota_miss_recorded", "deputy_served_zero_direct", "retrieval_non_response":
		return types.EvidenceClass_EVIDENCE_CLASS_CHAIN_MEASURABLE_SOFT,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_DEGRADED,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
			"health decay and operator alert; no slash",
			false
	case "deputy_served":
		return types.EvidenceClass_EVIDENCE_CLASS_STATISTICAL,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_SOFT,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
			"audit debt and ghosting signal; no slash",
			false
	case "repair_backoff_entered":
		return types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_REPAIR,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
			"operator alert; no slash",
			false
	default:
		return types.EvidenceClass_EVIDENCE_CLASS_OPERATIONAL,
			types.EvidenceSeverity_EVIDENCE_SEVERITY_SOFT,
			types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_OBSERVED,
			"measure-only until classified",
			false
	}
}

func (k Keeper) recordEvidenceCase(ctx sdk.Context, in evidenceCaseInput) (uint64, error) {
	reason := strings.TrimSpace(in.Reason)
	if reason == "" {
		return 0, fmt.Errorf("evidence reason is required")
	}
	provider := strings.TrimSpace(in.Provider)
	reporter := strings.TrimSpace(in.Reporter)
	if reporter == "" {
		reporter = "chain"
	}
	if in.Class == types.EvidenceClass_EVIDENCE_CLASS_UNSPECIFIED ||
		in.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_UNSPECIFIED ||
		in.Status == types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_UNSPECIFIED {
		class, severity, status, ceiling, slashable := classifyEvidenceReason(reason)
		if in.Class == types.EvidenceClass_EVIDENCE_CLASS_UNSPECIFIED {
			in.Class = class
		}
		if in.Severity == types.EvidenceSeverity_EVIDENCE_SEVERITY_UNSPECIFIED {
			in.Severity = severity
		}
		if in.Status == types.EvidenceCaseStatus_EVIDENCE_CASE_STATUS_UNSPECIFIED {
			in.Status = status
		}
		if in.ConsequenceCeiling == "" {
			in.ConsequenceCeiling = ceiling
		}
		if !in.Slashable {
			in.Slashable = slashable
		}
	}
	if in.Count == 0 {
		in.Count = 1
	}

	id, err := k.EvidenceCount.Next(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to get next evidence id: %w", err)
	}

	evidenceID := append([]byte(nil), in.EvidenceID...)
	if len(evidenceID) == 0 {
		extra := make([]byte, 0, 4+len(provider)+len(reason))
		extra = binary.BigEndian.AppendUint32(extra, in.Slot)
		extra = append(extra, []byte(provider)...)
		extra = append(extra, []byte(reason)...)
		derived := deriveEvidenceID(reason, in.DealID, in.EpochID, extra)
		evidenceID = derived[:]
	}

	caseRecord := types.EvidenceCase{
		Id:                 id,
		EvidenceId:         evidenceID,
		DealId:             in.DealID,
		Slot:               in.Slot,
		Provider:           provider,
		Reporter:           reporter,
		Reason:             reason,
		EvidenceClass:      in.Class,
		Severity:           in.Severity,
		Status:             in.Status,
		Slashable:          in.Slashable,
		CountsAsFailure:    in.CountsAsFailure,
		EpochId:            in.EpochID,
		Count:              in.Count,
		FirstHeight:        ctx.BlockHeight(),
		LastHeight:         ctx.BlockHeight(),
		SessionId:          append([]byte(nil), in.SessionID...),
		Summary:            strings.TrimSpace(in.Summary),
		ConsequenceCeiling: strings.TrimSpace(in.ConsequenceCeiling),
	}
	if err := k.EvidenceCases.Set(ctx, id, caseRecord); err != nil {
		return 0, fmt.Errorf("failed to store evidence case: %w", err)
	}
	if in.DealID != 0 {
		if err := k.EvidenceCasesByDeal.Set(ctx, collections.Join(in.DealID, id), true); err != nil {
			return 0, fmt.Errorf("failed to index evidence case by deal: %w", err)
		}
	}
	if err := k.updateProviderHealthFromEvidence(ctx, caseRecord); err != nil {
		return 0, fmt.Errorf("failed to update provider health: %w", err)
	}
	return id, nil
}

func (k Keeper) setSlotHealthState(ctx sdk.Context, in slotHealthUpdate) error {
	key := collections.Join(in.DealID, in.Slot)
	current, err := k.SlotHealthStates.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if err == nil {
		if strings.TrimSpace(in.Provider) == "" {
			in.Provider = current.Provider
		}
		if !in.ResetCounters && in.MissedEpochs == 0 {
			in.MissedEpochs = current.MissedEpochs
		}
		if !in.ResetCounters && in.DeputyMissedEpochs == 0 {
			in.DeputyMissedEpochs = current.DeputyMissedEpochs
		}
	}
	if in.Status == types.SlotHealthStatus_SLOT_HEALTH_STATUS_UNSPECIFIED {
		in.Status = types.SlotHealthStatus_SLOT_HEALTH_STATUS_HEALTHY
	}

	state := types.SlotHealthState{
		DealId:             in.DealID,
		Slot:               in.Slot,
		Provider:           strings.TrimSpace(in.Provider),
		Status:             in.Status,
		Reason:             strings.TrimSpace(in.Reason),
		EvidenceClass:      in.Class,
		Severity:           in.Severity,
		MissedEpochs:       in.MissedEpochs,
		DeputyMissedEpochs: in.DeputyMissedEpochs,
		LastEpochId:        in.EpochID,
		UpdatedHeight:      ctx.BlockHeight(),
		LastEvidenceCaseId: in.EvidenceCaseID,
		PendingProvider:    strings.TrimSpace(in.PendingProvider),
		RepairTargetGen:    in.RepairTargetGen,
	}
	return k.SlotHealthStates.Set(ctx, key, state)
}
