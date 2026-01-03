package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

const s3XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"

type s3ErrorEnvelope struct {
	XMLName xml.Name `xml:"Error"`
	Code    string   `xml:"Code"`
	Message string   `xml:"Message"`
}

func writeS3Error(w http.ResponseWriter, status int, code string, message string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_ = xml.NewEncoder(w).Encode(&s3ErrorEnvelope{
		Code:    code,
		Message: message,
	})
}

type s3Bucket struct {
	Name         string `xml:"Name"`
	CreationDate string `xml:"CreationDate,omitempty"`
}

type s3Buckets struct {
	Buckets []s3Bucket `xml:"Bucket"`
}

type s3Owner struct {
	ID          string `xml:"ID,omitempty"`
	DisplayName string `xml:"DisplayName,omitempty"`
}

type s3ListBucketsResult struct {
	XMLName xml.Name  `xml:"ListAllMyBucketsResult"`
	XMLNS   string    `xml:"xmlns,attr"`
	Owner   s3Owner   `xml:"Owner"`
	Buckets s3Buckets `xml:"Buckets"`
}

type s3ObjectEntry struct {
	Key          string `xml:"Key"`
	LastModified string `xml:"LastModified,omitempty"`
	ETag         string `xml:"ETag,omitempty"`
	Size         int64  `xml:"Size"`
	StorageClass string `xml:"StorageClass,omitempty"`
}

type s3ListObjectsResult struct {
	XMLName          xml.Name        `xml:"ListBucketResult"`
	XMLNS            string          `xml:"xmlns,attr"`
	Name             string          `xml:"Name"`
	Prefix           string          `xml:"Prefix,omitempty"`
	KeyCount         int             `xml:"KeyCount"`
	MaxKeys          int             `xml:"MaxKeys"`
	IsTruncated      bool            `xml:"IsTruncated"`
	Contents         []s3ObjectEntry `xml:"Contents"`
	NextMarker       string          `xml:"NextMarker,omitempty"`
	Continuation     string          `xml:"ContinuationToken,omitempty"`
	NextContinuation string          `xml:"NextContinuationToken,omitempty"`
}

func registerS3Routes(r *mux.Router) {
	// Minimal path-style S3 compatibility for enterprise tooling.
	// Bucket naming convention: "deal-<id>" (or just "<id>").
	//
	// NOTE: These routes are intentionally registered last, so /gateway/*, /sp/*,
	// /health, etc. keep precedence.
	r.HandleFunc("/", S3ListBuckets).Methods(http.MethodGet)
	r.HandleFunc("/{bucket}", S3HeadBucket).Methods(http.MethodHead)
	r.HandleFunc("/{bucket}", S3ListObjects).Methods(http.MethodGet)
	r.HandleFunc("/{bucket}/{key:.*}", S3PutObject).Methods(http.MethodPut)
	r.HandleFunc("/{bucket}/{key:.*}", S3GetObject).Methods(http.MethodGet, http.MethodHead)
	r.HandleFunc("/{bucket}/{key:.*}", S3DeleteObject).Methods(http.MethodDelete)
}

func s3BucketToDealID(bucket string) (uint64, error) {
	b := strings.TrimSpace(bucket)
	if b == "" {
		return 0, fmt.Errorf("empty bucket")
	}
	if strings.HasPrefix(b, "deal-") {
		b = strings.TrimPrefix(b, "deal-")
	}
	id, err := strconv.ParseUint(b, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("bucket must be deal-<id>")
	}
	return id, nil
}

func s3DealIDToBucket(id uint64) string {
	return fmt.Sprintf("deal-%d", id)
}

