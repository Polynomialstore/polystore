package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type uploadJobStatus string
type uploadJobPhase string

const (
	uploadJobRunning uploadJobStatus = "running"
	uploadJobSuccess uploadJobStatus = "success"
	uploadJobError   uploadJobStatus = "error"
)

const (
	uploadJobPhaseQueued    uploadJobPhase = "queued"
	uploadJobPhaseReceiving uploadJobPhase = "receiving"
	uploadJobPhaseEncoding  uploadJobPhase = "encoding"
	uploadJobPhaseUploading uploadJobPhase = "uploading"
	uploadJobPhaseDone      uploadJobPhase = "done"
)

type uploadJobKey struct {
	dealID   uint64
	uploadID string
}

type uploadJobResult struct {
	ManifestRoot    string `json:"manifest_root"`
	SizeBytes       uint64 `json:"size_bytes"`
	FileSizeBytes   uint64 `json:"file_size_bytes"`
	AllocatedLength uint64 `json:"allocated_length"`
	TotalMdus       uint64 `json:"total_mdus"`
	WitnessMdus     uint64 `json:"witness_mdus"`
}

type uploadJob struct {
	mu sync.RWMutex

	dealID   uint64
	uploadID string

	fileName string

	status  uploadJobStatus
	phase   uploadJobPhase
	message string

	bytesDone  uint64
	bytesTotal uint64

	stepsDone  uint64
	stepsTotal uint64

	startedAt time.Time
	updatedAt time.Time

	result *uploadJobResult
	err    string

	metricsMS     map[string]uint64
	metricsCounts map[string]uint64

	lastProgressLogAt    time.Time
	lastProgressLogDone  uint64
	lastHeartbeatLogAt   time.Time
	lastHeartbeatStepsAt uint64
}

type uploadJobResponse struct {
	DealID     string            `json:"deal_id"`
	UploadID   string            `json:"upload_id"`
	Status     string            `json:"status"`
	Phase      string            `json:"phase"`
	FileName   string            `json:"file_name,omitempty"`
	Message    string            `json:"message,omitempty"`
	BytesDone  uint64            `json:"bytes_done,omitempty"`
	BytesTotal uint64            `json:"bytes_total,omitempty"`
	StepsDone  uint64            `json:"steps_done,omitempty"`
	StepsTotal uint64            `json:"steps_total,omitempty"`
	StartedAt  string            `json:"started_at"`
	UpdatedAt  string            `json:"updated_at"`
	Result     *uploadJobResult  `json:"result,omitempty"`
	Error      string            `json:"error,omitempty"`
	MetricsMS  map[string]uint64 `json:"metrics_ms,omitempty"`
	Counts     map[string]uint64 `json:"counts,omitempty"`
}

var uploadJobsMu sync.RWMutex
var uploadJobs = map[uploadJobKey]*uploadJob{}

func pruneUploadJobs(now time.Time) {
	uploadJobsMu.Lock()
	defer uploadJobsMu.Unlock()

	for key, job := range uploadJobs {
		job.mu.RLock()
		updatedAt := job.updatedAt
		status := job.status
		job.mu.RUnlock()

		age := now.Sub(updatedAt)
		if age > 2*time.Hour {
			delete(uploadJobs, key)
			continue
		}
		if (status == uploadJobSuccess || status == uploadJobError) && age > 15*time.Minute {
			delete(uploadJobs, key)
		}
	}
}

func storeUploadJob(job *uploadJob) {
	if job == nil {
		return
	}
	uploadJobsMu.Lock()
	uploadJobs[uploadJobKey{dealID: job.dealID, uploadID: job.uploadID}] = job
	uploadJobsMu.Unlock()
	pruneUploadJobs(time.Now())
}

func lookupUploadJob(dealID uint64, uploadID string) *uploadJob {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" {
		return nil
	}
	uploadJobsMu.RLock()
	job := uploadJobs[uploadJobKey{dealID: dealID, uploadID: uploadID}]
	uploadJobsMu.RUnlock()
	return job
}

func newUploadJob(dealID uint64, uploadID string) *uploadJob {
	now := time.Now()
	return &uploadJob{
		dealID:    dealID,
		uploadID:  strings.TrimSpace(uploadID),
		status:    uploadJobRunning,
		phase:     uploadJobPhaseQueued,
		startedAt: now,
		updatedAt: now,
	}
}

