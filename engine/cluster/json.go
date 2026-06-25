package cluster

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

func jsonMarshal(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}

func jsonMarshalIndent(v interface{}) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}

func jsonUnmarshal(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// File helpers for stars.go
func readFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func writeFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0644)
}

func isNotExist(err error) bool {
	return os.IsNotExist(err)
}

func joinPath(elem ...string) string {
	return filepath.Join(elem...)
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}
