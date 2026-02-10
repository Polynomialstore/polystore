package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClassifySystemLivenessError_MissingLocalData(t *testing.T) {
	t.Parallel()

	reason, backoff, expected := classifySystemLivenessError(errors.New("open /tmp/mdu.bin: no such file or directory"))
	if reason != systemLivenessFailureMissingLocalData {
		t.Fatalf("expected reason=%q, got %q", systemLivenessFailureMissingLocalData, reason)
	}
	if backoff != systemLivenessMissingDataBackoff {
		t.Fatalf("expected backoff=%s, got %s", systemLivenessMissingDataBackoff, backoff)
	}
	if !expected {
		t.Fatalf("expected expected=true")
	}
}

func TestClassifySystemLivenessError_DealExpired(t *testing.T) {
	t.Parallel()

	reason, backoff, expected := classifySystemLivenessError(errors.New("rpc error: deal 11 expired at end_block=5604"))
	if reason != systemLivenessFailureDealExpired {
		t.Fatalf("expected reason=%q, got %q", systemLivenessFailureDealExpired, reason)
	}
	if backoff != systemLivenessExpiredDealBackoff {
		t.Fatalf("expected backoff=%s, got %s", systemLivenessExpiredDealBackoff, backoff)
	}
	if !expected {
		t.Fatalf("expected expected=true")
	}
}

func TestSystemLivenessState_BackoffProgression(t *testing.T) {
	t.Parallel()

	var st systemLivenessState
	key := systemLivenessKey{dealID: 12, slot: 1, ordinal: 0}
	now := time.Unix(1700000000, 0)

	reason, delay1, attempt1, expected1 := st.recordFailure(key, now, errors.New("no such file or directory"))
	if reason != systemLivenessFailureMissingLocalData {
		t.Fatalf("unexpected reason: %q", reason)
	}
	if !expected1 {
		t.Fatalf("expected first failure to be expected")
	}
	if attempt1 != 1 {
		t.Fatalf("expected first attempt=1, got %d", attempt1)
	}
	if delay1 != systemLivenessMissingDataBackoff {
		t.Fatalf("expected delay1=%s, got %s", systemLivenessMissingDataBackoff, delay1)
	}

	blocked, _, blockedReason := st.shouldBackoff(key, now.Add(1*time.Second))
	if !blocked {
		t.Fatalf("expected key to be in backoff")
	}
	if blockedReason != systemLivenessFailureMissingLocalData {
		t.Fatalf("expected blocked reason=%q, got %q", systemLivenessFailureMissingLocalData, blockedReason)
	}

	_, delay2, attempt2, _ := st.recordFailure(key, now.Add(delay1+time.Second), errors.New("no such file or directory"))
	if attempt2 != 2 {
		t.Fatalf("expected second attempt=2, got %d", attempt2)
	}
	if delay2 <= delay1 {
		t.Fatalf("expected delay2 > delay1, got delay1=%s delay2=%s", delay1, delay2)
	}

	st.markDone(key)
	blocked, _, _ = st.shouldBackoff(key, now.Add(delay2+time.Second))
	if blocked {
		t.Fatalf("expected no backoff after markDone")
	}
}

func TestIsDealExpiredAtHeight(t *testing.T) {
	t.Parallel()

	if isDealExpiredAtHeight(0, 100) {
		t.Fatalf("end_block=0 should not be expired")
	}
	if isDealExpiredAtHeight(100, 0) {
		t.Fatalf("height=0 should not be treated as expired")
	}
	if isDealExpiredAtHeight(100, 99) {
		t.Fatalf("height < end_block should be active")
	}
	if !isDealExpiredAtHeight(100, 100) {
		t.Fatalf("height == end_block must be expired")
	}
	if !isDealExpiredAtHeight(100, 101) {
		t.Fatalf("height > end_block must be expired")
	}
}

func TestFetchDealStateForSystemLiveness_ParsesEndBlockAlt(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{
			"deal":{
				"service_hint":"General:rs=2+1",
				"redundancy_mode":"2",
				"endBlock":"777",
				"current_gen":"1",
				"total_mdus":"3",
				"witness_mdus":"1",
				"manifest_root":"",
				"mode2_slots":[]
			}
		}`))
	}))
	defer srv.Close()

	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	deal, err := fetchDealStateForSystemLiveness(context.Background(), 99)
	if err != nil {
		t.Fatalf("fetchDealStateForSystemLiveness failed: %v", err)
	}
	if deal.endBlock != 777 {
		t.Fatalf("expected endBlock=777, got %d", deal.endBlock)
	}
}
