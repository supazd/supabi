//go:build !embedweb

package webui

import "io/fs"

// Without the embedweb tag the binary carries no frontend, so Go builds and
// tests never depend on a Node toolchain. Use the Vite dev server instead.
func assets() fs.FS { return nil }
