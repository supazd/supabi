//go:build embedweb

package webui

import (
	"embed"
	"io/fs"
)

// dist is produced by `pnpm build` in web/.
//
//go:embed all:dist
var dist embed.FS

func assets() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // the directory is embedded at build time
	}
	return sub
}
