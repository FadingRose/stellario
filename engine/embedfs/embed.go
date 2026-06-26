package embedfs

import "embed"

// Embedded TS source, glue files, and templates.
// These are populated by `make embed` before `go build`.
//
//go:embed src glue templates
var Files embed.FS
