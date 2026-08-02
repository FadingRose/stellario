# Quality Framework — how to judge any skill (this one included)

A skill is a memory entry whose trigger is the agent's task. The
stellario disciplines (strip test, earnability, channel quality) migrate
to the skill surface. Specs define compliance; this defines **quality** —
eight testable criteria. A skill that fails to trigger precisely, absorb
cheaply, or be trusted is bad the same way a bad memory entry is bad.

## The eight criteria

| # | Criterion | Rule | Test |
|---|---|---|---|
| 1 | **Trigger precision** | The description must be EARNED by the body: every capability promised is actually covered; every trigger keyword maps to a real case. | Sample N prompts matching the description — the body must handle them. An unearned description drifts and erodes trust (skill-level alert fatigue). |
| 2 | **Strip test** | Deleting all references/scripts leaves a complete, working workflow. The body is the executable core; references are depth, never dependencies. | Delete references, run the workflow. If the body says "see references/foo.md for the steps", the skill is broken. |
| 3 | **Density** | Every sentence is load-bearing: removing any sentence loses real capability (or real gating). No filler, no meta-commentary. Token budget = the minimum that makes the workflow correct. **What the skill does NOT load is as designed as what it loads.** | Sentence-deletion audit: does capability drop when this sentence is removed? |
| 4 | **Negative space** | The skill declares what it is NOT for. Prevents near-miss misfiring. | Near-miss prompts must be turned away by the walls. |
| 5 | **Actionability** | Every instruction is a button: exact syntax, concrete commands, no "consider/maybe". | Instructions parse into executable steps — commands exist, syntax is exact. |
| 6 | **Freshness** | The skill is versioned and verified against the tool it describes. A stale skill is stale memory recalled with confidence — the worst failure. | `metadata.version` + a verified-against marker; re-verify when the tool changes. |
| 7 | **Earned structure** | references/ exists only where the body exceeded the density budget. Structure follows need, not fashion. | A 200-token skill with 5 references files is over-engineered. |
| 8 | **Identity** | Name is the slug (3–5 precise words); description is the tldr (one dense sentence with trigger keywords). | Both parse as a header: memorable, precise, compressible. |

## Metaprinciple

The framework is recursive: it judges itself. This file exists because
the stellario skill's body exceeded its density budget — the structure
is earned. The skill it describes was written against a real CLI with a
verified-against marker — freshness is earned. If this file ever becomes
filler, it fails criterion 3 and should be deleted.

## The center of gravity

Criterion 3 (density) is the battlefield. The best practitioner skills
already protect context instinctively ("do not read the source, call the
script as a black box"); most skills drown in templates and example
output. When in doubt, cut.
