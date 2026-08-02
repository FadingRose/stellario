# Binding cases — where a block goes, what it claims

Two rules govern: **embed only receives inheritance; cascade only gives**
(union-only, children add but never remove). Position is convention; the
`binding` field is authoritative; lint warns on mismatch.

| # | Case | Placement | Binds to | Span | Inheritance |
|---|---|---|---|---|---|
| B1 | section annotation (embed) | end of section, after prose | preceding prose | section subtree | receives |
| B2 | code-item annotation (embed) | end of `///` doc comment | that doc prose | the attached item | receives |
| B3 | file-level declaration (cascade) | top of file, under first heading, before prose | the whole file | file (coarse lock) | gives |
| B4 | mid-level declaration (cascade) | under `##`, before prose, with `###` children | the section subtree | subtree | gives to children, receives from B3 |
| B5 | chained annotations (embed) | prose-block-prose-block in one section | each own prose chunk | its code | receives |
| B6 | degenerate embed (no prose above) | directly under heading | heading title only | — | lint warning: add prose or switch to cascade |
| B7 | standalone mini-entry (no headings) | after a single `//` line | that line | following code chunk | receives |

Description extraction: embed = the direct prose above the block; cascade
= the direct prose below it. Child headings never merge into a parent's
description.

Nesting: cascades can nest (B3∘B4); an embed never gives.
