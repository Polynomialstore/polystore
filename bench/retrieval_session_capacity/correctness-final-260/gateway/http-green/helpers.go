package main
import("bytes";"context";"fmt";"regexp";"strings")
var lcdBase string
var txHashRe = regexp.MustCompile(`txhash:\s*([A-Fa-f0-9]+)`)
func extractJSONBody(b []byte) []byte {
	start := bytes.IndexByte(b, '{')
	end := bytes.LastIndexByte(b, '}')
	if start == -1 || end == -1 || end <= start {
		return nil
	}
	return b[start : end+1]
}
func extractTxHash(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "txhash:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			return strings.TrimSpace(fields[1])
		}
	}
	if m := txHashRe.FindStringSubmatch(out); len(m) == 2 {
		return m[1]
	}
	return ""
}
type txBroadcastResponse struct {
	Code      uint32 `json:"code"`
	Codespace string `json:"codespace"`
	RawLog    string `json:"raw_log"`
	TxHash    string `json:"txhash"`
}
func runTxWithRetry(context.Context, ...string)([]byte,error){return []byte(fmt.Sprintf(`{"txhash":"%s","code":0}`, strings.Repeat("A",64))),nil}
