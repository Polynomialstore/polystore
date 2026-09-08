package main
import("bytes";"encoding/json";"fmt";"io";"strings";"unicode/utf8";"polystorechain/x/polystorechain/types")
const maxRetrievalMetadataBytes=128*1024
func validateJSONObject(body []byte) error {
	if !utf8.Valid(body) {
		return fmt.Errorf("invalid JSON UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return fmt.Errorf("expected JSON object")
	}
	var consume func(json.Delim, int) error
	consume = func(open json.Delim, depth int) error {
		if depth > 64 {
			return fmt.Errorf("JSON nesting exceeds limit")
		}
		var keys map[string]struct{}
		if open == '{' {
			keys = make(map[string]struct{})
		}
		for d.More() {
			if open == '{' {
				token, err := d.Token()
				if err != nil {
					return err
				}
				key, ok := token.(string)
				if !ok {
					return fmt.Errorf("invalid JSON object key")
				}
				// Struct decoders accept case variants and protobuf camel/snake
				// aliases. Two spellings must not choose different authority.
				alias := strings.ToLower(strings.ReplaceAll(key, "_", ""))
				if _, exists := keys[alias]; exists {
					return fmt.Errorf("duplicate JSON key %q", key)
				}
				keys[alias] = struct{}{}
			}
			token, err := d.Token()
			if err != nil {
				return err
			}
			if delim, ok := token.(json.Delim); ok {
				if err := consume(delim, depth+1); err != nil {
					return err
				}
			}
		}
		end, err := d.Token()
		if err != nil {
			return err
		}
		if (open == '{' && end != json.Delim('}')) || (open == '[' && end != json.Delim(']')) {
			return fmt.Errorf("invalid JSON container")
		}
		return nil
	}
	if err := consume('{', 1); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return fmt.Errorf("trailing JSON data")
	}
	return nil
}
func decodeLegacySessionProofs(raw []byte, proofs *[]types.ChainedProof) error {
	if len(raw) == 0 || len(raw) > maxRetrievalMetadataBytes {
		return fmt.Errorf("legacy proof record size invalid")
	}
	wrapped := append([]byte(`{"proofs":`), raw...)
	wrapped = append(wrapped, '}')
	if err := validateJSONObject(wrapped); err != nil {
		return err
	}
	if err := json.Unmarshal(raw, proofs); err != nil {
		return err
	}
	if len(*proofs) == 0 || len(*proofs) > 64 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("legacy proof count invalid")
	}
	return nil
}
