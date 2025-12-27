package main

import (
	"context"
	"encoding/json"
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
}

type uploadJobResponse struct {
	DealID     string           `json:"deal_id"`
	UploadID   string           `json:"upload_id"`
	Status     string           `json:"status"`
	Phase      string           `json:"phase"`
	FileName   string           `json:"file_name,omitempty"`
	Message    string           `json:"message,omitempty"`
	BytesDone  uint64           `json:"bytes_done,omitempty"`
	BytesTotal uint64           `json:"bytes_total,omitempty"`
	StepsDone  uint64           `json:"steps_done,omitempty"`
	StepsTotal uint64           `json:"steps_total,omitempty"`
	StartedAt  string           `json:"started_at"`
	UpdatedAt  string           `json:"updated_at"`
	Result     *uploadJobResult `json:"result,omitempty"`
	Error      string           `json:"error,omitempty"`
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
	j.phase = phase
	if strings.TrimSpace(message) != "" {
		j.message = message
	}
	j.touchLocked()
	j.mu.Unlock()
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
	j.bytesDone = bytesDone
	if bytesTotal > 0 {
		j.bytesTotal = bytesTotal
	}
	j.touchLocked()
	j.mu.Unlock()
}

func (j *uploadJob) setSteps(done uint64, total uint64) {
	if j == nil {
		return
	}
	j.mu.Lock()
	j.stepsDone = done
	j.stepsTotal = total
	j.touchLocked()
	j.mu.Unlock()
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
}

func (j *uploadJob) setError(msg string) {
	if j == nil {
		return
	}
	j.mu.Lock()
	j.status = uploadJobError
	j.phase = uploadJobPhaseDone
	j.err = strings.TrimSpace(msg)
	j.touchLocked()
	j.mu.Unlock()
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
		writeJSONError(w, http.StatusNotFound, "upload not found", "")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(job.snapshot())
}
