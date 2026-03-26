package main

import (
	"net/http"
	"testing"
)

func TestIsBundleUnsupportedHTTPError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  *providerUploadHTTPError
		want bool
	}{
		{
			name: "404 unsupported endpoint",
			err:  &providerUploadHTTPError{statusCode: http.StatusNotFound},
			want: true,
		},
		{
			name: "405 unsupported method",
			err:  &providerUploadHTTPError{statusCode: http.StatusMethodNotAllowed},
			want: true,
		},
		{
			name: "415 unsupported media type",
			err:  &providerUploadHTTPError{statusCode: http.StatusUnsupportedMediaType},
			want: true,
		},
		{
			name: "400 invalid bundle body",
			err:  &providerUploadHTTPError{statusCode: http.StatusBadRequest, body: "invalid bundle body"},
			want: true,
		},
		{
			name: "400 invalid deal id",
			err:  &providerUploadHTTPError{statusCode: http.StatusBadRequest, body: "invalid deal_id"},
			want: true,
		},
		{
			name: "400 unrelated validation error",
			err:  &providerUploadHTTPError{statusCode: http.StatusBadRequest, body: "manifest root mismatch"},
			want: false,
		},
		{
			name: "500 should not fallback",
			err:  &providerUploadHTTPError{statusCode: http.StatusInternalServerError, body: "internal error"},
			want: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := isBundleUnsupportedHTTPError(tc.err)
			if got != tc.want {
				t.Fatalf("isBundleUnsupportedHTTPError() = %v, want %v", got, tc.want)
			}
		})
	}
}

