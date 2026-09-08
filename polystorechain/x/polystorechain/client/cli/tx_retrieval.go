package cli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/ioutil"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	"github.com/spf13/cobra"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/keeper"
	"polystorechain/x/polystorechain/types"
)

func CmdSignRetrievalReceipt() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sign-retrieval-receipt [deal-id] [provider-addr] [epoch-id] [file-path] [trusted-setup] [mdu0-path] [mdu-index]",
		Short: "Generate and sign a retrieval receipt for a downloaded file",
		Args:  cobra.ExactArgs(7),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := strconv.ParseUint(args[0], 10, 64)
			if err != nil {
				return err
			}
			providerAddr := args[1]
			epochId, err := strconv.ParseUint(args[2], 10, 64)
			if err != nil {
				return err
			}
			filePath := args[3]
			trustedSetupPath := args[4]
			mdu0Path := args[5]
			mduIndex, err := strconv.ParseUint(args[6], 10, 64)
			if err != nil {
				return err
			}
			if mduIndex == 0 {
				return fmt.Errorf("mdu-index must target a user data MDU; MDU #0 and Witness MDUs are metadata")
			}

			// 1. Read File & Compute Proof
			mduBytes, err := ioutil.ReadFile(filePath)
			if err != nil {
				return err
			}

			// Verify size (mock)
			bytesServed := uint64(len(mduBytes))
			rangeStart := uint64(0)
			rangeLen := bytesServed

			if err := crypto_ffi.Init(trustedSetupPath); err != nil {
				return err
			}
			root, err := crypto_ffi.ComputeMduMerkleRoot(mduBytes)
			if err != nil {
				return err
			}
			chunkIndex := uint32(0) // Mock: always chunk 0 of MDU
			commitment, merkleProof, z, y, kzgProofBytes, err := crypto_ffi.ComputeMduProofTest(mduBytes, chunkIndex)
			if err != nil {
				return err
			}

			// Unflatten Merkle Proof
			merklePath := make([][]byte, 0)
			for i := 0; i < len(merkleProof); i += 32 {
				merklePath = append(merklePath, merkleProof[i:i+32])
			}

			// --- Hop 1: MDU #0 root-table proof ---
			mdu0Bytes, err := ioutil.ReadFile(mdu0Path)
			if err != nil {
				return fmt.Errorf("failed to read MDU #0: %w", err)
			}
			rootTableDuCommitment, rootTableDuMerkleFlat, rootTableOpening, _, err := crypto_ffi.ComputeMdu0RootTableProof(mdu0Bytes, mduIndex, root)
			if err != nil {
				return fmt.Errorf("ComputeMdu0RootTableProof failed: %w", err)
			}
			rootTableDuMerklePath := make([][]byte, 0, len(rootTableDuMerkleFlat)/32)
			for i := 0; i < len(rootTableDuMerkleFlat); i += 32 {
				end := i + 32
				if end > len(rootTableDuMerkleFlat) {
					return fmt.Errorf("invalid root-table Merkle proof length")
				}
				rootTableDuMerklePath = append(rootTableDuMerklePath, rootTableDuMerkleFlat[i:end])
			}

			chainedProof := types.ChainedProof{
				MduIndex:              mduIndex,
				MduRootFr:             root,
				ManifestOpening:       rootTableOpening,
				RootTableDuCommitment: rootTableDuCommitment,
				RootTableDuMerklePath: rootTableDuMerklePath,
				BlobCommitment:        commitment,
				MerklePath:            merklePath,
				BlobIndex:             chunkIndex,
				ZValue:                z,
				YValue:                y,
				KzgOpeningProof:       kzgProofBytes,
			}

			// 2. Prepare anti-replay fields
			// For devnet, we derive a monotonically increasing nonce from the local time.
			nonce := uint64(time.Now().UnixNano())
			var expiresAt uint64 = 0 // 0 = no expiry; chain will only enforce expiry if > 0.

			// 3. Sign Data
			// Format: DealID (8) + EpochID (8) + Provider (len) + FilePath (len) + RangeStart (8) + RangeLen (8)
			// + BytesServed (8) + Nonce (8) + ExpiresAt (8) + ProofHash (32)
			buf := make([]byte, 0)
			buf = append(buf, sdk.Uint64ToBigEndian(dealId)...)
			buf = append(buf, sdk.Uint64ToBigEndian(epochId)...)
			buf = append(buf, []byte(providerAddr)...)
			buf = append(buf, []byte(filePath)...)
			buf = append(buf, sdk.Uint64ToBigEndian(rangeStart)...)
			buf = append(buf, sdk.Uint64ToBigEndian(rangeLen)...)
			buf = append(buf, sdk.Uint64ToBigEndian(bytesServed)...)
			buf = append(buf, sdk.Uint64ToBigEndian(nonce)...)
			buf = append(buf, sdk.Uint64ToBigEndian(expiresAt)...)
			if proofHash, err := types.HashChainedProof(&chainedProof); err == nil {
				buf = append(buf, proofHash.Bytes()...)
			}

			// Sign with Keyring
			name := clientCtx.GetFromName()
			if name == "" {
				return fmt.Errorf("--from flag required")
			}

			sig, _, err := clientCtx.Keyring.Sign(name, buf, signing.SignMode_SIGN_MODE_DIRECT)
			if err != nil {
				return err
			}

			// 4. Construct Receipt
			receipt := types.RetrievalReceipt{
				DealId:        dealId,
				EpochId:       epochId,
				Provider:      providerAddr,
				FilePath:      filePath,
				RangeStart:    rangeStart,
				RangeLen:      rangeLen,
				BytesServed:   bytesServed,
				ProofDetails:  chainedProof,
				UserSignature: sig,
				Nonce:         nonce,
				ExpiresAt:     expiresAt,
			}

			// 5. Output JSON
			bz, err := json.MarshalIndent(receipt, "", "  ")
			if err != nil {
				return err
			}

			fmt.Println(string(bz))

			// Optionally write to file if flag provided?
			// For now, stdout is fine or user redirects.
			return nil
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

