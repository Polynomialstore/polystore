package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

// The gateway now uses the shared chain context validator. Match the chain
// account encoding before decoding addresses; SDK defaults use cosmos instead.
func init() { sdk.GetConfig().SetBech32PrefixForAccount("nil", "nilpub") }

const committedHeightHeader = "x-cosmos-block-height"
const maxSessionQueryBytes = 64 * 1024

var errLCDNotFound = errors.New("LCD object not found")
var errChallengeNotReady = errors.New("retrieval challenge not yet eligible")

// readLCDJSON uses the configured trusted chain LCD. Providers and local cache
// files cannot supply this authority. A requested height must be echoed exactly.
// Missing height is tolerated only for legacy callers; v2 requires it below.
func readLCDJSON(ctx context.Context, path string, height uint64, maxBytes int64) ([]byte, uint64, error) {
	if height > math.MaxInt64 || maxBytes < 1 {
		return nil, 0, fmt.Errorf("invalid query bounds")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(lcdBase, "/")+path, nil)
	if err != nil {
		return nil, 0, err
	}
	if height != 0 {
		req.Header.Set(committedHeightHeader, strconv.FormatUint(height, 10))
	}
	resp, err := lcdHTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, 0, errLCDNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("LCD returned HTTP %d", resp.StatusCode)
	}
	var committed uint64
	if len(resp.Header.Values(committedHeightHeader)) > 1 {
		return nil, 0, fmt.Errorf("ambiguous committed LCD height")
	}
	if raw := resp.Header.Get(committedHeightHeader); raw != "" {
		committed, err = strconv.ParseUint(raw, 10, 64)
		if err != nil || committed == 0 || committed > math.MaxInt64 || strconv.FormatUint(committed, 10) != raw {
			return nil, 0, fmt.Errorf("invalid committed LCD height")
		}
	}
	if height != 0 && committed != height {
		return nil, 0, fmt.Errorf("LCD response height does not match requested height")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, 0, err
	}
	if int64(len(body)) > maxBytes {
		return nil, 0, fmt.Errorf("LCD response exceeds limit")
	}
	body = bytes.TrimSpace(body)
	if validateJSONObject(body) != nil {
		return nil, 0, fmt.Errorf("LCD response must contain one complete JSON object")
	}
	return body, committed, nil
}

