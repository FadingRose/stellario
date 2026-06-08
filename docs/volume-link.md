# Volume Link

Cross-project memory observation between Stellario instances.

---

## Overview

An agent can link volumes from other Stellario projects into its working context. The external volume is accessed readonly via symlink — the agent observes without modifying.

```bash
# Discover what's available
discover(path="/path/to/other/project")

# Link an external volume
link(project="/path/to/other/project", volume="active", alias="other_active")

# Search includes linked volumes automatically
search(query="authentication")
```

## How It Works

1. **discover** scans a path for `.opencode/stellario.yaml` and reports available volumes and agents
2. **link** creates a symlink from your memory directory to the external project's volume data (readonly)
3. All tools (create, show, search, etc.) transparently include linked volumes — no extra flags needed
4. **unlink** removes the symlink

Linked volumes respect the *source project's* permission model — your agent's boundaries are checked against the remote config.

## Use Cases

- A security audit project linking the client project's `active` volume for context
- A research project linking a knowledge base project's `meta` volume
- Multiple related projects sharing a `layer` workspace volume
