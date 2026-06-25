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

// StarConstellation holds the global registry of device → star assignments.
// This file IS synced (tracked in git), so all devices know each other's stars.
type StarConstellation struct {
	Stars map[string]StarAssignment `json:"stars"`
}

// StarAssignment maps a star name to a device.
type StarAssignment struct {
	DeviceID  string `json:"device_id"`
	Hostname  string `json:"hostname"`
	Platform  string `json:"platform"`
	AssignedAt string `json:"assigned_at"`
}

// ConstellationPath returns the path to the synced constellation registry.
func ConstellationPath() string {
	return joinPath(GlobalDir(), ".constellation.json")
}

// LoadConstellation reads the global star registry.
func LoadConstellation() (*StarConstellation, error) {
	data, err := readFile(ConstellationPath())
	if isNotExist(err) {
		return &StarConstellation{Stars: map[string]StarAssignment{}}, nil
	}
	if err != nil {
		return nil, err
	}

	var c StarConstellation
	if err := jsonUnmarshal(data, &c); err != nil {
		return nil, err
	}
	if c.Stars == nil {
		c.Stars = map[string]StarAssignment{}
	}
	return &c, nil
}

// Save writes the constellation to disk.
func (c *StarConstellation) Save() error {
	data, err := jsonMarshalIndent(c)
	if err != nil {
		return err
	}
	return writeFile(ConstellationPath(), data)
}

// AssignedStarNames returns the set of already-assigned star names.
func (c *StarConstellation) AssignedStarNames() map[string]bool {
	taken := make(map[string]bool, len(c.Stars))
	for name := range c.Stars {
		taken[name] = true
	}
	return taken
}

// AssignStar assigns the first available star from the catalog to a device.
// Returns the assigned star name.
func AssignStar(c *StarConstellation, dev *DeviceID) string {
	taken := c.AssignedStarNames()

	for _, star := range StarCatalog {
		if !taken[star.Name] {
			c.Stars[star.Name] = StarAssignment{
				DeviceID:   dev.ID,
				Hostname:   dev.Hostname,
				Platform:   dev.Platform,
				AssignedAt: nowISO(),
			}
			return star.Name
		}
	}

	// Catalog exhausted (40+ devices) — fall back to device ID hash
	return dev.ID
}

// FindStarByDevice returns the star name assigned to a device, or "" if not found.
func (c *StarConstellation) FindStarByDevice(deviceID string) string {
	for name, assignment := range c.Stars {
		if assignment.DeviceID == deviceID {
			return name
		}
	}
	return ""
}

// ensureStarAssignment makes sure the device has a star name assigned.
// Called by GetOrCreateDeviceID — no recursion risk.
// Returns the star name (empty string on error).
func ensureStarAssignment(dev *DeviceID) string {
	if dev.Star != "" {
		return dev.Star
	}

	// Check constellation for existing assignment
	c, err := LoadConstellation()
	if err != nil {
		return ""
	}

	star := c.FindStarByDevice(dev.ID)
	if star == "" {
		// Assign a new star
		star = AssignStar(c, dev)
		c.Save()
	}

	// Persist star to device-id
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
