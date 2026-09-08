package app

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"math/big"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/collections"
	sdkmath "cosmossdk.io/math"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	clienttx "github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

// Real native signatures, ante handling, message routing and committed state;
// this deliberately stops at authorization/funding and makes no proof or network
// qualification claim. The funded redeemer is neither the owner nor the issuer.
func TestRetrievalV2VoucherSignedTransactions(t *testing.T) {
	if runGenesisTestInFreshProcess(t) {
		return
	}
	key := secp256k1.GenPrivKeyFromSecret([]byte("v2 voucher native redeemer"))
	a := newRetrievalTransactionApp(t, key)
	redeemer := sdk.AccAddress(key.PubKey().Address())
	module := authtypes.NewModuleAddress(types.ModuleName)
	issuerKey, err := gethCrypto.HexToECDSA(strings.Repeat("11", 32))
	require.NoError(t, err)
	ownerKey, err := gethCrypto.HexToECDSA(strings.Repeat("22", 32))
	require.NoError(t, err)
	issuer := sdk.AccAddress(gethCrypto.PubkeyToAddress(issuerKey.PublicKey).Bytes()).String()
	owner := sdk.AccAddress(gethCrypto.PubkeyToAddress(ownerKey.PublicKey).Bytes()).String()
	require.NotEqual(t, owner, redeemer.String())
	require.NotEqual(t, issuer, redeemer.String())
	providers := []string{}
	setup := a.NewContextLegacy(false, cmtproto.Header{Height: 1, ChainID: SimAppChainID})
	for i := byte(0x31); i <= 0x34; i++ {
		address := sdk.AccAddress(bytes.Repeat([]byte{i}, 20)).String()
		providers = append(providers, address)
		require.NoError(t, a.PolyStoreChainKeeper.Providers.Set(setup, address, types.Provider{Address: address, Status: "Active"}))
	}
	deal := types.Deal{Id: 1, Owner: owner, Providers: providers[:3], ManifestRoot: bytes.Repeat([]byte{1}, 32),
		TotalMdus: 3, WitnessMdus: 1, Size_: 1024, RedundancyMode: 2, ServiceHint: "General:rs=2+1",
		EscrowBalance: sdkmath.NewInt(100), StartBlock: 1, EndBlock: 100, MaxMonthlySpend: sdkmath.ZeroInt(), SpendWindowSpent: sdkmath.ZeroInt(),
		RetrievalPolicy: types.RetrievalPolicy{Mode: types.RetrievalPolicyMode_RETRIEVAL_POLICY_MODE_VOUCHER, VoucherSigner: issuer}}
	for slot, provider := range providers[:3] {
		deal.Mode2Slots = append(deal.Mode2Slots, &types.DealSlot{Slot: uint32(slot), Provider: provider, Status: types.SlotStatus_SLOT_STATUS_ACTIVE})
	}
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(setup, deal.Id, deal))
	fallback := deal
	fallback.Id = 2
	fallback.RetrievalPolicy.VoucherSigner = ""
	require.NoError(t, a.PolyStoreChainKeeper.Deals.Set(setup, fallback.Id, fallback))
	query := func() sdk.Context {
		ctx, err := a.CreateQueryContextWithCheckHeader(0, false, false)
		require.NoError(t, err)
		return ctx
	}
	height := int64(0)
	finalize := func(txs ...[]byte) *abci.ResponseFinalizeBlock {
		height++
		response, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: height, Hash: bytes.Repeat([]byte{byte(height)}, 32), Time: time.Unix(height, 0), Txs: txs})
		require.NoError(t, err)
		_, err = a.Commit()
		require.NoError(t, err)
		return response
	}
	finalize()
	sign := func(msgs ...sdk.Msg) []byte {
		account := a.AuthKeeper.GetAccount(query(), redeemer)
		config := a.TxConfig()
		builder := config.NewTxBuilder()
		require.NoError(t, builder.SetMsgs(msgs...))
		builder.SetMemo("")
		builder.SetFeeAmount(sdk.NewCoins(sdk.NewInt64Coin("aatom", 10000)))
		builder.SetGasLimit(3000000)
		mode, err := authsigning.APISignModeToInternal(config.SignModeHandler().DefaultMode())
		require.NoError(t, err)
		sequence := account.GetSequence()
		require.NoError(t, builder.SetSignatures(signing.SignatureV2{PubKey: key.PubKey(), Data: &signing.SingleSignatureData{SignMode: mode}, Sequence: sequence}))
		data := authsigning.SignerData{Address: redeemer.String(), ChainID: SimAppChainID, AccountNumber: account.GetAccountNumber(), Sequence: sequence, PubKey: key.PubKey()}
		signature, err := clienttx.SignWithPrivKey(context.Background(), mode, data, builder, key, config, sequence)
		require.NoError(t, err)
		require.NoError(t, builder.SetSignatures(signature))
		raw, err := config.TxEncoder()(builder.GetTx())
		require.NoError(t, err)
		return raw
	}
	voucher := func(dealID, nonce uint64, provider string, signer *ecdsa.PrivateKey) *types.VoucherAuth {
		v := &types.VoucherAuth{DealId: dealID, ManifestRoot: deal.ManifestRoot, Provider: provider, StartMduIndex: 2,
			BlobCount: 1, ExpiresAt: 80, Nonce: nonce, Redeemer: redeemer.String()}
		hash, err := types.HashRetrievalVoucher(v)
		require.NoError(t, err)
		params := a.PolyStoreChainKeeper.GetParams(query())
		digest := types.ComputeEIP712Digest(types.HashDomainSeparator(new(big.Int).SetUint64(params.Eip712ChainId)), hash)
		v.Signature, err = gethCrypto.Sign(digest, signer)
		require.NoError(t, err)
		return v
	}
	open := func(v *types.VoucherAuth, nonce uint64, deputy string) *types.MsgOpenRetrievalSessionSponsored {
		return &types.MsgOpenRetrievalSessionSponsored{Creator: redeemer.String(), DealId: v.DealId, Provider: providers[0],
			ManifestRoot: deal.ManifestRoot, StartMduIndex: 2, BlobCount: 1, Nonce: nonce, ExpiresAt: v.ExpiresAt,
			ChallengeVersion: 2, AuthorizedProofProvider: deputy, MaxTotalFee: sdkmath.ZeroInt(),
			Auth: &types.MsgOpenRetrievalSessionSponsored_Voucher{Voucher: v}}
	}
	// Include every session/index/capacity/generation entry and consumed voucher.
	// Challenge anchors advance in BeginBlock even for failed transactions, so
	// compare them separately while no successful open has scheduled an anchor.
	state := func() map[string][]byte {
		result := map[string][]byte{}
		iterator := query().KVStore(a.GetKey(types.StoreKey)).Iterator(nil, nil)
		defer iterator.Close()
		for ; iterator.Valid(); iterator.Next() {
			k := string(iterator.Key())
			if strings.HasPrefix(k, "RetrievalSession") || strings.HasPrefix(k, "VoucherUsedNonce/") {
				result[k] = bytes.Clone(iterator.Value())
			}
		}
		return result
	}
	failed := func(name, want string, msgs ...sdk.Msg) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			// Let BeginBlock retire the previous block's open count and freeze
			// any newly scheduled anchor before comparing transaction state.
			finalize()
			before := state()
			ctx := query()
			stake := a.BankKeeper.GetBalance(ctx, redeemer, "stake")
			moduleStake := a.BankKeeper.GetBalance(ctx, module, "stake")
			fees := a.BankKeeper.GetBalance(ctx, redeemer, "aatom")
			supply := a.BankKeeper.GetSupply(ctx, "stake")
			sequence := a.AuthKeeper.GetAccount(ctx, redeemer).GetSequence()
			result := finalize(sign(msgs...)).TxResults[0]
			require.NotZero(t, result.Code, result.Log)
			require.Contains(t, result.Log, want)
			if len(msgs) > 1 {
				require.Contains(t, result.Log, "message index: 1", "the funded open must succeed before the bank failure")
				require.Greater(t, result.GasUsed, int64(100000), "rollback still charges the performed retention work")
			}
			require.Equal(t, before, state(), "voucher, session, nonce and retention writes roll back")
			ctx = query()
			require.Equal(t, stake, a.BankKeeper.GetBalance(ctx, redeemer, "stake"))
			require.Equal(t, moduleStake, a.BankKeeper.GetBalance(ctx, module, "stake"))
			require.Equal(t, supply, a.BankKeeper.GetSupply(ctx, "stake"), "message burn rolls back")
			require.Equal(t, fees.Sub(sdk.NewInt64Coin("aatom", 10000)), a.BankKeeper.GetBalance(ctx, redeemer, "aatom"), "ante fee persists")
			require.Equal(t, sequence+1, a.AuthKeeper.GetAccount(ctx, redeemer).GetSequence(), "ante sequence persists")
			for _, event := range result.Events {
				require.NotEqual(t, "burn", event.Type, "rolled-back message events must not escape")
			}
		})
	}
	bound := voucher(1, 777, providers[0], issuerKey)
	failed("owner cannot replace configured issuer", "voucher signature does not match signer", open(voucher(1, 777, providers[0], ownerKey), 1, ""))
	failed("bound voucher cannot redirect payee", "voucher does not authorize the effective payee", open(bound, 1, providers[1]))
	failed("wildcard cannot authorize unassigned deputy", "existing vouchers cannot authorize an unassigned deputy", open(voucher(1, 777, "", issuerKey), 1, providers[3]))
	feeCap := open(bound, 1, "")
	feeCap.MaxTotalFee = sdkmath.NewInt(9)
	failed("fee cap after voucher consumption", "total fee exceeds max_total_fee", feeCap)
	laterFailure := &banktypes.MsgSend{FromAddress: redeemer.String(), ToAddress: providers[0], Amount: sdk.NewCoins(sdk.NewInt64Coin("stake", 2000000))}
	failed("later native message after funded open", "insufficient funds", open(bound, 1, ""), laterFailure)
	require.NoError(t, a.PolyStoreChainKeeper.ChallengePendingAnchors.Walk(query(), nil, func(_ uint64, _ bool) (bool, error) {
		t.Fatal("failed opens left a pending challenge anchor")
		return false, nil
	}))

	accepted := func(name string, msg *types.MsgOpenRetrievalSessionSponsored) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			ctx := query()
			stake := a.BankKeeper.GetBalance(ctx, redeemer, "stake")
			moduleStake := a.BankKeeper.GetBalance(ctx, module, "stake")
			supply := a.BankKeeper.GetSupply(ctx, "stake")
			result := finalize(sign(msg)).TxResults[0]
			require.Zero(t, result.Code, result.Log)
			ctx = query()
			require.Equal(t, stake.Sub(sdk.NewInt64Coin("stake", 10)), a.BankKeeper.GetBalance(ctx, redeemer, "stake"))
			require.Equal(t, moduleStake.Add(sdk.NewInt64Coin("stake", 7)), a.BankKeeper.GetBalance(ctx, module, "stake"))
			require.Equal(t, supply.Sub(sdk.NewInt64Coin("stake", 3)), a.BankKeeper.GetSupply(ctx, "stake"))
			used, err := a.PolyStoreChainKeeper.VoucherUsedNonces.Get(ctx, collections.Join(msg.DealId, msg.GetVoucher().Nonce))
			require.NoError(t, err)
			require.True(t, used)
			nonce, err := a.PolyStoreChainKeeper.RetrievalSessionNonces.Get(ctx, collections.Join(collections.Join(redeemer.String(), msg.DealId), providers[0]))
			require.NoError(t, err)
			require.Equal(t, msg.Nonce, nonce)
			found := 0
			require.NoError(t, a.PolyStoreChainKeeper.RetrievalSessions.Walk(ctx, nil, func(_ []byte, session types.RetrievalSession) (bool, error) {
				if session.DealId != msg.DealId || session.Nonce != msg.Nonce {
					return false, nil
				}
				found++
				require.Equal(t, uint32(2), session.ChallengeVersion)
				require.Equal(t, types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER, session.Funding)
				require.Equal(t, redeemer.String(), session.Payer)
				require.Equal(t, sdkmath.NewInt(7), session.LockedFee)
				payee := msg.AuthorizedProofProvider
				if payee == "" {
					payee = msg.Provider
				}
				require.Equal(t, payee, session.AuthorizedProofProvider)
				require.Equal(t, height, session.OpenedHeight)
				return false, nil
			}))
			require.Equal(t, 1, found)
		})
	}
	accepted("same voucher and session nonce succeed after rollback", open(bound, 1, ""))
	failed("consumed voucher rejects fresh session nonce", "voucher nonce replay rejected", open(bound, 2, ""))
	accepted("fresh wildcard voucher permits assigned deputy", open(voucher(1, 778, "", issuerKey), 2, providers[1]))
	failed("blank signer rejects non-owner issuer", "voucher signature does not match signer", open(voucher(2, 777, "", issuerKey), 1, ""))
	accepted("blank signer falls back to owner", open(voucher(2, 777, "", ownerKey), 1, ""))
	for _, id := range []uint64{1, 2} {
		updated, err := a.PolyStoreChainKeeper.Deals.Get(query(), id)
		require.NoError(t, err)
		require.Equal(t, sdkmath.NewInt(100), updated.EscrowBalance, "requester funding never debits deal escrow")
	}
	for _, provider := range providers {
		address, err := sdk.AccAddressFromBech32(provider)
		require.NoError(t, err)
		require.True(t, a.BankKeeper.GetBalance(query(), address, "stake").IsZero(), "authorization alone does not pay a provider")
	}
}