func (j *uploadJob) snapshot() uploadJobResponse {
	j.mu.RLock()
	defer j.mu.RUnlock()

	var metricsMS map[string]uint64
	if len(j.metricsMS) > 0 {
		metricsMS = make(map[string]uint64, len(j.metricsMS))
		for k, v := range j.metricsMS {
			metricsMS[k] = v
		}
	}

	var counts map[string]uint64
	if len(j.metricsCounts) > 0 {
		counts = make(map[string]uint64, len(j.metricsCounts))
		for k, v := range j.metricsCounts {
			counts[k] = v
		}
	}

	return uploadJobResponse{
		DealID:     strconv.FormatUint(j.dealID, 10),
		UploadID:   j.uploadID,
		Status:     string(j.status),
		Phase:      string(j.phase),
		FileName:   j.fileName,
		Message:    j.message,
		BytesDone:  j.bytesDone,
		BytesTotal: j.bytesTotal,
		StepsDone:  j.stepsDone,
		StepsTotal: j.stepsTotal,
		StartedAt:  j.startedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:  j.updatedAt.UTC().Format(time.RFC3339Nano),
		Result:     j.result,
		Error:      j.err,
		MetricsMS:  metricsMS,
		Counts:     counts,
	}
}

func (j *uploadJob) touchLocked() {
	j.updatedAt = time.Now()
}

func (j *uploadJob) setPhase(phase uploadJobPhase, message string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	previous := j.phase
	j.phase = phase
	if strings.TrimSpace(message) != "" {
		j.message = message
	}
	j.touchLocked()
	phaseChanged := previous != phase
	phaseValue := j.phase
	msgValue := j.message
	statusValue := j.status
	j.mu.Unlock()
	if phaseChanged {
		log.Printf(
			"GatewayUpload phase: deal_id=%d upload_id=%s status=%s phase=%s message=%s",
			j.dealID,
			j.uploadID,
			statusValue,
			phaseValue,
			msgValue,
		)
	}
}

func (j *uploadJob) setFile(name string, bytesTotal uint64) {
	if j == nil {
		return
	}
	j.mu.Lock()
	name = strings.TrimSpace(name)
	if name != "" {
		j.fileName = name
	}
	if bytesTotal > 0 {
		j.bytesTotal = bytesTotal
	}
	j.touchLocked()
	j.mu.Unlock()
}

func (j *uploadJob) setBytes(bytesDone uint64, bytesTotal uint64) {
	if j == nil {
		return
	}
	j.mu.Lock()
	if bytesDone > j.bytesDone {
		j.bytesDone = bytesDone
	}
	if bytesTotal > 0 {
		if bytesTotal >= j.bytesTotal {
			j.bytesTotal = bytesTotal
		}
	}
	j.touchLocked()
	j.mu.Unlock()
}

func (j *uploadJob) setSteps(done uint64, total uint64) {
	if j == nil {
		return
	}
	j.mu.Lock()
	prevDone := j.stepsDone
	if total > 0 {
		j.stepsTotal = total
	}
	if done > j.stepsDone {
		if j.stepsTotal > 0 && done > j.stepsTotal {
			j.stepsDone = j.stepsTotal
		} else {
			j.stepsDone = done
		}
	}
	j.touchLocked()
	currentDone := j.stepsDone
	currentTotal := j.stepsTotal
	currentPhase := j.phase
	currentStatus := j.status
	shouldLogProgress := false
	now := time.Now()
	if currentTotal > 0 && currentDone >= prevDone {
		stepBucket := currentTotal / 20 // 5% increments
		if stepBucket == 0 {
			stepBucket = 1
		}
		progressAdvanced := currentDone > j.lastProgressLogDone
		bucketReached := progressAdvanced && (currentDone-j.lastProgressLogDone >= stepBucket)
		firstTick := j.lastProgressLogDone == 0 && currentDone > 0
		completed := currentDone == currentTotal
		timed := progressAdvanced && now.Sub(j.lastProgressLogAt) >= 10*time.Second
		phaseAllows := currentPhase == uploadJobPhaseEncoding || currentPhase == uploadJobPhaseUploading
		if phaseAllows && (firstTick || bucketReached || completed || timed) {
			j.lastProgressLogAt = now
			j.lastProgressLogDone = currentDone
			shouldLogProgress = true
		}
	}
	j.mu.Unlock()
	if shouldLogProgress {
		pct := float64(0)
		if currentTotal > 0 {
			pct = (float64(currentDone) / float64(currentTotal)) * 100
		}
		log.Printf(
			"GatewayUpload progress: deal_id=%d upload_id=%s status=%s phase=%s steps=%d/%d (%.1f%%)",
			j.dealID,
			j.uploadID,
			currentStatus,
			currentPhase,
			currentDone,
			currentTotal,
			pct,
		)
	}
}

