package cluster

// ─── Star Catalog ────────────────────────────────────────────────────────────
//
// Stellario = constellation. Each device is a star.
// Star names are drawn from the brightest stars in the night sky,
// ordered by apparent magnitude (brightest first).
// This is a fixed catalog — no custom names allowed.

// StarEntry defines a star in the constellation.
type StarEntry struct {
	Name     string // IAU star name (e.g. "Sirius")
	Bayer    string // Bayer designation (e.g. "α CMa")
	Constellation string // Constellation abbreviation
	Mag      float64 // Apparent magnitude
}

// StarCatalog is the fixed list of available star names, ordered by brightness.
// Source: Yale Bright Star Catalog, top 40 by apparent magnitude.
var StarCatalog = []StarEntry{
	{"Sirius", "α CMa", "Canis Major", -1.46},
	{"Canopus", "α Car", "Carina", -0.74},
	{"Arcturus", "α Boo", "Boötes", -0.05},
	{"Vega", "α Lyr", "Lyra", 0.03},
	{"Capella", "α Aur", "Auriga", 0.08},
	{"Rigel", "β Ori", "Orion", 0.13},
	{"Procyon", "α CMi", "Canis Minor", 0.34},
	{"Betelgeuse", "α Ori", "Orion", 0.42},
	{"Altair", "α Aql", "Aquila", 0.77},
	{"Aldebaran", "α Tau", "Taurus", 0.85},
	{"Antares", "α Sco", "Scorpius", 1.09},
	{"Spica", "α Vir", "Virgo", 1.04},
	{"Pollux", "β Gem", "Gemini", 1.14},
	{"Fomalhaut", "α PsA", "Piscis Austrinus", 1.16},
	{"Deneb", "α Cyg", "Cygnus", 1.25},
	{"Regulus", "α Leo", "Leo", 1.35},
	{"Adhara", "ε CMa", "Canis Major", 1.50},
	{"Castor", "α Gem", "Gemini", 1.57},
	{"Gacrux", "γ Cru", "Crux", 1.63},
	{"Bellatrix", "γ Ori", "Orion", 1.64},
	{"Elnath", "β Tau", "Taurus", 1.65},
	{"Miaplacidus", "β Car", "Carina", 1.69},
	{"Alnilam", "ε Ori", "Orion", 1.69},
	{"Alnair", "α Gru", "Grus", 1.74},
	{"Alioth", "ε UMa", "Ursa Major", 1.76},
	{"Mirfak", "α Per", "Perseus", 1.79},
	{"Dubhe", "α UMa", "Ursa Major", 1.79},
	{"Kaus", "ε Sgr", "Sagittarius", 1.85},
	{"Wezen", "δ CMa", "Canis Major", 1.83},
	{"Sargas", "θ Sco", "Scorpius", 1.86},
	{"Avior", "ε Car", "Carina", 1.86},
	{"Alkaid", "η UMa", "Ursa Major", 1.86},
	{"Menkalinan", "β Aur", "Auriga", 1.90},
	{"Atria", "α TrA", "Triangulum Australe", 1.91},
	{"Alhena", "γ Gem", "Gemini", 1.93},
	{"Peacock", "α Pav", "Pavo", 1.94},
	{"Polaris", "α UMi", "Ursa Minor", 1.98},
	{"Mirzam", "β CMa", "Canis Major", 1.98},
	{"Alphard", "α Hya", "Hydra", 1.98},
	{"Hamal", "α Ari", "Aries", 2.01},
}

// StarMap is the LOCAL registry mapping device-id → star name.
// This file (.stars.json) is NOT synced — each device maintains its own
// perspective on what to call the other devices it has seen (like SSH
// config Host aliases). Star names are display-only; storage and refs
// use device-id, so renaming never affects data.
type StarMap struct {
	Stars map[string]string `json:"stars"` // device-id → star name
}

// StarsMapPath returns the path to the local .stars.json (not synced).
func StarsMapPath() string {
	return joinPath(GlobalDir(), ".stars.json")
}

// LoadStars reads the local star map.
func LoadStars() (*StarMap, error) {
	data, err := readFile(StarsMapPath())
	if isNotExist(err) {
		return &StarMap{Stars: map[string]string{}}, nil
	}
	if err != nil {
		return nil, err
	}

	var sm StarMap
	if err := jsonUnmarshal(data, &sm); err != nil {
		return nil, err
	}
	if sm.Stars == nil {
		sm.Stars = map[string]string{}
	}
	return &sm, nil
}

// Save writes the local star map to disk.
func (sm *StarMap) Save() error {
	data, err := jsonMarshalIndent(sm)
	if err != nil {
		return err
	}
	return writeFile(StarsMapPath(), data)
}

// usedStarNames returns the set of star names already assigned in this map.
func (sm *StarMap) usedStarNames() map[string]bool {
	taken := make(map[string]bool, len(sm.Stars))
	for _, name := range sm.Stars {
		taken[name] = true
	}
	return taken
}

// assignFreeStar picks the first catalog star not already used in this map.
// Falls back to a synthetic name if the catalog is exhausted.
func (sm *StarMap) assignFreeStar(deviceID string) string {
	taken := sm.usedStarNames()
	for _, star := range StarCatalog {
		if !taken[star.Name] {
			sm.Stars[deviceID] = star.Name
			return star.Name
		}
	}
	// Catalog exhausted — synthesize from device-id hash tail
	name := "Star-" + deviceID
	sm.Stars[deviceID] = name
	return name
}

// StarNameForDevice resolves the star name for a device-id from this device's
// local perspective, assigning one if this device has never seen it before.
// Always persists the assignment. Returns "" on error.
func StarNameForDevice(deviceID string) string {
	if deviceID == "" {
		return ""
	}
	sm, err := LoadStars()
	if err != nil {
		return ""
	}
	if name, ok := sm.Stars[deviceID]; ok {
		return name
	}
	name := sm.assignFreeStar(deviceID)
	_ = sm.Save()
	return name
}

// ensureStarAssignment makes sure the device has a star name assigned in the
// LOCAL star map. Called by GetOrCreateDeviceID — no recursion risk.
// Returns the star name (empty string on error).
func ensureStarAssignment(dev *DeviceID) string {
	if dev.Star != "" {
		// Ensure the local map also records this name (migration from old model).
		sm, err := LoadStars()
		if err == nil {
			if sm.Stars[dev.ID] == "" {
				sm.Stars[dev.ID] = dev.Star
				_ = sm.Save()
			}
		}
		return dev.Star
	}

	star := StarNameForDevice(dev.ID)
	dev.Star = star
	saveDeviceID(dev)
	return star
}

// ─── DeviceID extension ──────────────────────────────────────────────────────

// saveDeviceID writes the device ID back to disk.
func saveDeviceID(dev *DeviceID) error {
	data, err := jsonMarshalIndent(dev)
	if err != nil {
		return err
	}
	return writeFile(DeviceIDPath(), data)
}
