package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// statFile is a thin wrapper for testability.
func statFile(path string) (os.FileInfo, error) {
	return os.Stat(path)
}

// globFiles wraps filepath.Glob for testability.
func globFiles(pattern string) ([]string, error) {
	return filepath.Glob(pattern)
}

// hasUncommittedChanges checks if the working tree is dirty.
func hasUncommittedChanges(dir string) bool {
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return len(strings.TrimSpace(string(out))) > 0
}
