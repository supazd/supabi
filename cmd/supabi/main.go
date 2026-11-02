// Command supabi is the program's entry point.
package main

import (
	"os"

	"github.com/supazd/supabi/internal/app"
)

func main() {
	os.Exit(app.Main(os.Args[1:]))
}
