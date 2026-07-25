# Proposal: Token Warning and Context Management

## Status
Draft — awaiting review.

## Motivation

`buildStatus` pushes its entire assembled output into the agent's system
prompt with zero size awareness. The meta block injects every non-disabled
entry verbatim. A comment in the code says "keep meta lean: signal dilutes
with volume" — but nothing enforces or even measures it.

Concretely: if `meta` grows to 20 entries averaging 300 tokens each, that is
6k tokens of system prompt consumed before the conversation begins. The agent
has no visibility into this cost and no lever to control it. Token dilution
degrades the agent's attention to the actual task.

The declaration-first refactor made injection **selectable** (meta tags,
proposed sections). This proposal makes injection **measurable** and
**budgetable** — the agent sees its own context weight and can cap it.

## Proposed Model

Three layers, increasing in intervention:

### 1. Measurement (always on)

Every injection computes an approximate token cost. The estimate is
deliberately crude — `chars / 4` — to avoid any dependency on a tokenizer.
No external calls, no model coupling, deterministic.

The assembled status ends with a single summary line:

```
[context: ~2.8k tokens across 4 sections, 9 entries]
```

This makes the cost **visible** to the agent on every session start. What is
visible can be managed.

### 2. Warning (threshold-based)

When the total injected context exceeds a threshold, the summary becomes a
warning:

```
[⚠ context heavy: ~6.2k tokens across 5 sections, 18 entries — consider consolidating meta or declaring fewer sections]
```

Default threshold: 4000 tokens (tunable). The warning is advisory — it does
not truncate; it tells the agent its context is heavy and suggests levers
(consolidate meta, declare fewer sections, enable GC).

### 3. Budget (declared, optional)

An agent may declare a hard `maxTokens` budget. When the assembled context
would exceed it, a strategy applies:

```yaml
agents:
  audit:
    inject:
      meta: [type:audit]
      sections: [meta, latestHandover]
      maxTokens: 2000
      overBudget: warn   # warn | truncate
```

- `warn` (default): inject anyway, but the summary flags the overrun.
- `truncate`: drop the lowest-priority entries/sections until under budget.
  Priority order: usage guide drops first, then LSP/locks/mounts, then older
  meta entries (keeping the most-recently-updated). `meta` with
  `meta:disable`-respect is always retained longest.

### What is NOT in scope (v1)

- **LLM-generated summaries/digests.** Replacing verbose entries with a
  model-generated digest is powerful but heavy (requires an LLM call at
  session start, adds latency + cost + nondeterminism). Out of scope for v1;
  the crude measurement + structural levers (sections, GC) handle the common
  case without it.
- **Precise tokenization.** `chars/4` is wrong for CJK and for code, but it
  is consistently wrong and good enough to drive warnings. Precise counting
  can come later if the approximation proves misleading in practice.

## Open Design Questions

1. **What counts toward the budget.** Only `meta`? Or all sections
   (including volume stats, handover, plan tree)? Lean: all sections — the
   agent's total system-prompt weight is what matters for attention
   dilution, regardless of source.

2. **Threshold granularity.** One global threshold, or per-section
   thresholds (e.g. meta-specific)? Lean: one global threshold initially;
   the summary already breaks down by section so the agent can see where the
   weight is.

3. **Truncate determinism.** If `overBudget: truncate`, the drop order must
   be deterministic and logged (which entries/sections were dropped), so the
   agent knows what it is NOT seeing. Hidden truncation is dangerous — it
   makes the agent confidently wrong. Lean: always emit a
   `[truncated: dropped X, Y to fit 2000-token budget]` line.

4. **Interaction with GC.** GC reduces volume size at the source; token
   warnings measure rendered size. They target different stages. An agent
   seeing repeated heavy-context warnings should enable GC, not just
   truncate.

5. **Per-entry cost attribution.** Should the summary show per-entry token
   costs (so the agent knows which specific entry is heavy and worth
   revising)? Lean: yes in the `status` tool output (verbose), not in the
   injected prompt (keep the prompt line short).

## Impact

- A token-estimation helper (`estimateTokens(str): number`).
- `buildStatus` wraps its output with measurement + optional warning +
  optional truncation.
- New optional fields on `inject`: `maxTokens`, `overBudget`.
- No breaking change — without declaration, only layer 1 (measurement) and
  layer 2 (warning) apply, which are additive (a summary line).

## Relationship to Other Proposals

- **Declarative inject sections** — section declaration is the structural
  lever; `maxTokens` is the numerical cap. An agent that declares minimal
  sections rarely needs a budget; an agent that declares many sections uses
  the budget as a safety net.
- **Declarative volume GC** — GC keeps volumes structurally lean (fewer
  entries to inject); token management handles the rendered-output size.
  Together they address bloat at storage and render time respectively.