func queryRetrievalSession(ctx context.Context, sessionID string) (*types.QueryGetRetrievalSessionResponse, uint64, error) {
	_, id, err := parseSessionIDHex(sessionID)
	if err != nil {
		return nil, 0, err
	}
	path := "/polystorechain/polystorechain/v1/retrieval-sessions/" + base64.URLEncoding.EncodeToString(id)
	body, height, err := readLCDJSON(ctx, path, 0, maxSessionQueryBytes)
	if errors.Is(err, errLCDNotFound) {
		return nil, 0, ErrSessionNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	var response types.QueryGetRetrievalSessionResponse
	if err := jsonpb.Unmarshal(bytes.NewReader(body), &response); err != nil {
		return nil, 0, fmt.Errorf("invalid session query: %w", err)
	}
	s := response.Session
	if !bytes.Equal(s.SessionId, id) || len(s.ManifestRoot) != 32 || s.OpenedHeight < 1 || s.UpdatedHeight < s.OpenedHeight || s.ExpiresAt < uint64(s.OpenedHeight) || s.ExpiresAt > math.MaxInt64 {
		return nil, 0, fmt.Errorf("invalid session identity or heights")
	}
	if _, ok := types.RetrievalSessionStatus_name[int32(s.Status)]; !ok || s.Status == types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_UNSPECIFIED {
		return nil, 0, fmt.Errorf("unknown session status")
	}
	if s.BlobCount == 0 || s.BlobCount > math.MaxUint64/types.BlobSizeBytes || s.TotalBytes != s.BlobCount*types.BlobSizeBytes {
		return nil, 0, fmt.Errorf("invalid session byte coverage")
	}
	if height != 0 && (uint64(s.OpenedHeight) > height || uint64(s.UpdatedHeight) > height) {
		return nil, 0, fmt.Errorf("session state exceeds committed height")
	}
	return &response, height, nil
}

type frozenRetrievalSession struct {
	Session types.RetrievalSession
	Height  uint64
	Context retrievalchallenge.Context
	Hash    [32]byte
	Seed    [32]byte
}

func fetchFrozenRetrievalSession(ctx context.Context, sessionID string) (*frozenRetrievalSession, error) {
	r, height, err := queryRetrievalSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return freezeRetrievalSessionResponse(r, height)
}

func frozenRetrievalIdentity(r *types.QueryGetRetrievalSessionResponse, height uint64) (*frozenRetrievalSession, error) {
	if height == 0 {
		return nil, fmt.Errorf("session query lacks committed height")
	}
	c, err := types.RetrievalChallengeContext(r.Session)
	if err != nil {
		return nil, err
	}
	if c.ChainID != chainID {
		return nil, fmt.Errorf("session belongs to a different chain")
	}
	owner, err := sdk.AccAddressFromBech32(r.Session.Owner)
	if err != nil || len(owner) != 20 || owner.String() != r.Session.Owner {
		return nil, fmt.Errorf("invalid session owner")
	}
	canonical, _ := c.Bytes()
	hash, _ := c.Hash()
	if !bytes.Equal(canonical, r.ChallengeContext) || !bytes.Equal(hash[:], r.ChallengeContextHash) {
		return nil, fmt.Errorf("session challenge context does not match frozen state")
	}
	return &frozenRetrievalSession{Session: r.Session, Height: height, Context: c, Hash: hash}, nil
}

func freezeRetrievalSessionResponse(r *types.QueryGetRetrievalSessionResponse, height uint64) (*frozenRetrievalSession, error) {
	out, err := frozenRetrievalIdentity(r, height)
	if err != nil {
		return nil, err
	}
	c := out.Context

	if len(r.ChallengeSeed) != 32 {
		if len(r.ChallengeSeed) == 0 && height < c.Window.Anchor {
			return nil, errChallengeNotReady
		}
		return nil, fmt.Errorf("missing or malformed retained challenge seed")
	}
	if height < c.Window.First {
		return nil, errChallengeNotReady
	}
	copy(out.Seed[:], r.ChallengeSeed)
	return out, nil
}

const maxRetainedGenerations = types.MaxRetrievalSessionGenerations + 2*types.MaxStorageAuditAssignments
const maxRetentionDealsPerPass = 64

type retainedRootKey struct {
	Deal uint64
	Root [32]byte
}

type retentionSnapshot struct {
	Height  uint64
	Keep    map[retainedRootKey]struct{}
	Current map[uint64]types.Deal
}

// fetchRetentionSnapshot deliberately bypasses the latest-deal TTL cache. A
// single unavailable/malformed required query invalidates the entire deletion
// decision, including apparently unreferenced or locally provisional roots.
func fetchRetentionSnapshot(ctx context.Context, dealIDs []uint64) (*retentionSnapshot, error) {
	if len(dealIDs) == 0 || len(dealIDs) > maxRetentionDealsPerPass {
		return nil, fmt.Errorf("invalid retention pass size")
	}
	body, height, err := readLCDJSON(ctx, "/polystorechain/polystorechain/v1/retained-generations", 0, 256*1024)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, err
	}
	list := bytes.TrimSpace(fields["generations"])
	if len(list) == 0 || list[0] != '[' {
		return nil, fmt.Errorf("retention inventory must be an explicit array")
	}
	var response types.QueryRetainedGenerationsResponse
	if err := jsonpb.Unmarshal(bytes.NewReader(body), &response); err != nil {
		return nil, err
	}
	if height == 0 || height != response.CommittedHeight || uint64(len(response.Generations)) > maxRetainedGenerations {
		return nil, fmt.Errorf("invalid retention height or inventory bound")
	}
	out := &retentionSnapshot{Height: height, Keep: make(map[retainedRootKey]struct{}), Current: make(map[uint64]types.Deal)}
	type generationKey struct{ deal, generation uint64 }
	roots := make(map[generationKey][32]byte, len(response.Generations))
	var previous generationKey
	for i, g := range response.Generations {
		key := generationKey{g.DealId, g.Generation}
		if len(g.ManifestRoot) != 32 || (i > 0 && (key.deal < previous.deal || (key.deal == previous.deal && key.generation <= previous.generation))) {
			return nil, fmt.Errorf("malformed, duplicate or unsorted retained generation")
		}
		root := [32]byte(g.ManifestRoot)
		roots[key] = root
		out.Keep[retainedRootKey{g.DealId, root}] = struct{}{}
		previous = key
	}
	for _, id := range dealIDs {
		if _, exists := out.Current[id]; exists {
			return nil, fmt.Errorf("duplicate local deal in retention pass")
		}
		d, _, err := queryRetrievalDeal(ctx, id, height)
		if err != nil {
			return nil, err
		}
		if len(d.ManifestRoot) == 0 {
			if d.TotalMdus != 0 || d.WitnessMdus != 0 {
				return nil, fmt.Errorf("missing current root for allocated deal")
			}
		} else {
			if len(d.ManifestRoot) != 32 {
				return nil, fmt.Errorf("malformed current root")
			}
			root := [32]byte(d.ManifestRoot)
			if retained, exists := roots[generationKey{id, d.CurrentGen}]; exists && retained != root {
				return nil, fmt.Errorf("current and retained roots conflict for one generation")
			}
			out.Keep[retainedRootKey{id, root}] = struct{}{}
		}
		out.Current[id] = *d
	}
	return out, nil
}

