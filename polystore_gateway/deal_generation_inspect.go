package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

func GatewayDealGenerations(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	dealIDRaw := strings.TrimSpace(mux.Vars(r)["deal_id"])
	if dealIDRaw == "" {
		writeJSONError(w, http.StatusBadRequest, "deal_id path parameter is required", "")
		return
	}
	dealID, err := strconv.ParseUint(dealIDRaw, 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid deal_id", "")
		return
	}

	details, activeRoot, err := listDealGenerationDetails(dealID, time.Now().UTC())
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(w, http.StatusNotFound, "deal generation state not found", "")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, "failed to inspect deal generations", err.Error())
		return
	}

	resp := dealGenerationListResponse{
		DealID:                      dealID,
		ProvisionalRetentionSeconds: int64(configuredProvisionalGenerationRetentionTTL() / time.Second),
		Generations:                 details,
	}
	if activeRoot.Canonical != "" {
		resp.ActiveGeneration = activeRoot.Canonical
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