func (j *uploadJob) setResult(res uploadJobResult) {
	if j == nil {
		return
	}
	j.mu.Lock()
	j.status = uploadJobSuccess
	j.phase = uploadJobPhaseDone
	j.result = &res
	j.err = ""
	j.touchLocked()
	j.mu.Unlock()
	log.Printf("GatewayUpload job success: deal_id=%d upload_id=%s manifest_root=%s size=%d total_mdus=%d witness_mdus=%d", j.dealID, j.uploadID, res.ManifestRoot, res.SizeBytes, res.TotalMdus, res.WitnessMdus)
}

func (j *uploadJob) setError(msg string) {
	if j == nil {
		return
	}
	msg = strings.TrimSpace(msg)
	j.mu.Lock()
	j.status = uploadJobError
	j.phase = uploadJobPhaseDone
	j.err = msg
	j.touchLocked()
	j.mu.Unlock()
	if msg != "" {
		log.Printf("GatewayUpload job error: deal_id=%d upload_id=%s reason=%s", j.dealID, j.uploadID, msg)
	}
}

func (j *uploadJob) setMetrics(metricsMS map[string]uint64, counts map[string]uint64) {
	if j == nil {
		return
	}
	j.mu.Lock()
	if len(metricsMS) > 0 {
		j.metricsMS = make(map[string]uint64, len(metricsMS))
		for k, v := range metricsMS {
			j.metricsMS[k] = v
		}
	} else {
		j.metricsMS = nil
	}
	if len(counts) > 0 {
		j.metricsCounts = make(map[string]uint64, len(counts))
		for k, v := range counts {
			j.metricsCounts[k] = v
		}
	} else {
		j.metricsCounts = nil
	}
	j.touchLocked()
	j.mu.Unlock()
}

func (j *uploadJob) maybeLogHeartbeat() {
	if j == nil {
		return
	}
	j.mu.Lock()
	if time.Since(j.lastHeartbeatLogAt) < 15*time.Second {
		j.mu.Unlock()
		return
	}
	j.lastHeartbeatLogAt = time.Now()
	dealID := j.dealID
	uploadID := j.uploadID
	status := j.status
	phase := j.phase
	message := j.message
	stepsDone := j.stepsDone
	stepsTotal := j.stepsTotal
	bytesDone := j.bytesDone
	bytesTotal := j.bytesTotal
	updatedAt := j.updatedAt
	j.lastHeartbeatStepsAt = stepsDone
	j.mu.Unlock()

	age := time.Since(updatedAt).Round(time.Millisecond)
	if stepsTotal > 0 {
		log.Printf(
			"GatewayUpload heartbeat: deal_id=%d upload_id=%s status=%s phase=%s steps=%d/%d message=%s updated_ago=%s",
			dealID,
			uploadID,
			status,
			phase,
			stepsDone,
			stepsTotal,
			message,
			age,
		)
		return
	}
	if bytesTotal > 0 {
		log.Printf(
			"GatewayUpload heartbeat: deal_id=%d upload_id=%s status=%s phase=%s bytes=%d/%d message=%s updated_ago=%s",
			dealID,
			uploadID,
			status,
			phase,
			bytesDone,
			bytesTotal,
			message,
			age,
		)
	}
}

type uploadJobCtxKey struct{}

func withUploadJob(ctx context.Context, job *uploadJob) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if job == nil {
		return ctx
	}
	return context.WithValue(ctx, uploadJobCtxKey{}, job)
}

func uploadJobFromContext(ctx context.Context) *uploadJob {
	if ctx == nil {
		return nil
	}
	if v := ctx.Value(uploadJobCtxKey{}); v != nil {
		if job, ok := v.(*uploadJob); ok {
			return job
		}
	}
	return nil
}

func GatewayUploadStatus(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	dealID, ok := requireDealIDQuery(w, r)
	if !ok {
		return
	}
	uploadID, ok := requireUploadIDQuery(w, r)
	if !ok {
		return
	}

	job := lookupUploadJob(dealID, uploadID)
	if job == nil {
		log.Printf("GatewayUploadStatus: upload not found deal_id=%d upload_id=%s", dealID, uploadID)
		writeJSONError(w, http.StatusNotFound, "upload not found", "")
		return
	}
	job.maybeLogHeartbeat()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(job.snapshot())
}
