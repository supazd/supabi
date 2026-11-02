// Package buildinfo holds values injected at build time with -ldflags.
package buildinfo

var (
	Version = "dev"
	Commit  = "unknown"
)