// One typed deal at one committed height supplies metadata bounds. A local
// sidecar and the latest-deal TTL cache cannot extend the unpaid metadata range.
func queryRetrievalDeal(ctx context.Context, id, height uint64) (*types.Deal, uint64, error) {
	body, committed, err := readLCDJSON(ctx, "/polystorechain/polystorechain/v1/deals/"+strconv.FormatUint(id, 10), height, 64*1024)
	if err != nil {
		return nil, 0, err
	}
	var response types.QueryGetDealResponse
	if err := jsonpb.Unmarshal(bytes.NewReader(body), &response); err != nil {
		return nil, 0, err
	}
	d := response.Deal
	if d == nil || d.Id != id || d.TotalMdus > 65537 || d.WitnessMdus > 65536 || (d.TotalMdus > 0 && d.WitnessMdus >= d.TotalMdus) ||
		(len(d.ManifestRoot) != 0 && len(d.ManifestRoot) != 32) || (len(d.ManifestRoot) == 0 && (d.TotalMdus != 0 || d.WitnessMdus != 0)) {
		return nil, 0, fmt.Errorf("malformed committed deal")
	}
	return d, committed, nil
}

// All callers cap bytes before this check. Reject duplicate keys and malformed
// UTF-8 instead of allowing decoders to choose different signed/query values.
func validateJSONObject(body []byte) error {
	if !utf8.Valid(body) {
		return fmt.Errorf("invalid JSON UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return fmt.Errorf("expected JSON object")
	}
	var consume func(json.Delim, int) error
	consume = func(open json.Delim, depth int) error {
		if depth > 64 {
			return fmt.Errorf("JSON nesting exceeds limit")
		}
		var keys map[string]struct{}
		if open == '{' {
			keys = make(map[string]struct{})
		}
		for d.More() {
			if open == '{' {
				token, err := d.Token()
				if err != nil {
					return err
				}
				key, ok := token.(string)
				if !ok {
					return fmt.Errorf("invalid JSON object key")
				}
				// Struct decoders accept case variants and protobuf camel/snake
				// aliases. Two spellings must not choose different authority.
				alias := strings.ToLower(strings.ReplaceAll(key, "_", ""))
				if _, exists := keys[alias]; exists {
					return fmt.Errorf("duplicate JSON key %q", key)
				}
				keys[alias] = struct{}{}
			}
			token, err := d.Token()
			if err != nil {
				return err
			}
			if delim, ok := token.(json.Delim); ok {
				if err := consume(delim, depth+1); err != nil {
					return err
				}
			}
		}
		end, err := d.Token()
		if err != nil {
			return err
		}
		if (open == '{' && end != json.Delim('}')) || (open == '[' && end != json.Delim(']')) {
			return fmt.Errorf("invalid JSON container")
		}
		return nil
	}
	if err := consume('{', 1); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return fmt.Errorf("trailing JSON data")
	}
	return nil
}
