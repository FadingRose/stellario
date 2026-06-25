package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Profile defines how entries in a volume behave over time.
type Profile string

const (
	ProfileMutable   Profile = "mutable"
	ProfileAppend    Profile = "append"
	ProfileScratch   Profile = "scratch"
	ProfileFrozen    Profile = "frozen"
	ProfileWorkspace Profile = "workspace"
)

var validProfiles = []Profile{
	ProfileMutable, ProfileAppend, ProfileScratch, ProfileFrozen, ProfileWorkspace,
}

// Boundaries controls which agent can access a volume.
type Boundaries struct {
	Read  []string `yaml:"read"`
	Write []string `yaml:"write"`
}

// VolumeDef defines a volume's behavior and access control.
type VolumeDef struct {
	Profile           Profile     `yaml:"profile"`
	Boundaries        Boundaries  `yaml:"boundaries"`
	Authority         string      `yaml:"authority,omitempty"`
	RequiredTagPrefix string      `yaml:"requiredTagPrefix,omitempty"`
	IDPrefix          string      `yaml:"idPrefix,omitempty"`
}

// AgentDef defines an agent persona.
type AgentDef struct {
	Display string `yaml:"display"`
	Role    string `yaml:"role,omitempty"`
}

// EmbeddingConfig controls semantic search.
type EmbeddingConfig struct {
	Enabled interface{} `yaml:"enabled,omitempty"` // bool | "auto"
	Model   string      `yaml:"model,omitempty"`
}

// StellarioConfig is the fully validated configuration.
type StellarioConfig struct {
	MemoryDir string                  `yaml:"memoryDir"`
	Volumes   map[string]*VolumeDef   `yaml:"volumes"`
	Agents    map[string]*AgentDef    `yaml:"agents"`
	Tags      map[string]interface{}  `yaml:"tags,omitempty"`
	Embedding *EmbeddingConfig        `yaml:"embedding,omitempty"`
	LSP       map[string]interface{}  `yaml:"lsp,omitempty"`
}

// rawConfig is the parsed YAML before validation.
type rawConfig struct {
	MemoryDir string                  `yaml:"memoryDir"`
	Volumes   map[string]yaml.Node    `yaml:"volumes"`
	Agents    map[string]yaml.Node    `yaml:"agents"`
	Tags      map[string]interface{}  `yaml:"tags,omitempty"`
	Embedding *EmbeddingConfig        `yaml:"embedding,omitempty"`
	LSP       map[string]interface{}  `yaml:"lsp,omitempty"`
}

// ─── System Volumes ──────────────────────────────────────────────────────────

// System volumes are automatically injected. User definitions for these names
// merge with system defaults (profile is always locked).
var systemVolumes = map[string]*VolumeDef{
	"archived": {
		Profile:    ProfileFrozen,
		Boundaries: Boundaries{Read: []string{"all"}, Write: []string{}},
		IDPrefix:   "z",
	},
	"meta": {
		Profile:    ProfileMutable,
		Boundaries: Boundaries{Read: []string{"all"}, Write: []string{"all"}},
		IDPrefix:   "m",
	},
	"handover": {
		Profile:    ProfileAppend,
		Boundaries: Boundaries{Read: []string{"all"}, Write: []string{"all"}},
		IDPrefix:   "h",
	},
	"layer": {
		Profile:    ProfileWorkspace,
		Boundaries: Boundaries{Read: []string{"all"}, Write: []string{"all"}},
		IDPrefix:   "l",
	},
}

// IsSystemVolume returns true if the name is a reserved system volume.
func IsSystemVolume(name string) bool {
	_, ok := systemVolumes[name]
	return ok
}

// ─── Validation ──────────────────────────────────────────────────────────────

// ValidationError represents a single validation issue.
type ValidationError struct {
	Volume   string `json:"volume,omitempty"`
	Field    string `json:"field"`
	Message  string `json:"message"`
	Severity string `json:"severity"` // "error" | "warning"
}

func (e ValidationError) Error() string {
	if e.Volume != "" {
		return fmt.Sprintf("volume %q: %s", e.Volume, e.Message)
	}
	return e.Message
}

// ValidateResult holds the validated config plus any issues found.
type ValidateResult struct {
	Config  *StellarioConfig
	Errors  []ValidationError
	Warnings []ValidationError
}

