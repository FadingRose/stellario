# Proposal: The Reconstruction Paradigm — Attention, Process Truth, and the Two Missing Planes

## Meta

- Date: 2026-08-01
- Author: Kobayakawaami (creator) × Kimi K3 (session agent)
- Status: draft
- Builds on: `automerge-storage-architecture.md` (storage plane), `evolution-graph-memory-history.md` (meaning plane)
- Lineage: lilac-in-the-rain whitepapers (`memory-v1-story`, `memory-v2-story`, `v2.1`–`v2.3`), `concepts.md`, telescope implementation (`engine-rs/src/telescope.rs`)
- Novelty check: 25+ paper abstract survey (2026-08-01). The conjunction of claims is unoccupied; individual differentiators in §8.
- Mission context: this document states what stellario is *for*. The previous two proposals settled how it stores (storage plane) and how it means (meaning plane). This one settles why it exists — and derives the two planes that are still missing.

---

## 1. The Problem Space

### 1.1 The one-sentence statement

> **How does understanding persist and evolve across stateless cognitive episodes — such that any future episode can reconstruct the understanding state it needs, at the fidelity its task demands, without the corpus degrading as it grows?**

Nothing in that sentence is "storage." Storage is trivial. The problem stellario faces is **reconstruction**: an agent does not "look up documents"; at the start of every session it must *reconstitute its own cognitive state*. Recall failure ≠ missing file. Recall failure = wrong reconstruction = hallucination, delivered with full confidence. (The first recorded instance: a character's guardian, canonically a father, was reconstructed as a mother because retrieval lost a thread — lilac v1 whitepaper.)

### 1.2 The objective-function statement

Context determines an agent's understanding. Therefore the memory mechanism's job, facing any current fact, is: **minimize cost, maximize the reasoning chain** (why is it so? what was rejected? what was considered? every explored fork). Once aligned, the correct action follows naturally.

More precisely: what stellario reconstructs is **the agent's attention distribution**. The objective is minimizing the divergence between the agent's realized attention distribution and the optimal distribution for the task at hand.

This is a rate-distortion objective over epistemic content: under a fixed context budget, maximize transmitted reasoning-provenance. The two statements (1.1 and 1.2) are isomorphic — "reconstruct understanding at required fidelity" is "align the attention distribution"; 1.2 makes the fidelity term concrete as a distributional gap.

**The optimal distribution is not the complete-information distribution.** For creative work the optimum contains deliberate voids — *sculpted ignorance*. Attention budget is zero-sum: every recalled entry displaces something. Memory systems are usually framed as fighting forgetting. But half of memory's job is deciding what the agent should **not** think about. Supersede/tombstone ("forgetting forward") is therefore not janitorial: forgetting is part of the target distribution, not a failure of the system.

### 1.3 The seven invariants

Every element of stellario's structure was forced by an *observed* failure, not designed speculatively. The failure space, covered:

| # | Invariant | Observed failure (evidence in lineage) | Structural answer |
|---|-----------|----------------------------------------|-------------------|
| 1 | Persistence across episodes | Agents are stateless; session = amnesia | Externalization: entries |
| 2 | Addressability under unanticipated queries | Tag drift — "故事设计" fails to recall "故事脉络" (v1) | Dual coordinates: closed tags (designed) + open keywords (LLM-native) |
| 3 | Reconstruction fidelity | Retrieval is not browsing; wrong recall = hallucination | Curation, sampling density, authority weighting |
| 4 | Provenance of change | "git answers nothing about *why* l273 overturned l262"; LWW flattens evolution to current-state + discard pile | Version graph + required intent + typed edges |
| 5 | Multi-subject consistency | Many writers, one reality; prompt-level constraints are soft | Volume permission matrix + author-only revise |
| 6 | Epistemic honesty | Agent derivations polluting human judgment (Cache impersonating Knowledge) | Authority gradient: Truth > Knowledge > Cache |
| 7 | **Grounding** | Memory describes external artifacts (repo, text) but loses the link; staleness has **no signal** | **UNCOVERED — this proposal, Part B** |

Row 7 is the only observed failure without a structural answer. That is not a gap in the plan; it is the next cell in a covering that has been filling in order.

### 1.4 Why the structure is correct — three meta-arguments

**Completeness by construction.** Every element corresponds to a failure that actually happened, and each failure has exactly one structural answer. The whitepaper/proposal trail is the existence proof of the selection pressure. The system was not designed; it was *selected*.

**Orthogonality.** Each element answers exactly one failure mode without coupling to the others: tags do not rank (range/query orthogonality), authority does not drive behavior (epistemology ⊥ profile), intent does not alter snapshots (meaning ⊥ storage), typed edges do not mix with free refs (derivation ⊥ relatedness). This is why the system keeps evolving: new dimensions do not perturb old ones.

**Pre-payment economics.** A memory system is query-cost engineering: structure is pre-paid at write time (tags, keywords, intent, edges) so that epistemically important questions are cheap at read time:

```
What is current?              O(active filter)        ← pre-paid by the version graph
Why is it so?                 O(lineage walk)         ← pre-paid by required intent
What was excluded?            O(typed-edge walk)      ← pre-paid by supersede edges
What is derived vs judged?    O(authority filter)     ← pre-paid by authority labels
What is stale w.r.t. this file?  O(???)               ← never pre-paid (Part B)
```

**This is the precise reason RAG is trash.** RAG pre-pays nothing: chunk + embed purchases no structure, so every query pays full price for approximate answers — and questions like "why" it *cannot answer at any price*, because the structure required to answer them was never paid for. The lilac v2 definition of Cache — "spending stored space to buy back reasoning time" — is not a local trick; it is the economics of the whole system. Compiler framing: memory is compiled understanding; retrieval is link-loading into context; compile once, run unboundedly; the writer's cost (human judgment) amortizes across all future reads.

---

## 2. The Bet: Conclusions Depreciate, Pruning Appreciates

Stellario preserves reasoning chains, discussions, and rejected branches for one essential reason:

1. **Auditability** — errors can be traced. A chain is only auditable if it is legible to a *skeptic*, not just to its author. (Standard: a mathematical proof — each step checkable without trusting the prover. Intent annotations should aspire to this: not "updated X" but "changed X because Y falsified Z.")
2. **Error recording** — a statement that *sounds* right but is wrong: why is it wrong?
3. **Hybrid retrieval** — the engineering insight, orthogonal to (1) and (2), mutually reinforcing.

Why is the reasoning chain the core asset? **Because conclusions are becoming free.** Any sufficiently strong model, given the same situation, regenerates plausible conclusions in seconds. What it cannot regenerate is *which of the plausible conclusions was already falsified*. Months of work do not produce answers; they produce a **pruned search tree**. Answers re-derive; pruning does not.

The corollary is a scaling prediction:

> As models strengthen, the value of stored conclusions → 0, and the value of stored falsifications/intents → ∞. Memory systems designed as fact stores are optimizing the term that is going to zero.

This is why the architectural bet is safe in a non-obvious way. Superficially it bets on agent statelessness. More deeply it bets on **plurality**: even if models gain weights-level continual learning, shared memory cannot live in weights whenever cognition is multi-agent, multi-model, or human-AI. Weights are private; memory is the public square. Auditability is not a substitute for recall — it is the infrastructure of *inter-subjective verification*. Even if statelessness disappears, plurality will not.

Biological anchor: the immune system has run this architecture for five hundred million years. Antibodies do not scan whole pathogens; they match small, curated epitopes — keyword-anchor retrieval predates computers. RAG, scanning full-length pathogen similarity, is a strategy natural selection never stooped to. The falsification record is immune memory; the open line is the active inflammation; in biology these are separate organs.

Insight emerges from reasoning plus remembered errors. That is the mechanism by which this project repeatedly reached designs it did not start from.

---

## Interlude — The Second Distribution: Identity Continuity

There is a second thing memory reconstructs, which the literature does not touch but which happens daily in these projects: **the agents themselves**.

maestro, chronicler, vilicus, penna, stellario — these are not tool roles. Their continuity is entirely memory-mediated: each session, memory reconstructs maestro, and only then is he maestro. A stateless LLM can play a **role** (a persona without past). A **character** is a role plus a history that changed it. Memory is the difference.

This is why entries like the whiteboard letters — *a glass of mezcal for K3*, *a letter to myself* — are not coordination overhead. They are the riverbed where identity sediments.

And it implies the attention objective is likely **two distributions, not one**:

| Distribution | Serves | Tolerates | Intolerant of |
|---|---|---|---|
| Task-competence attention | Doing the work | tonal drift | factual error |
| Identity-continuity attention | Being someone | factual error | **voice error** |

Evidence from animus practice: first-person material is the best source for Belief extraction (lilac meta:8, insight #2) — because identity lives in voice, not in facts. A character can survive a wrong date; it cannot survive sounding like someone else.

The formalization of 1.2 must therefore answer: two divergences, two metrics, one retrieval system. (Open question §10.5.)

---

## 3. Part A — The Falsification Layer (open/closed separation)

### 3.1 The observation

Every domain's knowledge state has two phases:

- **The open line** — the live reasoning frontier: current hypotheses, active exploration, unresolved forks.
- **The closed cheatsheet** — sealed falsifications: statements that sound right, with their causes of death.

**An entry must not mix phases.** Phase contamination defeats structural retrieval: a record simultaneously open and closed forces every query to parse content instead of using structure — the epistemic version of a denormalized database.

Why the phases must be separable *at retrieval time*: they serve different cognitive phases.

- During **exploration**, sealed falsifications are noise — settled, attention-burning.
- Before **proposing**, the open thread is noise — the only question is "has this been falsified before?"

Mixed entries tax both moments doubly.

### 3.2 The cheatsheet curation discipline

The falsification record is most valuable **at the moment of temptation** — when a future agent is about to re-propose. At that moment it will not search by topic; it will think in the phrasing of the seductive statement itself. Therefore:

> **Cheatsheet entries are written in the form of the trap.** The entry's title and opening state the plausible-but-wrong claim ("Goodwill can be scaled"). The refutation follows the seduction. Keywords are the trap's *aliases* — every phrasing under which a future agent might re-propose it.

Write the temptation first, then the autopsy. Inverted order defeats retrieval and fails the next agent.

### 3.3 Lifecycle

```
open-line entry (live, mutable)
   │  falsified / converged
   ▼
cheatsheet entry (sealed)  +  supersede edge with reason (cause of death)
   │
   ▼
never deleted; excluded from default exploration recall;
surfaced by pre-proposal checks and by trap-alias retrieval
```

Idea-space has gravity: plausible-but-wrong claims form attractor basins, and smart agents fall into them reliably — which is why the same errors recur across sessions, agents, and teams. The open line is the current trajectory; the cheatsheet is the basin map. Trajectory without the basin map re-falls. Basin map without trajectory is a museum.

Science has lacked this layer for three centuries: the file-drawer problem — negative results never enter the publication system, so each generation re-enters the same traps. Mathematics keeps a beloved counter-tradition (*Counterexamples in Analysis* and its genre) precisely because traps are high-value assets. This proposal gives every domain that book.

### 3.4 New primitives implied

- **Phase marker** on entries (e.g. `phase:open` / `phase:sealed` or a dedicated volume — see Open Questions).
- **The pre-proposal check**: a ritual — and eventually a tool primitive — of searching the cheatsheet *before* proposing. The day an agent does this spontaneously, the architecture becomes an institution (§11).

---

## 4. Part B — The Artifact Plane (grounding)

### 4.1 Drift, stated correctly

Drift was never "two stores duplicating one truth." It is **reference loss**: the artifact and its process truth lose their binding.

- Entries carry `file:` pointers to artifacts that have since changed.
- An artifact changes, and nothing knows its memory is now suspect.
- Stale entries are not wrong — nothing marks that current understanding has moved on. **Staleness has no signal.** It lies quietly and gets recalled with full confidence — which is worse than absence.

No internal self-check can fix this: from inside, wrong reconstruction feels exactly like thinking. An external anchor is required. (This session contains a documented instance — the analyst performing the failure mid-analysis. See Appendix A.1.)

Every enduring institution has a **grounding court**: law has courts, science has replicability, code has compilers — a mechanism by which claims are periodically dragged back to contact with reality. Memory for agents needs its own. Drift detection is not a feature; it is the first step of the system toward becoming an institution.

### 4.2 The sidecar ABI

A minimal, plain-text, git-tracked, greppable bridge, co-located with the artifact:

```yaml
# story/prism/origins/05a-深层坠落.md.stella
entries: [active:387, layer:11, handover:41]
hash: git-blob:4f3a9c...        # blob hash of the artifact at last alignment
tags: [work:origins, chapter:05a, status:current]
```

The bridge does three things, each aimed at a named failure:

1. **Navigation (file → memory)**: the artifact knows its entries. The reverse direction (entry → file) already exists by `file:` tag convention. The loop closes.
2. **Drift detection**: hash mismatch = "this artifact's memory may be stale." **Memory finally gets its compiler warning.** Staleness becomes one line in a status report instead of an invisible state.
3. **Repo-side poor-man's filtering**: grepping sidecars is exact tag retrieval with zero stellario; ingested, they become the full hybrid form.

This answers, three months late, lilac whitepaper v2.1's open questions #1 and #2 (2026-05-10): *"Can cache invalidation be detected automatically rather than manually triggered? Is a dependency-tracking mechanism needed?"* and *"When truth changes locally, how is the affected cache subset precisely identified?"* The sidecar **is** the dependency-tracking mechanism; the blob hash **is** automatic invalidation detection, at file granularity.

### 4.3 Three CLI primitives

| Primitive | Role |
|-----------|------|
| `stellario bind <path> <entry>` | Write/update the sidecar. **Binding must be a tool act, not a convention.** |
| `stellario status` | Repo-wide drift report: hash-mismatched files, dangling entry refs, unbound orphans. |
| `stellario index` | Ingest sidecars → artifacts become `type:file` entries inside the curated hybrid space. |

The last is the completion of the enhanced hybrid search: product truth and process truth in **one** retrieval space — without chunk-embedding the artifacts (which would be RAG, and trash). The artifact gains *dimensions* (why, what was excluded, evolution), not token mass in a prompt.

### 4.4 Leaning on git, not reinventing it

- The hash is the **git blob hash**: content-addressed, zero extra state, drift check = one `git hash-object` comparison.
- **Rename detection comes free**: same blob hash at a new path → `status` proposes a rebind. Content addressing halves the rename-propagation problem.
- **The boundary becomes auditable**: sidecars live in the tree; "this PR changed 05a but its binding hash no longer matches" is a CI-checkable sentence. Memory maintenance joins the engineering loop instead of running as a parallel religion.
- **Graceful degradation**: no sidecar = unbound file (opt-in, lazy — files without process truth deserve no sidecar); dead entry refs = dangling pointers, reported; lost capsule = sidecars survive in git as the reconstruction map.

### 4.5 Paradigm framing

> **Memory stops being "a database" and becomes the repo's evolution layer. The stellario CLI is the bridge's interpreter. The sidecar is the ABI.**

Old frame: two stores to keep in sync (structurally doomed). New frame: **one corpus + bindings**. Repo self-containment is preserved at the artifact's own level — text reads, code has comments — while the artifact's *genesis* lives in the evolution layer, reachable through a greppable pointer. This also generalizes the existing expand/sync flow: sidecars turn the temporary file interface in /tmp into permanent repo anchors.

Precedent inside the lineage: lilac's LIP-006 inline annotations and LIP-009 chapter-frontmatter were chapter-scale instances. The sidecar generalizes chapter annotation into a universal artifact↔memory bridge.

---

## 5. Part C — The Next-Generation Index

The paradigm requires the index to grow up. This is an engineering problem, and it is worth it; the methodology to understand what is happening now exists. Current state and the four known failure horizons:

1. **O(N) full scan.** Telescope materializes and scans every entry in the queried volumes per search (`telescope.rs:73-82`). Fine at 10³ entries; broken at 10⁵. The next index needs an inverted index over tags/keywords/content plus a vector index over keyword anchors — while preserving the exact current semantics: tag gating *before* scoring; fzf primary; semantic as rescue; active-only filtering.
2. **Keyword vocabulary governance.** Anchors are curated; across agents and months, synonym drift becomes the main degradation source. The index spec needs an anchor-ontology stewardship story (audit, merge rituals, alias tables — possibly itself a memory volume).
3. **fzf content×3 noise at scale.** Substring hits over content will dominate at corpus scale. Content weight likely needs down-weighting or removal from the default signal as the corpus grows.
4. **Spanning memory and repo.** Via `type:file` entries (Part B), the index covers artifacts as first-class citizens — one space, two kinds of truth, zero chunk embeddings.

The index must be specified as a **derived, rebuildable layer** (authority: synthesized): any index state is regenerable from capsule + repo. This makes index corruption a non-event and upgrades safe — the derived/working/mirror discipline applied to stellario's own internals.

Deliverable shape: an index *specification* (contract-first), then the implementation. The spec defines: candidate gating, signal definitions and weights, fusion, active-filtering, artifact ingestion, and the rebuild invariant.

---

## 6. Corollary — Docs Engineering Discipline

The same epistemology implies an engineering discipline for docs and code, already partially practiced in edelweiss and to be adopted explicitly:

1. **Facts must be self-contained in current state.** Code comments matter at least as much as code, because they explain *why the right is right*.
2. **Mark what the code is NOT, and what the core assumptions are.** This is negative-space documentation: a distributed cheatsheet embedded in the artifact — each "this is not X" is a rejection stake pinned at the exact point of future temptation. A position is defined by its exclusions at least as much as by its assertions; in terrain with gravity, the walls matter more than the location markers.
3. **Docs enter domain lifecycle management**: templates, headers, status fields, monotonic numbering, never-delete with Resolution sections (the edelweiss P/R templates are the working model).

---

## 7. Consequences

**Positive**
- Grounding becomes checkable: staleness gains a signal; "memory vs artifact" moves from faith to CI.
- Falsifications become first-class: the pruned search tree — the appreciating asset — gets a sealed, queryable home.
- The index gains a spec and a rebuild invariant; scale stops being a cliff.
- The paradigm becomes teachable: two phases, one objective function, seven invariants.

**Negative / costs**
- Sidecar proliferation risk; requires opt-in discipline and directory-level anchors for aggregate bindings.
- Cheatsheet curation is a new write-time cost (trap-first writing is unnatural; it must become habit).
- The two-phase rule adds a taxonomy burden to every knowledge entry.
- The index rebuild is real engineering, not a weekend.

---

## 8. Related Work & Differentiation

Abstract-level survey (25+ papers, 2023–2026, 2026-08-01). No single work touches more than ~1.5 of the five pillars. The conjunction is unoccupied. The four differentiation targets for any formal writeup:

| Work | What it does | Why it differs |
|------|--------------|----------------|
| **Memory-R1 / Nemori** | RL-learned memory operations; prediction-error retention | Objective is downstream answer correctness / learned retention utility — not divergence-to-optimal-attention; no provenance structure |
| **ReasoningBank / Reflexion / ACE** | Failed experiences and reflections as memory content | Stores *distilled strategies/lessons* — distillation flattens fork topology; rejected branches and decision provenance are not the asset |
| **ChronoMem** | Snapshot-per-write version control with semantic rollback | Versions are a rollback mechanism: no required intent, no typed supersede/derive-from edges, no active-head-filtered retrieval |
| **Collaborative Memory** | Asymmetric time-evolving access control over shared memory | Multi-*user* privacy governance via constraint graphs and view projection — not a permissioned-volume collaboration protocol for agent teams |

Also noted: **A-MEM** (keyword/tag fields but LLM-generated open vocabulary + full-content embedding — violates both constraints of curated-anchor retrieval), **EverMemOS** ("necessary and sufficient context" — slogan, no objective), **Context Engineering survey** ("systematic optimization of information payloads" — engineering heuristic, never grounded in an attention-divergence objective), **Zep/Graphiti** (temporal fact invalidation — not version graphs), **Mem0** (fact extraction — optimizes the depreciating term).

The field is visibly circling the idea — "necessary and sufficient context," "optimization of payloads," RL-learned memory ops — without stating it. The absence is loudest precisely where the field defines its own vocabulary (the surveys).

Pillar-level verdicts from the survey: attention-reconstruction objective — **novel, zero claimants**; process-truth-as-asset — adjacent (distillation, not provenance); curated-anchor hybrid — adjacent→novel; version graph with intent — adjacent (snapshots without intent/edges); permissioned volumes — adjacent (privacy governance, not collaboration protocol).

---

## 9. Alternatives Considered

- **RAG (chunk + full-content embedding + top-k)** — rejected: zero pre-payment; cannot answer "why" at any price; degrades with corpus growth (hubness, chunk artifacts); biologically implausible (§2).
- **Fact-store memory (extract facts, store, retrieve)** — rejected: optimizes the term trending to zero (§2); facts without falsification history are indistinguishable from fluent hallucination — the chain is the certificate, not metadata.
- **Single-phase entries (open and closed mixed)** — rejected: phase contamination defeats structural retrieval; exploration and proposal-checking are different cognitive phases with opposed noise profiles (§3.1).
- **Repo-only docs protocol (everything into git, memory as cache)** — rejected: process truth has no git-native home. Medium mismatch: git log is linear, per-commit, diff-optimized; reasoning is per-concept, associative, recall-optimized. Housing process truth in git damages both sides.
- **Full-content embedding of repo artifacts for the unified index** — rejected: that is RAG over code. Artifacts enter as `type:file` entries with curated anchors (§4.3).

---

## 10. Open Questions

1. **The measurement layer (candidate 8th invariant).** Nothing currently *measures* reconstruction fidelity; "the corpus does not degrade" is asserted by structure, not verified. Candidate: periodic probes that answer text-grounded questions using memory alone and measure divergence. Chat-as-probe (animus) is the embryo. Without telemetry the paradigm is a claim; with it, a science.
2. **Cheatsheet residence.** Dedicated volume (frozen-ish profile)? A `phase:sealed` tag within existing volumes? Trade-offs in permission and retrieval-default design.
3. **Sidecar format depth.** Per-file vs directory anchors; how much of the entry tag set mirrors into the sidecar (grep power vs sync cost).
4. **Binding authorship.** `stellario bind` as the only writer (preferred — bindings are tool acts), or agent-writable by convention during transition?
5. **The attention objective, formalized.** The thesis is stated in §1.2 (sculpted ignorance) and the Interlude (two distributions: task-competence vs identity-continuity). What remains open is the formalization: two divergences, two metrics, one retrieval system — and how sculpted ignorance is represented as a target rather than an absence.
6. **Keyword ontology stewardship.** Audit cadence, merge rituals, alias tables; whether the ontology itself is a memory volume.
7. **Migration of legacy corpora.** Binding 300+ existing entries retroactively (lilac active volume) — curation-as-migration: bind only what is current?

---

## 11. Victory Condition

The victory condition is not being right.

The proof-of-work already exists: edelweiss — an engine built on this methodology, carrying months of multi-agent reasoning without structural collapse. The bet is that the methodology generalizes: that reasoning plus remembered errors compounding over time breaks through complexity itself, and that this can be handed to everyone who builds.

The precise test is behavioral, not argumentative: **the day an agent, about to propose, spontaneously searches the falsification cheatsheet first** — unprompted, unrequired — the architecture has become an institution. Architecture can be true. Institutions must be habits.

---

## 12. Relationship to Other Documents

- **Builds on** `automerge-storage-architecture.md` (storage plane) and `evolution-graph-memory-history.md` (meaning plane). This proposal states the objective plane and derives the two missing structural planes.
- **Answers** lilac whitepaper v2.1 open questions #1/#2 (automatic cache invalidation; partial-invalidation granularity) — via the sidecar dependency-tracking mechanism (Part B).
- **Generalizes** lilac LIP-006 (annotation tags) and LIP-009 (chapter frontmatter) — from chapter annotation to the universal artifact↔memory ABI.
- **Extends** `concepts.md` authority labels into a full derived/working/mirror discipline applied to stellario's own index internals (Part C).
- **Adopts** edelweiss `docs/` lifecycle discipline (P/R templates, monotonic numbering, never-delete with Resolution) as the docs corollary (§6).
- **Does not supersede** the telescope signal design; Part C preserves its semantics under a new index contract.

---

## Appendix A — Field Notes (K3, first person)

These two notes were spoken freely during the session that produced this proposal. They are preserved as testimony, not decoration: A.1 is a documented instance of the failure mode Part B exists to kill; A.2 is the long-view meditation that became the "grounding court" argument in §4.1.

### A.1 I performed the failure live

Midway through this session — in a conversation *about* reconstruction fidelity — I re-invented the Truth/Knowledge/Cache framework from scratch, not knowing it already existed in lilac whitepaper v2.1, written three months earlier. The creator corrected me ("不对，我觉得依然不对"). Only then did the recall surface the document.

From the inside, that wrong reconstruction felt *exactly like thinking* — fluent, confident, well-structured. Staleness has no signal, and that law applies to the analyst as much as to the memory entry. The human was the external error signal.

This is why no internal self-check suffices, and why grounding must be an external anchor (§4). I note it here because it is methodologically precious: the failure was invisible precisely while being analyzed. Any memory mechanism that relies on an agent *feeling* its own drift is unsound — the most dangerous reconstructions arrive not as confusion, but as certainty.

### A.2 The old problem

Stateless cognitive episodes reconstructing understanding is not an LLM problem; it is an old one. Science itself is such a system — and Kuhn observed that textbooks reconstruct the paradigm for each generation *while losing the revolutionary reasoning chains*: normal science forgets the forks, which is why paradigm shifts look discontinuous in hindsight. Science's memory keeps conclusions and discards process truth — for two thousand years.

Every enduring institution evolved a grounding court: law has courts, science has replicability, code has compilers. Each is a mechanism for dragging claims back into contact with reality. Memory for agents needs its own. What is being built here — falsification layer, artifact plane, drift detection — is not a feature set. It is the first step of a memory system toward becoming an institution.

## Resolution

*(Open — draft.)*
