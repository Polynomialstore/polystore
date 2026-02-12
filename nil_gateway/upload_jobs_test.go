package main

import "testing"

func TestUploadJobSnapshotIncludesMetrics(t *testing.T) {
	job := newUploadJob(7, "u1")
	job.setMetrics(
		map[string]uint64{"gateway_total_ms": 1234, "mode2_upload_requests_ms": 1200},
		map[string]uint64{"mode2_upload_tasks_total": 12, "mode2_upload_retries": 1},
	)

	snap := job.snapshot()
	if snap.MetricsMS["gateway_total_ms"] != 1234 {
		t.Fatalf("gateway_total_ms mismatch: got=%d", snap.MetricsMS["gateway_total_ms"])
	}
	if snap.MetricsMS["mode2_upload_requests_ms"] != 1200 {
		t.Fatalf("mode2_upload_requests_ms mismatch: got=%d", snap.MetricsMS["mode2_upload_requests_ms"])
	}
	if snap.Counts["mode2_upload_tasks_total"] != 12 {
		t.Fatalf("mode2_upload_tasks_total mismatch: got=%d", snap.Counts["mode2_upload_tasks_total"])
	}
	if snap.Counts["mode2_upload_retries"] != 1 {
		t.Fatalf("mode2_upload_retries mismatch: got=%d", snap.Counts["mode2_upload_retries"])
	}
}
