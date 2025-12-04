package types

// Event types
const (
	TypeMsgRegisterProvider = "register_provider"
	TypeMsgCreateDeal       = "create_deal"
	TypeMsgProveLiveness    = "prove_liveness"
	TypeMsgSignalSaturation = "signal_saturation"

	AttributeKeyProvider     = "provider"
	AttributeKeyCapabilities = "capabilities"
	AttributeKeyTotalStorage = "total_storage"
	AttributeKeyDealID       = "deal_id"
	AttributeKeyCID          = "cid"
	AttributeKeyOwner        = "owner"
	AttributeKeySize         = "size"
	AttributeKeyHint         = "service_hint"
	AttributeKeyAssignedProviders = "assigned_providers"
	AttributeKeySuccess      = "success"
	AttributeKeyTier         = "tier"
	AttributeKeyRewardAmount = "reward_amount"
)
