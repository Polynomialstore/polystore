package types

import (
	"fmt"
	"strconv"
	"strings"
)

type ServiceHintInfo struct {
	Raw         string
	Base        string
	Owner       string
	Replicas    uint64
	HasReplicas bool
	RSK         uint64
	RSM         uint64
	HasRS       bool
}

type RSParams struct {
	K         uint64
	M         uint64
	Rows      uint64
	LeafCount uint64
}

func ParseServiceHint(raw string) (ServiceHintInfo, error) {
	raw = strings.TrimSpace(raw)
	info := ServiceHintInfo{Raw: raw}
	if raw == "" {
		return info, nil
	}

	base := raw
	extras := ""
	if idx := strings.Index(raw, ":"); idx != -1 {
		base = strings.TrimSpace(raw[:idx])
		extras = raw[idx+1:]
	}
	info.Base = base

	if extras == "" {
		return info, nil
	}

	for _, token := range strings.Split(extras, ":") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		parts := strings.SplitN(token, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(parts[0]))
		val := strings.TrimSpace(parts[1])
		switch key {
		case "owner":
			if val != "" {
				info.Owner = val
			}
		case "replicas":
			if val == "" {
				continue
			}
			n, err := strconv.ParseUint(val, 10, 64)
			if err != nil || n == 0 {
				return info, fmt.Errorf("invalid replicas value in service hint: %s", val)
			}
			info.Replicas = n
			info.HasReplicas = true
		case "rs":
			if val == "" {
				continue
			}
			chunks := strings.Split(val, "+")
			if len(chunks) != 2 {
				return info, fmt.Errorf("invalid rs value in service hint: %s", val)
			}
			k, err := strconv.ParseUint(strings.TrimSpace(chunks[0]), 10, 64)
			if err != nil || k == 0 {
				return info, fmt.Errorf("invalid rs value in service hint: %s", val)
			}
			m, err := strconv.ParseUint(strings.TrimSpace(chunks[1]), 10, 64)
			if err != nil || m == 0 {
				return info, fmt.Errorf("invalid rs value in service hint: %s", val)
			}
			if 64%k != 0 {
				return info, fmt.Errorf("invalid rs value in service hint (K must divide 64): %s", val)
			}
			if k+m > uint64(DealBaseReplication) {
				return info, fmt.Errorf("invalid rs value in service hint (K+M exceeds base replication): %s", val)
			}
			info.RSK = k
			info.RSM = m
			info.HasRS = true
		}
	}

	return info, nil
}

func RSParamsFromHint(info ServiceHintInfo) (RSParams, bool, error) {
	if !info.HasRS {
		return RSParams{}, false, nil
	}
	if info.RSK == 0 || info.RSM == 0 {
		return RSParams{}, false, fmt.Errorf("invalid rs params")
	}
	rows := uint64(64) / info.RSK
	leafCount := (info.RSK + info.RSM) * rows
	return RSParams{K: info.RSK, M: info.RSM, Rows: rows, LeafCount: leafCount}, true, nil
}