// rawVolumeDef is the intermediate representation during validation.
type rawVolumeDef struct {
	Profile           string    `yaml:"profile"`
	Boundaries        *struct {
		Read  interface{} `yaml:"read"`
		Write interface{} `yaml:"write"`
	} `yaml:"boundaries"`
	Authority         string `yaml:"authority"`
	RequiredTagPrefix string `yaml:"requiredTagPrefix"`
	IDPrefix          string `yaml:"idPrefix"`
}

// LoadAndValidate finds, parses, and validates stellario.yaml.
// Search order: .opencode/stellario.yaml, then stellario.yaml in project root.
func LoadAndValidate(projectRoot string) (*ValidateResult, error) {
	candidates := []string{
		filepath.Join(projectRoot, ".opencode", "stellario.yaml"),
		filepath.Join(projectRoot, "stellario.yaml"),
	}

	var configPath string
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			configPath = p
			break
		}
	}

	if configPath == "" {
		return nil, fmt.Errorf("stellario config not found in %s", projectRoot)
	}

	return LoadAndValidatePath(configPath)
}

// LoadAndValidatePath loads and validates from an explicit path.
func LoadAndValidatePath(configPath string) (*ValidateResult, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var raw map[string]interface{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse YAML in %s: %w", configPath, err)
	}

	return validateRaw(raw, configPath)
}

