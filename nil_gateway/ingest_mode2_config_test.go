package main

import (
	"runtime"
	"testing"
	"time"
)

func TestMode2UploadParallelism_DefaultAutotuned(t *testing.T) {
	prev := runtime.GOMAXPROCS(2)
	defer runtime.GOMAXPROCS(prev)
	t.Setenv("NIL_MODE2_UPLOAD_PARALLELISM", "")
	if got := mode2UploadParallelism(12); got != 8 {
		t.Fatalf("default upload parallelism mismatch: got=%d want=8", got)
	}
}

func TestMode2UploadParallelism_EnvOverride(t *testing.T) {
	t.Setenv("NIL_MODE2_UPLOAD_PARALLELISM", "3")
	if got := mode2UploadParallelism(12); got != 3 {
		t.Fatalf("env upload parallelism mismatch: got=%d want=3", got)
	}
}

func TestMode2ExpectContinueTimeout_DefaultAndEnv(t *testing.T) {
	t.Setenv("NIL_MODE2_EXPECT_CONTINUE_MS", "")
	if got := mode2ExpectContinueTimeout(); got != 250*time.Millisecond {
		t.Fatalf("default expect continue timeout mismatch: got=%s want=250ms", got)
	}

	t.Setenv("NIL_MODE2_EXPECT_CONTINUE_MS", "0")
	if got := mode2ExpectContinueTimeout(); got != 0 {
		t.Fatalf("disabled expect continue timeout mismatch: got=%s want=0", got)
	}

	t.Setenv("NIL_MODE2_EXPECT_CONTINUE_MS", "175")
	if got := mode2ExpectContinueTimeout(); got != 175*time.Millisecond {
		t.Fatalf("env expect continue timeout mismatch: got=%s want=175ms", got)
	}
}