// The JSON representation includes base64 and field names. Its independent file
// limit bounds decoding; the protobuf transaction must still fit the chain cap.
const retrievalProofFileBytes = 2 * types.MaxTransactionBytes
const retrievalProofMaxSessions = 64
const retrievalSigningReserve = 4096

func CmdSubmitRetrievalProof() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "submit-retrieval-proof [json-file]",
		Short: "Submit a retrieval receipt or one transaction containing session proofs",
		Long: `Submit the existing receipt, receipt batch, or single-session JSON form.
To submit multiple sessions with one signer and transaction, use:
  {"sessions":[{"session_id":"<base64>","proofs":[...]}, ...]}
Each of 1..64 entries uses the single-session JSON encoding. The --from key
supplies every creator; session owners and deals may differ. Session IDs must be
unique. This batches transaction envelopes, not cryptography across sessions.
JSON input is limited to 2 MiB. Unsigned protobuf reserves 4 KiB for signing;
final protobuf is limited to 1 MiB and online block byte/gas limits. Generate-only
output (including offline) uses the 1 MiB / 64,000,000 gas profile ceilings.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) (err error) {
			phase := beginSubmissionPhase(cmd)
			defer phase.finish(&err)
			clientCtx, err := getClientTxContextFn(cmd)
			if err != nil {
				return err
			}
			file, err := os.Open(args[0])
			if err != nil {
				return err
			}
			defer file.Close()
			bz, err := io.ReadAll(io.LimitReader(file, retrievalProofFileBytes+1))
			if err != nil {
				return err
			}
			if len(bz) > retrievalProofFileBytes {
				return fmt.Errorf("retrieval proof JSON exceeds %d bytes", retrievalProofFileBytes)
			}
			msgs, err := retrievalProofMessages(bz, clientCtx.GetFromAddress().String())
			if err != nil {
				return err
			}
			bounded, err := boundRetrievalProofTx(cmd, clientCtx, msgs)
			if err != nil {
				return err
			}
			bounded, err = phase.track(bounded)
			if err != nil {
				return err
			}
			return generateOrBroadcastTxCLIFn(bounded, cmd.Flags(), msgs...)
		},
	}
	flags.AddTxFlagsToCmd(cmd)
	cmd.Flags().String(submissionPhaseFlag, "", "Write a final pre-broadcast failure marker for the invoking gateway")
	return cmd
}

// Read discriminator keys without JSON's usual last-duplicate-wins behavior.
// RawMessage also lets us reject the list count before decoding its proofs.
func retrievalProofObject(bz []byte) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(bz))
	start, err := dec.Token()
	if err != nil || start != json.Delim('{') {
		return nil, fmt.Errorf("retrieval proof must be a JSON object")
	}
	obj := make(map[string]json.RawMessage)
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key := token.(string)
		if _, exists := obj[key]; exists {
			return nil, fmt.Errorf("duplicate JSON field %q", key)
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		obj[key] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("unexpected trailing JSON data")
	}
	return obj, nil
}

func retrievalProofArray(bz []byte, maximum int) ([]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(bz))
	start, err := dec.Token()
	if err != nil || start != json.Delim('[') {
		return nil, fmt.Errorf("expected a nonempty JSON array")
	}
	var entries []json.RawMessage
	for dec.More() {
		if len(entries) == maximum {
			return nil, fmt.Errorf("array count must be 1..%d", maximum)
		}
		var entry json.RawMessage
		if err := dec.Decode(&entry); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("array count must be 1..%d", maximum)
	}
	return entries, nil
}

func decodeRetrievalProofJSON(bz []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(bz))
	dec.DisallowUnknownFields()
	return dec.Decode(out) // retrievalProofObject already required exactly one value.
}

func retrievalProofMessages(bz []byte, creator string) ([]sdk.Msg, error) {
	if creator == "" {
		return nil, fmt.Errorf("--from address is required")
	}
	obj, err := retrievalProofObject(bz)
	if err != nil {
		return nil, err
	}
	discriminator := ""
	for _, key := range []string{"sessions", "session_id", "session_receipt", "receipts"} {
		if _, present := obj[key]; present {
			if discriminator != "" {
				return nil, fmt.Errorf("cannot mix retrieval proof shapes %q and %q", discriminator, key)
			}
			discriminator = key
		}
	}
	if discriminator == "sessions" || discriminator == "session_id" {
		entries := []json.RawMessage{bz}
		if discriminator == "sessions" {
			if len(obj) != 1 {
				return nil, fmt.Errorf("sessions cannot be mixed with other top-level fields")
			}
			entries, err = retrievalProofArray(obj["sessions"], retrievalProofMaxSessions)
			if err != nil {
				return nil, fmt.Errorf("sessions: %w", err)
			}
		}
		if len(entries) == 0 || len(entries) > retrievalProofMaxSessions {
			return nil, fmt.Errorf("session count must be 1..%d", retrievalProofMaxSessions)
		}
		msgs := make([]sdk.Msg, 0, len(entries))
		seen := make(map[string]bool, len(entries))
		for i, entry := range entries {
			fields, err := retrievalProofObject(entry)
			if err != nil {
				return nil, fmt.Errorf("session %d: %w", i, err)
			}
			if fields["session_id"] == nil || fields["proofs"] == nil {
				return nil, fmt.Errorf("session %d requires session_id and proofs", i)
			}
			for field := range fields {
				if field != "session_id" && field != "proofs" && field != "creator" {
					return nil, fmt.Errorf("session %d: unexpected field %q", i, field)
				}
			}
			proofs, err := retrievalProofArray(fields["proofs"], keeper.MaxProofsPerMessage)
			if err != nil {
				return nil, fmt.Errorf("session %d proofs: %w", i, err)
			}
			for _, proof := range proofs {
				if len(proof) > keeper.MaxProofEnvelopeBytes {
					return nil, fmt.Errorf("session %d: proof JSON exceeds %d bytes", i, keeper.MaxProofEnvelopeBytes)
				}
			}
			var msg types.MsgSubmitRetrievalSessionProof
			if err := decodeRetrievalProofJSON(entry, &msg); err != nil {
				return nil, fmt.Errorf("session %d: %w", i, err)
			}
			if len(msg.SessionId) != 32 {
				return nil, fmt.Errorf("session %d: session_id must encode 32 bytes", i)
			}
			if seen[string(msg.SessionId)] {
				return nil, fmt.Errorf("duplicate session_id at entry %d", i)
			}
			seen[string(msg.SessionId)] = true
			if err := keeper.ValidateProofCount(uint64(len(msg.Proofs))); err != nil {
				return nil, fmt.Errorf("session %d: %w", i, err)
			}
			msg.Creator = creator
			msgs = append(msgs, &msg)
		}
		return msgs, nil
	}
	msg := &types.MsgProveLiveness{Creator: creator}
	switch discriminator {
	case "session_receipt":
		var session types.RetrievalSessionProof
		if err := decodeRetrievalProofJSON(bz, &session); err != nil {
			return nil, err
		}
		msg.DealId, msg.EpochId = session.SessionReceipt.DealId, session.SessionReceipt.EpochId
		msg.ProofType = &types.MsgProveLiveness_SessionProof{SessionProof: &session}
	case "receipts":
		var batch types.RetrievalReceiptBatch
		if err := decodeRetrievalProofJSON(bz, &batch); err != nil {
			return nil, err
		}
		if len(batch.Receipts) == 0 {
			return nil, fmt.Errorf("empty receipts batch")
		}
		msg.DealId, msg.EpochId = batch.Receipts[0].DealId, batch.Receipts[0].EpochId
		for _, receipt := range batch.Receipts {
			if receipt.DealId != msg.DealId || receipt.EpochId != msg.EpochId {
				return nil, fmt.Errorf("all receipts in batch must have same deal_id and epoch_id")
			}
		}
		msg.ProofType = &types.MsgProveLiveness_UserReceiptBatch{UserReceiptBatch: &batch}
	default:
		var receipt types.RetrievalReceipt
		if err := decodeRetrievalProofJSON(bz, &receipt); err != nil {
			return nil, err
		}
		msg.DealId, msg.EpochId = receipt.DealId, receipt.EpochId
		msg.ProofType = &types.MsgProveLiveness_UserReceipt{UserReceipt: &receipt}
	}
	return []sdk.Msg{msg}, nil
}

// Wrap the SDK encoders, not its signer or broadcaster. The JSON encoder checks
// protobuf bytes, so base64 inflation in --generate-only output is not a limit.
type retrievalProofTxConfig struct {
	client.TxConfig
	maxBytes int
	maxGas   uint64
}

func (cfg retrievalProofTxConfig) encode(transaction sdk.Tx, reserve int) ([]byte, error) {
	feeTx, ok := transaction.(sdk.FeeTx)
	if !ok || feeTx.GetGas() > cfg.maxGas {
		return nil, fmt.Errorf("retrieval transaction gas exceeds %d", cfg.maxGas)
	}
	bz, err := cfg.TxConfig.TxEncoder()(transaction)
	if err != nil {
		return nil, err
	}
	if len(bz) > cfg.maxBytes-reserve {
		return nil, fmt.Errorf("retrieval transaction exceeds %d protobuf bytes (%d reserved for signing)", cfg.maxBytes, reserve)
	}
	return bz, nil
}

func (cfg retrievalProofTxConfig) TxEncoder() sdk.TxEncoder {
	return func(transaction sdk.Tx) ([]byte, error) { return cfg.encode(transaction, 0) }
}

func (cfg retrievalProofTxConfig) TxJSONEncoder() sdk.TxEncoder {
	return func(transaction sdk.Tx) ([]byte, error) {
		if _, err := cfg.encode(transaction, retrievalSigningReserve); err != nil {
			return nil, err
		}
		return cfg.TxConfig.TxJSONEncoder()(transaction)
	}
}

func boundRetrievalProofTx(cmd *cobra.Command, clientCtx client.Context, msgs []sdk.Msg) (client.Context, error) {
	if clientCtx.IsAux {
		return clientCtx, fmt.Errorf("retrieval proof submission requires the transaction signer, not --aux")
	}
	if clientCtx.TxConfig == nil {
		return clientCtx, fmt.Errorf("transaction encoding configuration is required")
	}
	cfg := retrievalProofTxConfig{TxConfig: clientCtx.TxConfig, maxBytes: types.MaxTransactionBytes, maxGas: uint64(types.MaxRetrievalV2BlockGas)}
	if !clientCtx.GenerateOnly {
		node, err := clientCtx.GetNode()
		if err != nil {
			return clientCtx, fmt.Errorf("cannot obtain retrieval transaction block limits: %w", err)
		}
		querier, ok := node.(interface {
			ConsensusParams(context.Context, *int64) (*coretypes.ResultConsensusParams, error)
		})
		if !ok {
			return clientCtx, fmt.Errorf("node does not provide consensus block limits")
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
		defer cancel()
		result, err := querier.ConsensusParams(ctx, nil)
		if err != nil || result == nil {
			return clientCtx, fmt.Errorf("cannot obtain retrieval transaction block limits: %v", err)
		}
		block := result.ConsensusParams.Block
		if block.MaxBytes <= retrievalSigningReserve+10 || block.MaxGas == 0 || block.MaxGas < -1 {
			return clientCtx, fmt.Errorf("invalid consensus block byte/gas limits")
		}
		// Reserve the repeated-bytes protobuf framing as well as the envelope.
		if block.MaxBytes-10 < int64(cfg.maxBytes) {
			cfg.maxBytes = int(block.MaxBytes - 10)
		}
		if block.MaxGas > 0 && uint64(block.MaxGas) < cfg.maxGas {
			cfg.maxGas = uint64(block.MaxGas)
		}
	}
	gasFlag, err := cmd.Flags().GetString(flags.FlagGas)
	if err != nil {
		return clientCtx, err
	}
	gas, err := flags.ParseGasSetting(gasFlag)
	if err != nil {
		return clientCtx, err
	}
	if gas.Gas > cfg.maxGas {
		return clientCtx, fmt.Errorf("retrieval transaction gas exceeds %d", cfg.maxGas)
	}
	adjustment, err := cmd.Flags().GetFloat64(flags.FlagGasAdjustment)
	if err != nil || math.IsNaN(adjustment) || math.IsInf(adjustment, 0) || adjustment <= 0 {
		return clientCtx, fmt.Errorf("gas adjustment must be finite and positive")
	}
	var proofCount uint64
	for _, msg := range msgs {
		if session, ok := msg.(*types.MsgSubmitRetrievalSessionProof); ok {
			proofCount += uint64(len(session.Proofs))
		}
	}
	if proofCount > cfg.maxGas/keeper.ProofCryptoGas {
		return clientCtx, fmt.Errorf("session proofs exceed the %d gas transaction ceiling", cfg.maxGas)
	}
	bounded := clientCtx.WithTxConfig(cfg)
	factory, err := tx.NewFactoryCLI(bounded, cmd.Flags())
	if err != nil {
		return clientCtx, err
	}
	unsigned, err := factory.BuildUnsignedTx(msgs...)
	if err != nil {
		return clientCtx, err
	}
	if _, err := cfg.encode(unsigned.GetTx(), retrievalSigningReserve); err != nil {
		return clientCtx, err
	}
	return bounded, nil
}

func CmdOpenRetrievalSession() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "open-retrieval-session",
		Short: "Open a retrieval session for a blob range",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			dealId, err := cmd.Flags().GetUint64("deal-id")
			if err != nil {
				return err
			}
			provider, err := cmd.Flags().GetString("provider")
			if err != nil {
				return err
			}
			manifestHex, err := cmd.Flags().GetString("manifest-root")
			if err != nil {
				return err
			}
			manifestRoot, err := decodeHexBytes(manifestHex, types.POLYFS_ROOT_SIZE)
			if err != nil {
				return err
			}
			startMduIndex, err := cmd.Flags().GetUint64("start-mdu-index")
			if err != nil {
				return err
			}
			startBlobIndex, err := cmd.Flags().GetUint32("start-blob-index")
			if err != nil {
				return err
			}
			blobCount, err := cmd.Flags().GetUint64("blob-count")
			if err != nil {
				return err
			}
			nonce, err := cmd.Flags().GetUint64("nonce")
			if err != nil {
				return err
			}
			if nonce == 0 && !cmd.Flags().Changed("nonce") {
				nonce = uint64(time.Now().UnixNano())
			}
			expiresAt, err := cmd.Flags().GetUint64("expires-at")
			if err != nil {
				return err
			}

			version, err := cmd.Flags().GetUint32("challenge-version")
			if err != nil {
				return err
			}
			payee, err := cmd.Flags().GetString("authorized-proof-provider")
			if err != nil {
				return err
			}
			if version != 0 && version != 2 {
				return fmt.Errorf("challenge-version must be 0 (legacy) or 2")
			}
			if payee != "" {
				address, err := sdk.AccAddressFromBech32(payee)
				if version != 2 || err != nil || len(address) != 20 || address.String() != payee {
					return fmt.Errorf("authorized-proof-provider requires v2 and a canonical 20-byte provider address")
				}
			}

			if strings.TrimSpace(provider) == "" {
				return fmt.Errorf("provider is required")
			}
			if blobCount == 0 {
				return fmt.Errorf("blob-count must be > 0")
			}

			msg := types.MsgOpenRetrievalSession{
				Creator:                 clientCtx.GetFromAddress().String(),
				DealId:                  dealId,
				Provider:                provider,
				ManifestRoot:            manifestRoot,
				StartMduIndex:           startMduIndex,
				StartBlobIndex:          startBlobIndex,
				BlobCount:               blobCount,
				Nonce:                   nonce,
				ExpiresAt:               expiresAt,
				ChallengeVersion:        version,
				AuthorizedProofProvider: payee,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	cmd.Flags().Uint32("challenge-version", 0, "Challenge version: 2 for secured retrieval, 0 for legacy compatibility")
	cmd.Flags().String("authorized-proof-provider", "", "Immutable v2 proof payee (default: assigned provider)")
	cmd.Flags().Uint64("deal-id", 0, "Deal ID")
	cmd.Flags().String("provider", "", "Assigned provider address")
	cmd.Flags().String("manifest-root", "", "PolyFS root (32-byte hex)")
	cmd.Flags().Uint64("start-mdu-index", 0, "Starting MDU index")
	cmd.Flags().Uint32("start-blob-index", 0, "Starting blob index within the MDU")
	cmd.Flags().Uint64("blob-count", 0, "Number of blobs in the retrieval range")
	cmd.Flags().Uint64("nonce", 0, "Nonce (monotonic per owner/deal/provider)")
	cmd.Flags().Uint64("expires-at", 0, "Expiry block height (0 = no expiry)")
	_ = cmd.MarkFlagRequired("deal-id")
	_ = cmd.MarkFlagRequired("provider")
	_ = cmd.MarkFlagRequired("manifest-root")
	_ = cmd.MarkFlagRequired("blob-count")
	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func CmdCancelRetrievalSession() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cancel-retrieval-session [session-id]",
		Short: "Cancel an expired retrieval session and unlock fees",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			clientCtx, err := client.GetClientTxContext(cmd)
			if err != nil {
				return err
			}

			sessionID, err := decodeSessionID(args[0])
			if err != nil {
				return err
			}

			msg := types.MsgCancelRetrievalSession{
				Creator:   clientCtx.GetFromAddress().String(),
				SessionId: sessionID,
			}

			return tx.GenerateOrBroadcastTxCLI(clientCtx, cmd.Flags(), &msg)
		},
	}

	flags.AddTxFlagsToCmd(cmd)
	return cmd
}

func decodeHexBytes(value string, expectedLen int) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, fmt.Errorf("hex value is required")
	}
	raw := strings.TrimPrefix(trimmed, "0x")
	if len(raw)%2 != 0 || !isHexString(raw) {
		return nil, fmt.Errorf("invalid hex value: %s", value)
	}
	bz, err := hex.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	if expectedLen > 0 && len(bz) != expectedLen {
		return nil, fmt.Errorf("expected %d bytes, got %d", expectedLen, len(bz))
	}
	return bz, nil
}

func decodeSessionID(value string) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, fmt.Errorf("session id is required")
	}

	raw := strings.TrimPrefix(trimmed, "0x")
	if trimmed != raw || len(raw) == 64 {
		if isHexString(raw) {
			bz, err := hex.DecodeString(raw)
			if err == nil {
				if len(bz) != 32 {
					return nil, fmt.Errorf("session id must be 32 bytes")
				}
				return bz, nil
			}
		}
	}

	for _, decoder := range []func(string) ([]byte, error){
		base64.StdEncoding.DecodeString,
		base64.RawStdEncoding.DecodeString,
	} {
		if bz, err := decoder(trimmed); err == nil {
			if len(bz) != 32 {
				return nil, fmt.Errorf("session id must be 32 bytes")
			}
			return bz, nil
		}
	}

	if isHexString(raw) {
		if bz, err := hex.DecodeString(raw); err == nil {
			if len(bz) != 32 {
				return nil, fmt.Errorf("session id must be 32 bytes")
			}
			return bz, nil
		}
	}

	return nil, fmt.Errorf("invalid session id: expected hex or base64")
}

func isHexString(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}
