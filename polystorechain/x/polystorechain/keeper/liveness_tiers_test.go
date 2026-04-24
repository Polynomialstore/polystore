package keeper

import (
	"testing"

	"cosmossdk.io/math"
	"github.com/stretchr/testify/require"
)

func TestLivenessTierForLatencyBoundaries(t *testing.T) {
	tests := []struct {
		name       string
		latency    int64
		tier       uint32
		tierName   string
		multiplier math.LegacyDec
	}{
		{
			name:       "platinum at challenge block",
			latency:    0,
			tier:       0,
			tierName:   "Platinum",
			multiplier: math.LegacyNewDecWithPrec(100, 2),
		},
		{
			name:       "platinum upper bound",
			latency:    1,
			tier:       0,
			tierName:   "Platinum",
			multiplier: math.LegacyNewDecWithPrec(100, 2),
		},
		{
			name:       "gold lower bound",
			latency:    2,
			tier:       1,
			tierName:   "Gold",
			multiplier: math.LegacyNewDecWithPrec(80, 2),
		},
		{
			name:       "gold upper bound",
			latency:    5,
			tier:       1,
			tierName:   "Gold",
			multiplier: math.LegacyNewDecWithPrec(80, 2),
		},
		{
			name:       "silver lower bound",
			latency:    6,
			tier:       2,
			tierName:   "Silver",
			multiplier: math.LegacyNewDecWithPrec(50, 2),
		},
		{
			name:       "silver upper bound",
			latency:    10,
			tier:       2,
			tierName:   "Silver",
			multiplier: math.LegacyNewDecWithPrec(50, 2),
		},
		{
			name:       "fail lower bound",
			latency:    11,
			tier:       3,
			tierName:   "Fail",
			multiplier: math.LegacyNewDecWithPrec(0, 2),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tier, tierName, multiplier := livenessTierForLatency(tt.latency)
			require.Equal(t, tt.tier, tier)
			require.Equal(t, tt.tierName, tierName)
			require.True(t, multiplier.Equal(tt.multiplier), "got %s want %s", multiplier, tt.multiplier)
		})
	}
}
