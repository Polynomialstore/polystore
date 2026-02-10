package main

import (
	"reflect"
	"testing"
)

func TestMode2FallbackProviders_OrderAndDedup(t *testing.T) {
	slots := []mode2SlotAssignment{
		{Provider: " p2 ", Status: 1},
		{Provider: "p2", PendingProvider: "p1", Status: 2},
		{Provider: "p3", PendingProvider: "p2", Status: 2},
		{Provider: "p3", PendingProvider: "  ", Status: 0},
	}

	got := mode2FallbackProviders(slots)
	want := []string{"p2", "p1", "p3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected provider order: got=%v want=%v", got, want)
	}
}