func validateRaw(raw map[string]interface{}, sourcePath string) (*ValidateResult, error) {
	result := &ValidateResult{
		Errors:   []ValidationError{},
		Warnings: []ValidationError{},
	}

	// ── Volumes ──
	rawVolumes, ok := raw["volumes"].(map[string]interface{})
	if !ok {
		result.Errors = append(result.Errors, ValidationError{
			Field:    "volumes",
			Message:  `"volumes" is required and must be an object`,
			Severity: "error",
		})
		return &ValidateResult{Config: &StellarioConfig{}, Errors: result.Errors, Warnings: result.Warnings}, nil
	}

	// Parse user volume definitions
	userVols := map[string]*VolumeDef{}
	userVolRaw := map[string]map[string]interface{}{}

	for name, defRaw := range rawVolumes {
		defMap, ok := defRaw.(map[string]interface{})
		if !ok {
			result.Errors = append(result.Errors, ValidationError{
				Volume:   name,
				Field:    "volume",
				Message:  "volume definition must be an object",
				Severity: "error",
			})
			continue
		}
		userVolRaw[name] = defMap

		isSystem := IsSystemVolume(name)

		// Profile: system volumes lock it, others must specify
		var profile string
		if isSystem {
			profile = string(systemVolumes[name].Profile)
		} else {
			if p, ok := defMap["profile"]; ok {
				profile = fmt.Sprintf("%v", p)
			}
		}

		if profile == "" || !isValidProfile(profile) {
			result.Errors = append(result.Errors, ValidationError{
				Volume:   name,
				Field:    "profile",
				Message:  fmt.Sprintf(`profile must be one of %v, got %q`, validProfiles, profile),
				Severity: "error",
			})
			continue
		}

		// Boundaries: non-system volumes must have them
		boundariesRaw, hasBoundaries := defMap["boundaries"].(map[string]interface{})
		if !isSystem && !hasBoundaries {
			result.Errors = append(result.Errors, ValidationError{
				Volume:   name,
				Field:    "boundaries",
				Message:  `"boundaries" is required`,
				Severity: "error",
			})
			continue
		}

		vol := &VolumeDef{Profile: Profile(profile)}

		if hasBoundaries {
			vol.Boundaries = Boundaries{
				Read:  normalizeAgentList(boundariesRaw["read"]),
				Write: normalizeAgentList(boundariesRaw["write"]),
			}
		}

		if a, ok := defMap["authority"]; ok {
			vol.Authority = fmt.Sprintf("%v", a)
		}
		if p, ok := defMap["requiredTagPrefix"]; ok {
			vol.RequiredTagPrefix = fmt.Sprintf("%v", p)
		}
		if p, ok := defMap["idPrefix"]; ok {
			vol.IDPrefix = fmt.Sprintf("%v", p)
		}

		userVols[name] = vol
	}

	// Build final volumes map: user volumes (non-system) + merged system volumes
	volumes := map[string]*VolumeDef{}

	for name, def := range userVols {
		if !IsSystemVolume(name) {
			volumes[name] = def
		}
	}

	for name, sysDef := range systemVolumes {
		if userDef, exists := userVols[name]; exists {
			// Merge: system provides profile + idPrefix, user overrides boundaries etc.
			merged := &VolumeDef{
				Profile: sysDef.Profile, // always locked
			}
			if len(userDef.Boundaries.Read) > 0 || len(userDef.Boundaries.Write) > 0 {
				merged.Boundaries = userDef.Boundaries
			} else {
				merged.Boundaries = sysDef.Boundaries
			}
			merged.Authority = userDef.Authority
			merged.RequiredTagPrefix = userDef.RequiredTagPrefix
			merged.IDPrefix = sysDef.IDPrefix // locked for system volumes
			volumes[name] = merged
		} else {
			// System volume not in user config — inject default
			volumes[name] = &VolumeDef{
				Profile:    sysDef.Profile,
				Boundaries: sysDef.Boundaries,
				IDPrefix:   sysDef.IDPrefix,
			}
		}
	}

	// ── Validate idPrefix uniqueness ──
	prefixToVolumes := map[string][]string{}
	for name, def := range volumes {
		prefix := def.IDPrefix
		if prefix == "" {
			prefix = string(name[0])
		}
		prefixToVolumes[prefix] = append(prefixToVolumes[prefix], name)
	}
	for prefix, volNames := range prefixToVolumes {
		if len(volNames) > 1 {
			result.Errors = append(result.Errors, ValidationError{
				Field:    "idPrefix",
				Message:  fmt.Sprintf(`prefix %q is used by volumes: %s. Each volume must have a unique idPrefix`, prefix, joinStrings(volNames, ", ")),
				Severity: "error",
			})
		}
	}

	// ── Validate workspace uniqueness ──
	var workspaceVols []string
	for name, def := range volumes {
		if def.Profile == ProfileWorkspace {
			workspaceVols = append(workspaceVols, name)
		}
	}
	if len(workspaceVols) > 1 {
		result.Errors = append(result.Errors, ValidationError{
			Field:    "profile",
			Message:  fmt.Sprintf(`at most one volume can have profile "workspace". Found: %s`, joinStrings(workspaceVols, ", ")),
			Severity: "error",
		})
	}

	// ── Agents ──
	rawAgents, ok := raw["agents"].(map[string]interface{})
	if !ok {
		result.Errors = append(result.Errors, ValidationError{
			Field:    "agents",
			Message:  `"agents" is required and must be an object`,
			Severity: "error",
		})
		return &ValidateResult{
			Config:  &StellarioConfig{Volumes: volumes},
			Errors:  result.Errors,
			Warnings: result.Warnings,
		}, nil
	}

	agents := map[string]*AgentDef{}
	for name, defRaw := range rawAgents {
		defMap, ok := defRaw.(map[string]interface{})
		if !ok {
			agents[name] = &AgentDef{Display: name}
			continue
		}
		display := name
		if d, ok := defMap["display"]; ok {
			display = fmt.Sprintf("%v", d)
		}
		role := ""
		if r, ok := defMap["role"]; ok {
			role = fmt.Sprintf("%v", r)
		}
		agents[name] = &AgentDef{Display: display, Role: role}
	}

	// ── MemoryDir ──
	memoryDir := ".opencode/.stellario"
	if md, ok := raw["memoryDir"]; ok {
		if s, ok := md.(string); ok && s != "" {
			memoryDir = s
		}
	}

	// ── Embedding (optional) ──
	var embedding *EmbeddingConfig
	if emb, ok := raw["embedding"].(map[string]interface{}); ok {
		embedding = &EmbeddingConfig{}
		if e, ok := emb["enabled"]; ok {
			embedding.Enabled = e
		}
		if m, ok := emb["model"]; ok {
			embedding.Model = fmt.Sprintf("%v", m)
		}
	}

	config := &StellarioConfig{
		MemoryDir: memoryDir,
		Volumes:   volumes,
		Agents:    agents,
		Embedding: embedding,
	}

	result.Config = config
	return result, nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func isValidProfile(p string) bool {
	for _, valid := range validProfiles {
		if string(valid) == p {
			return true
		}
	}
	return false
}

func normalizeAgentList(value interface{}) []string {
	if value == nil {
		return []string{}
	}
	switch v := value.(type) {
	case string:
		return []string{v}
	case []interface{}:
		result := make([]string, 0, len(v))
		for _, item := range v {
			result = append(result, fmt.Sprintf("%v", item))
		}
		return result
	default:
		return []string{}
	}
}

func joinStrings(items []string, sep string) string {
	if len(items) == 0 {
		return ""
	}
	result := items[0]
	for i := 1; i < len(items); i++ {
		result += sep + items[i]
	}
	return result
}
