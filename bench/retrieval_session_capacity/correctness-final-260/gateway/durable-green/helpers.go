package main
import("encoding/hex";"fmt";"strings";bolt "go.etcd.io/bbolt")
var sessionDB *bolt.DB
var onChainSessionProofsBucket=[]byte("onchain_session_proofs")
func parseSessionIDHex(raw string) (string, []byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil, fmt.Errorf("session_id is required")
	}
	s := raw
	if strings.HasPrefix(s, "0x") {
		s = s[2:]
	}
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != 64 {
		return "", nil, fmt.Errorf("session_id must be 32 bytes hex (got %d chars)", len(s))
	}
	bz, err := hex.DecodeString(s)
	if err != nil {
		return "", nil, fmt.Errorf("invalid session_id hex: %w", err)
	}
	return "0x" + s, bz, nil
}
