package cluster

import "encoding/json"

func jsonMarshal(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}

func jsonMarshalIndent(v interface{}) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}

func jsonUnmarshal(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}
