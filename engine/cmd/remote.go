package cmd

import (
	"fmt"

	"stellario/engine/cluster"
)

// ─── Project Remote Management (subtree-based) ───────────────────────────────

// RunProjectRemote sets or shows the subtree remote for a project.
// The remote is stored in .project-map.json (not in git config).
//   stellario project remote <name>                  → show current remote
//   stellario project remote <name> <url>            → set remote
//   stellario project remote <name> --remove         → remove remote
func RunProjectRemote(name string, args []string) int {
	pm, err := cluster.LoadProjectMap()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	entry, exists := pm.Projects[name]
	if !exists {
		fmt.Printf("Project %q is not registered.\n", name)
		return 1
	}

	if len(args) == 0 {
		// Show current remote
		if entry.Remote == "" || entry.Remote == "(remote-only)" {
			fmt.Printf("No remote configured for %q.\n", name)
			fmt.Printf("Set with: stellario project remote %s <url>\n", name)
		} else {
			fmt.Printf("%s → %s\n", name, entry.Remote)
		}
		return 0
	}

	if args[0] == "--remove" {
		entry.Remote = ""
		pm.Projects[name] = entry
		if err := pm.Save(); err != nil {
			fmt.Printf("Error: %v\n", err)
			return 1
		}
		fmt.Printf("Removed remote for %q.\n", name)
		return 0
	}

	// Set remote
	remoteURL := args[0]
	entry.Remote = remoteURL
	pm.Projects[name] = entry
	if err := pm.Save(); err != nil {
		fmt.Printf("Error: %v\n", err)
		return 1
	}

	fmt.Printf("✓ Set remote for %q: %s\n", name, remoteURL)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Printf("  Push:  stellario memory-sync --push --project %s\n", name)
	fmt.Printf("  Pull:  stellario memory-sync --pull --project %s\n", name)
	return 0
}
