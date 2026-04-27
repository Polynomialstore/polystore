package types

// Event types
const (
	TypeMsgRegisterProvider        = "register_provider"
	TypeMsgAddProviderBond         = "add_provider_bond"
	TypeMsgUpdateProviderEndpoints = "update_provider_endpoints"
	TypeMsgRequestProviderLink     = "request_provider_link"
	TypeMsgApproveProviderLink     = "approve_provider_link"
	TypeMsgCancelProviderLink      = "cancel_provider_link"
	TypeMsgUnpairProvider          = "unpair_provider"
	TypeMsgCreateDeal              = "create_deal"
	TypeMsgBumpDealSetupSlot       = "bump_deal_setup_slot"
	TypeMsgProveLiveness           = "prove_liveness"
	TypeMsgSignalSaturation        = "signal_saturation"

	AttributeKeyProvider          = "provider"
	AttributeKeyCapabilities      = "capabilities"
	AttributeKeyTotalStorage      = "total_storage"
	AttributeKeyDealID            = "deal_id"
	AttributeKeyCID               = "cid"
	AttributeKeyOwner             = "owner"
	AttributeKeySize              = "size"
	AttributeKeyHint              = "service_hint"
	AttributeKeyAssignedProviders = "assigned_providers"
	AttributeKeySuccess           = "success"
	AttributeKeyTier              = "tier"
	AttributeKeyRewardAmount      = "reward_amount"
)
