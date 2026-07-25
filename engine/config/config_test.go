package config

import (
	"os"
	"path/filepath"
	"testing"
)

// writeConfig writes a stellario.yaml into a temp project .opencode dir and
// returns the project root.
func writeConfig(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	opencode := filepath.Join(dir, ".opencode")
	if err := os.MkdirAll(opencode, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(opencode, "stellario.yaml"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return dir
}

func validate(t *testing.T, root string) *StellarioConfig {
	t.Helper()
	result, err := LoadAndValidate(root)
	if err != nil {
		t.Fatalf("LoadAndValidate: %v", err)
	}
	if len(result.Errors) != 0 {
		t.Fatalf("unexpected validation errors: %+v", result.Errors)
	}
	return result.Config
}

func TestSystemVolumeDefaultsApplyWhenOmitted(t *testing.T) {
	root := writeConfig(t, `
volumes:
  active:
    profile: mutable
    boundaries: { read: [all], write: [edelweiss] }
agents:
  edelweiss: { display: "Edelweiss" }
`)
	cfg := validate(t, root)
	// System volumes not declared should get their default profiles.
	// (layer is no longer a system volume — projects declare it explicitly.)
	for name, want := range map[string]string{
		"archived": "frozen", "meta": "mutable", "handover": "append",
	} {
		vol, ok := cfg.Volumes[name]
		if !ok {
			t.Errorf("system volume %q missing from resolved config", name)
			continue
		}
		if string(vol.Profile) != want {
			t.Errorf("system volume %q: profile = %q, want default %q", name, vol.Profile, want)
		}
	}
}

func TestSystemVolumeProfileOverridable(t *testing.T) {
	// The core behavior change: config can override a system volume's profile.
	root := writeConfig(t, `
volumes:
  handover:
    profile: mutable
    boundaries: { read: [all], write: [all] }
  meta:
    profile: scratch
    boundaries: { read: [edelweiss], write: [edelweiss] }
  active:
    profile: mutable
    boundaries: { read: [all], write: [edelweiss] }
agents:
  edelweiss: { display: "Edelweiss" }
`)
	cfg := validate(t, root)

	handover := cfg.Volumes["handover"]
	if string(handover.Profile) != "mutable" {
		t.Errorf("handover profile = %q, want %q (config override)", handover.Profile, "mutable")
	}
	meta := cfg.Volumes["meta"]
	if string(meta.Profile) != "scratch" {
		t.Errorf("meta profile = %q, want %q (config override)", meta.Profile, "scratch")
	}
	// meta boundaries should reflect the user override, not the system default.
	if len(meta.Boundaries.Read) != 1 || meta.Boundaries.Read[0] != "edelweiss" {
		t.Errorf("meta boundaries.read = %v, want [edelweiss]", meta.Boundaries.Read)
	}
}

func TestSystemVolumeIdPrefixOverridable(t *testing.T) {
	root := writeConfig(t, `
volumes:
  handover:
    profile: append
    boundaries: { read: [all], write: [all] }
    idPrefix: "ho"
  active:
    profile: mutable
    boundaries: { read: [all], write: [edelweiss] }
agents:
  edelweiss: { display: "Edelweiss" }
`)
	cfg := validate(t, root)
	handover := cfg.Volumes["handover"]
	if handover.IDPrefix != "ho" {
		t.Errorf("handover idPrefix = %q, want %q (config override)", handover.IDPrefix, "ho")
	}
}

func TestSystemVolumeOmittedFieldFallsBackToDefault(t *testing.T) {
	// User declares handover with custom boundaries but omits profile and
	// idPrefix — system defaults should fill those in.
	root := writeConfig(t, `
volumes:
  handover:
    boundaries: { read: [edelweiss], write: [edelweiss] }
  active:
    profile: mutable
    boundaries: { read: [all], write: [edelweiss] }
agents:
  edelweiss: { display: "Edelweiss" }
`)
	cfg := validate(t, root)
	handover := cfg.Volumes["handover"]
	if string(handover.Profile) != "append" {
		t.Errorf("handover profile = %q, want default %q (omitted → default)", handover.Profile, "append")
	}
	if handover.IDPrefix != "h" {
		t.Errorf("handover idPrefix = %q, want default %q (omitted → default)", handover.IDPrefix, "h")
	}
	if len(handover.Boundaries.Read) != 1 || handover.Boundaries.Read[0] != "edelweiss" {
		t.Errorf("handover boundaries.read = %v, want [edelweiss] (user override)", handover.Boundaries.Read)
	}
}

func TestAgentInjectMetaParsed(t *testing.T) {
	// An agent may declare inject.meta tags to scope which meta entries it receives.
	root := writeConfig(t, `
volumes:
  active:
    profile: mutable
    boundaries: { read: [all], write: [edelweiss] }
agents:
  audit:
    display: "Audit"
    inject:
      meta: [type:audit, type:convention]
  impl:
    display: "Impl"
  edelweiss: { display: "Edelweiss" }
`)
	cfg := validate(t, root)

	audit := cfg.Agents["audit"]
	if audit.Inject == nil {
		t.Fatal("audit agent: inject is nil, want configured")
	}
	if len(audit.Inject.Meta) != 2 {
		t.Fatalf("audit inject.meta = %v, want 2 tags", audit.Inject.Meta)
	}
	want := map[string]bool{"type:audit": false, "type:convention": false}
	for _, tag := range audit.Inject.Meta {
		want[tag] = true
	}
	for tag, found := range want {
		if !found {
			t.Errorf("audit inject.meta missing %q", tag)
		}
	}

	// impl has no inject declaration — should be nil (default = inject all).
	impl := cfg.Agents["impl"]
	if impl.Inject != nil {
		t.Errorf("impl inject = %+v, want nil (no declaration → default)", impl.Inject)
	}
}
