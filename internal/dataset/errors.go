package dataset

import "fmt"

// Error is a problem with a dataset definition or a query against it. Code is
// stable and is what clients translate; Message is for logs and developers.
type Error struct {
	Code    string
	Message string
	// Params are the values a translated message needs.
	Params map[string]string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errorf builds an Error. Pairs are alternating parameter names and values.
func Errorf(code string, pairs []string, format string, args ...any) *Error {
	params := map[string]string{}
	for i := 0; i+1 < len(pairs); i += 2 {
		params[pairs[i]] = pairs[i+1]
	}
	return &Error{Code: code, Message: fmt.Sprintf(format, args...), Params: params}
}