func fetchDealIDsFromLCD(ctx context.Context) ([]uint64, error) {
	url := fmt.Sprintf("%s/nilchain/nilchain/v1/deals?pagination.limit=1000", lcdBase)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := lcdHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("LCD request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound {
			return nil, nil
		}
		return nil, fmt.Errorf("LCD returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload struct {
		Deals []map[string]any `json:"deals"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("failed to decode LCD response: %w", err)
	}

	out := make([]uint64, 0, len(payload.Deals))
	seen := make(map[uint64]struct{}, len(payload.Deals))
	for _, deal := range payload.Deals {
		raw := deal["id"]
		var id uint64
		switch v := raw.(type) {
		case string:
			parsed, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
			if err != nil {
				continue
			}
			id = parsed
		case float64:
			if v < 0 {
				continue
			}
			id = uint64(v)
		default:
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

func S3ListBuckets(w http.ResponseWriter, r *http.Request) {
	ids, err := fetchDealIDsFromLCD(r.Context())
	if err != nil {
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	buckets := make([]s3Bucket, 0, len(ids))
	for _, id := range ids {
		buckets = append(buckets, s3Bucket{
			Name:         s3DealIDToBucket(id),
			CreationDate: now,
		})
	}

	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusOK)
	_ = xml.NewEncoder(w).Encode(&s3ListBucketsResult{
		XMLNS: s3XMLNS,
		Owner: s3Owner{
			ID:          "nilstore",
			DisplayName: "nilstore",
		},
		Buckets: s3Buckets{Buckets: buckets},
	})
}

func S3HeadBucket(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	dealID, err := s3BucketToDealID(vars["bucket"])
	if err != nil {
		writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
		return
	}
	_, _, err = fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}
	w.WriteHeader(http.StatusOK)
}

func S3ListObjects(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bucket := strings.TrimSpace(vars["bucket"])
	dealID, err := s3BucketToDealID(bucket)
	if err != nil {
		writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
		return
	}

	_, cid, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}
	if strings.TrimSpace(cid) == "" {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusOK)
		_ = xml.NewEncoder(w).Encode(&s3ListObjectsResult{
			XMLNS:       s3XMLNS,
			Name:        bucket,
			KeyCount:    0,
			MaxKeys:     1000,
			IsTruncated: false,
		})
		return
	}

	manifestRoot, err := parseManifestRoot(cid)
	if err != nil {
		writeS3Error(w, http.StatusInternalServerError, "InternalError", "invalid manifest_root on chain")
		return
	}
	dealDir, err := resolveDealDirForDeal(dealID, manifestRoot, cid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket has no slab on disk")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}

	entry, err := loadSlabIndex(dealDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket has no slab on disk")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}

	q := r.URL.Query()
	prefix := strings.TrimSpace(q.Get("prefix"))
	maxKeys := 1000
	if raw := strings.TrimSpace(q.Get("max-keys")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			maxKeys = parsed
		}
	}

	keys := make([]string, 0, len(entry.files))
	for k := range entry.files {
		if prefix == "" || strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	isTruncated := false
	if len(keys) > maxKeys {
		isTruncated = true
		keys = keys[:maxKeys]
	}

	modTime := time.Unix(0, entry.mdu0ModTime).UTC().Format(time.RFC3339)
	contents := make([]s3ObjectEntry, 0, len(keys))
	for _, k := range keys {
		info := entry.files[k]
		contents = append(contents, s3ObjectEntry{
			Key:          k,
			LastModified: modTime,
			Size:         int64(info.Length),
			StorageClass: "STANDARD",
		})
	}

	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusOK)
	_ = xml.NewEncoder(w).Encode(&s3ListObjectsResult{
		XMLNS:       s3XMLNS,
		Name:        bucket,
		Prefix:      prefix,
		KeyCount:    len(contents),
		MaxKeys:     maxKeys,
		IsTruncated: isTruncated,
		Contents:    contents,
	})
}

func S3GetObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	dealID, err := s3BucketToDealID(vars["bucket"])
	if err != nil {
		writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
		return
	}

	key := vars["key"]
	filePath, err := validateNilfsFilePath(key)
	if err != nil {
		writeS3Error(w, http.StatusBadRequest, "InvalidArgument", err.Error())
		return
	}

	_, cid, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}
	if strings.TrimSpace(cid) == "" {
		writeS3Error(w, http.StatusNotFound, "NoSuchKey", "object not found")
		return
	}

	manifestRoot, err := parseManifestRoot(cid)
	if err != nil {
		writeS3Error(w, http.StatusInternalServerError, "InternalError", "invalid manifest_root on chain")
		return
	}
	dealDir, err := resolveDealDirForDeal(dealID, manifestRoot, cid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeS3Error(w, http.StatusNotFound, "NoSuchKey", "slab not found on disk")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}

	rangeHeader := strings.TrimSpace(r.Header.Get("Range"))
	var rangeStart uint64
	var rangeLen uint64
	isRange := false
	if rangeHeader != "" {
		start, length, perr := parseHTTPRange(rangeHeader)
		if perr != nil {
			writeS3Error(w, http.StatusRequestedRangeNotSatisfiable, "InvalidRange", perr.Error())
			return
		}
		rangeStart = start
		rangeLen = length
		isRange = true
	}

	reader, _, _, _, segmentLen, fileLen, err := resolveNilfsFileSegmentForFetch(dealDir, filePath, rangeStart, rangeLen)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeS3Error(w, http.StatusNotFound, "NoSuchKey", "object not found")
			return
		}
		if strings.Contains(err.Error(), "rangeStart beyond EOF") {
			writeS3Error(w, http.StatusRequestedRangeNotSatisfiable, "InvalidRange", "range start beyond EOF")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}
	defer reader.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatUint(segmentLen, 10))

	if isRange {
		end := rangeStart + segmentLen - 1
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", rangeStart, end, fileLen))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	if r.Method == http.MethodHead {
		return
	}

	_, _ = io.Copy(w, reader)
}

func S3PutObject(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	dealID, err := s3BucketToDealID(vars["bucket"])
	if err != nil {
		writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
		return
	}

	key := vars["key"]
	filePath, err := validateNilfsFilePath(key)
	if err != nil {
		writeS3Error(w, http.StatusBadRequest, "InvalidArgument", err.Error())
		return
	}

	_, chainCID, err := fetchDealOwnerAndCID(dealID)
	if err != nil {
		if errors.Is(err, ErrDealNotFound) {
			writeS3Error(w, http.StatusNotFound, "NoSuchBucket", "bucket not found")
			return
		}
		writeS3Error(w, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}

	ingestCtx, cancel := context.WithTimeout(r.Context(), uploadIngestTimeout)
	defer cancel()
	if ingestCtx.Err() != nil {
		writeS3Error(w, http.StatusRequestTimeout, "RequestTimeout", "request canceled")
		return
	}

	tmp, err := os.CreateTemp(uploadDir, "s3-put-*")
	if err != nil {
		writeS3Error(w, http.StatusInternalServerError, "InternalError", "failed to create temp file")
		return
	}
	tmpPath := tmp.Name()
	hasher := sha256.New()

	written, copyErr := io.Copy(io.MultiWriter(tmp, hasher), r.Body)
	if closeErr := tmp.Close(); closeErr != nil && copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		writeS3Error(w, http.StatusInternalServerError, "InternalError", "failed to write temp file")
		return
	}
	if written <= 0 {
		_ = os.Remove(tmpPath)
		writeS3Error(w, http.StatusBadRequest, "InvalidArgument", "empty object")
		return
	}
	defer os.Remove(tmpPath)

	serviceHint, err := fetchDealServiceHintFromLCD(ingestCtx, dealID)
	if err != nil {
		writeS3Error(w, http.StatusInternalServerError, "InternalError", "failed to fetch deal service_hint")
		return
	}
	stripe, err := stripeParamsFromHint(serviceHint)
	if err != nil {
		writeS3Error(w, http.StatusInternalServerError, "InternalError", "invalid deal service_hint")
		return
	}
	if stripe.mode != 2 {
		writeS3Error(w, http.StatusBadRequest, "InvalidArgument", "S3 adapter only supports Mode 2 deals in this devnet build")
		return
	}

	var res *mode2IngestResult
	if strings.TrimSpace(chainCID) == "" {
		res, err = mode2IngestAndUploadNewDeal(ingestCtx, tmpPath, dealID, serviceHint, filePath)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				writeS3Error(w, http.StatusRequestTimeout, "RequestTimeout", err.Error())
				return
			}
			writeS3Error(w, http.StatusInternalServerError, "InternalError", fmt.Sprintf("mode2 ingest failed: %v", err))
			return
		}
	} else {
		res, err = mode2IngestAndUploadAppendToDeal(ingestCtx, tmpPath, dealID, serviceHint, chainCID, filePath)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				writeS3Error(w, http.StatusRequestTimeout, "RequestTimeout", err.Error())
				return
			}
			writeS3Error(w, http.StatusInternalServerError, "InternalError", fmt.Sprintf("mode2 append failed: %v", err))
			return
		}
	}

	// Best-effort commit using the local faucet key. This will only succeed
	// when the deal is authorized for faucet-signed updates (devnet).
	dealIDStr := strconv.FormatUint(dealID, 10)
	sizeStr := strconv.FormatUint(res.sizeBytes, 10)
	_, txErr := runTxWithRetry(
		ingestCtx,
		"tx", "nilchain", "update-deal-content",
		"--deal-id", dealIDStr,
		"--cid", res.manifestRoot.Canonical,
		"--size", sizeStr,
		"--chain-id", chainID,
		"--from", "faucet",
		"--yes",
		"--keyring-backend", "test",
		"--home", homeDir,
		"--gas-prices", gasPrices,
	)
	if txErr != nil {
		writeS3Error(w, http.StatusForbidden, "AccessDenied", "failed to commit deal content (owner auth required)")
		return
	}

	etag := hex.EncodeToString(hasher.Sum(nil))
	w.Header().Set("ETag", fmt.Sprintf("\"%s\"", etag))
	w.Header().Set("X-Nil-Deal-ID", dealIDStr)
	w.Header().Set("X-Nil-Manifest-Root", res.manifestRoot.Canonical)
	w.WriteHeader(http.StatusOK)
}

func S3DeleteObject(w http.ResponseWriter, r *http.Request) {
	// NilFS delete/tombstone support is not wired into this adapter yet.
	// Return a clear S3-style error instead of silently corrupting state.
	writeS3Error(w, http.StatusNotImplemented, "NotImplemented", "DELETE is not supported yet")
}
