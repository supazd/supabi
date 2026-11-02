package role

import (
	"slices"
	"testing"
)

func TestParse(t *testing.T) {
	tests := []struct {
		in      string
		want    []Role
		wantErr bool
	}{
		{in: "", want: All},
		{in: "  ", want: All},
		{in: "api", want: []Role{API}},
		{in: "scheduler, api", want: []Role{API, Scheduler}},
		{in: "worker,worker", want: []Role{Worker}},
		{in: "api,web", wantErr: true},
		{in: "api,", wantErr: true},
	}
	for _, tt := range tests {
		got, err := Parse(tt.in)
		if (err != nil) != tt.wantErr {
			t.Errorf("Parse(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			continue
		}
		if !tt.wantErr && !slices.Equal(got, tt.want) {
			t.Errorf("Parse(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}
