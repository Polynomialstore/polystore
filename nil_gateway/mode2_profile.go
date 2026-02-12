package main

import (
	"context"
	"sync"
	"time"
)

type mode2UploadProfile struct {
	mu sync.Mutex

	durations map[string]time.Duration
	counts    map[string]uint64
}

func newMode2UploadProfile() *mode2UploadProfile {
	return &mode2UploadProfile{
		durations: make(map[string]time.Duration),
		counts:    make(map[string]uint64),
	}
}

func (p *mode2UploadProfile) addDuration(label string, d time.Duration) {
	if p == nil || label == "" {
		return
	}
	p.mu.Lock()
	p.durations[label] += d
	p.mu.Unlock()
}

func (p *mode2UploadProfile) setCount(label string, v uint64) {
	if p == nil || label == "" {
		return
	}
	p.mu.Lock()
	p.counts[label] = v
	p.mu.Unlock()
}

func (p *mode2UploadProfile) addCount(label string, v uint64) {
	if p == nil || label == "" || v == 0 {
		return
	}
	p.mu.Lock()
	p.counts[label] += v
	p.mu.Unlock()
}

func (p *mode2UploadProfile) snapshots() (map[string]uint64, map[string]uint64) {
	if p == nil {
		return nil, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	ms := make(map[string]uint64, len(p.durations))
	for k, v := range p.durations {
		ms[k] = uint64(v / time.Millisecond)
	}

	counts := make(map[string]uint64, len(p.counts))
	for k, v := range p.counts {
		counts[k] = v
	}
	return ms, counts
}

type mode2ProfileCtxKey struct{}

func withMode2UploadProfile(ctx context.Context, profile *mode2UploadProfile) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if profile == nil {
		return ctx
	}
	return context.WithValue(ctx, mode2ProfileCtxKey{}, profile)
}

func mode2UploadProfileFromContext(ctx context.Context) *mode2UploadProfile {
	if ctx == nil {
		return nil
	}
	if v := ctx.Value(mode2ProfileCtxKey{}); v != nil {
		if p, ok := v.(*mode2UploadProfile); ok {
			return p
		}
	}
	return nil
}
