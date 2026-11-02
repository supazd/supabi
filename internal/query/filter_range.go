package query

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/supazd/supabi/internal/dataset"
)

func decodeFilterRange(value any) (dataset.FilterRange, error) {
	var out dataset.FilterRange
	switch value := value.(type) {
	case []any:
		if len(value) != 2 {
			return out, fmt.Errorf("a range needs two values")
		}
		out.Min, out.Max = value[0], value[1]
	case dataset.FilterRange:
		out = value
	case *dataset.FilterRange:
		if value == nil {
			return out, fmt.Errorf("a range needs min and max")
		}
		out = *value
	case map[string]any:
		raw, err := json.Marshal(value)
		if err != nil {
			return out, err
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&out); err != nil {
			return out, err
		}
	default:
		return out, fmt.Errorf("a range needs two values or a min/max object")
	}
	if out.Min == nil || out.Max == nil {
		return out, fmt.Errorf("a range needs min and max")
	}
	return out, nil
}
