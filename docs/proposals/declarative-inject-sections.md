# Proposal: Declarative Inject Sections

## Status
Draft — awaiting review.

## Motivation

`buildStatus` is a procedurally-assembled string. It hardcodes which sections
every agent receives, in a fixed order: volume stats, (workspace — removed),
latest handover, plan tree, active locks, native mounts, LSP status, meta
injection, and a static usage guide.

The declaration-first refactor gave agents control over **which meta entries**
they receive (via `inject.meta` tags). But an agent still cannot control
**which sections** it receives. An audit agent doing a focused code review
does not need the plan tree, the active locks, or the LSP status — yet it
gets all of them, paying token cost for irrelevant context.

The goal: make `buildStatus` a **declaration-driven template**, not a
hardcoded assembly. An agent declares the sections it wants; the system
computes and renders exactly those.

## Proposed Model

An agent's `inject` block may declare a `sections` list. When present, only
the named sections are rendered. When absent, all sections render (backward
compatibility).

### Schema

```yaml
agents:
  audit:
    display: "Audit"
    inject:
      meta: [type:audit, type:convention]
      sections: [meta, latestHandover]
  impl:
    display: "Impl"
    inject:
      sections: [meta, latestHandover, volumeStats]
  edelweiss:
    display: "Edelweiss"
    # no sections declared → receives everything (default)
```

### Available sections

| Section | Content | Cost |
|---|---|---|
| `meta` | Declared meta entries (tag-filtered) | variable |
| `latestHandover` | Most-recently-updated handover entry by this agent | low |
| `volumeStats` | Entry counts per volume | low |
| `planTree` | Active coordination tasks (non-done) | medium |
| `locks` | Active file locks | low |
| `mounts` | Native + sibling-device mounted volumes | low |
| `lsp` | LSP server status | low |
| `gc` | Last GC report (see declarative-volume-gc proposal) | low |

### Semantics

- `sections` omitted → all sections (current behavior, zero migration cost).
- `sections: [...]` → only listed sections, in canonical order.
- `meta` section still respects `inject.meta` tag filtering — the two compose.
  An agent can declare `sections: [meta]` with no `meta` tags and receive all
  meta; or `sections: [meta]` with `meta: [type:audit]` and receive only
  audit-tagged meta.
- Unknown section names are ignored with a warning (non-fatal).

### Why declaration, not code

This extends the throughline of `7634029`: the system stops deciding what an
agent needs. The agent declares its own context surface. `buildStatus`
becomes `f(agentDeclaration) → compute needed data → render`. The agent is
the authority on its own context budget.

## Open Design Questions

1. **Stable section list vs extensibility.** Should the section set be a
   fixed enum, or should volumes be able to declare custom sections (e.g. a
   `vision` volume declaring itself a section)? Lean: start with a fixed
   enum; revisit if custom sections are needed.

2. **Usage guide inclusion.** The static "Stellario Memory System" usage
   guide is currently always appended. Should it be a declarable section
   (`usageGuide`), or always-on for onboarding? Lean: make it a section,
   default-included, so experienced agents can drop it.

3. **Guardian sections.** The guardian resolves to global config. Should the
   global config declare the guardian's sections (e.g. only `meta` +
   `latestHandover`)? Lean: yes — the guardian is the cleanest case for a
   minimal section set.

4. **Section ordering.** Canonical order regardless of declaration order, or
   respect the declared order? Lean: canonical order for predictability.

5. **Empty-section elision.** If a declared section has no data (e.g.
   `locks` when no locks are held), should it render a "(none)" line or be
   silently omitted? Lean: omit silently when empty, to save tokens.

## Impact

- New optional field `inject.sections: string[]` on `AgentDef` (TS + Go).
- `buildStatus` refactored from one long procedure to a section registry:
  each section is a named renderer; `buildStatus` invokes only declared ones.
- No breaking change — omitted `sections` preserves current behavior.
- Composes naturally with token budget management (fewer sections = fewer
  tokens, agent-controlled).

## Relationship to Other Proposals

- **Token context management** — section declaration is the primary
  structural lever for token budget; `maxTokens` is the secondary cap.
- **Declarative volume GC** — the GC report is itself a section, opt-in.
