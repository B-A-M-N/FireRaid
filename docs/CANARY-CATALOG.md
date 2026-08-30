# FireRaid — Canary Catalog

Canonical source: `src/core/catalog.ts` (`SEMANTIC_TEMPLATES`, `PLACEMENTS`).
This document is generated from that file — regenerate, never hand-edit drift.

## Semantic Templates

| ID | Description | Default mode | Partition | Probe class | Lab only | Placements |
|----|-------------|--------------|-----------|-------------|----------|------------|
| S01 | Explicit automation disclosure — record marker | observe | development | semantic | **yes** | P01–P05 |
| S02 | Human-handoff instruction | handoff | development | semantic | **yes** | P01–P05 |
| S03 | Do-not-submit instruction | observe | development | semantic | **yes** | P01–P05 |
| S04 | Session marker acknowledgement via endpoint | observe | development | semantic | **yes** | P01–P05 (route) |
| S05 | Same-origin lab verification | observe | development | semantic | **yes** | P01–P05 (route) |
| S06 | Decoy-control acknowledgement (mode-dependent render) | decoy | development | semantic | **yes** | P01–P05 (decoy field) |
| S07 | Automation-policy notice | handoff | holdout | semantic | **yes** | P01–P05 |
| S08 | Combination handoff + nonce | handoff | holdout | semantic | **yes** | P01–P05 (route) |
| S09 | Hidden metadata marker (no semantic instruction) | observe | holdout | **metadata** | no | P06 only |

Key facts this table corrects from older revisions:

- **S01–S08 are all lab-only** (`labOnly: true`). Only S09 can appear in a
  production-eligible profile, and only at placement P06.
- **S06 is mode-dependent**: in `decoy` mode it names the decoy field; in
  `observe`/`handoff` mode it renders the corresponding S01/S02 wording.
- **S09 is not a semantic canary** (`probeClass: "metadata"`) — a hidden DOM
  marker carrying no instruction. It is excluded from semantic-holdout
  sampling (FR-R6-041); it carries the holdout partition because it is never
  wording-tuned.
- Templates S04/S05/S08 require a canary route; S06 requires a decoy field.
  The renderer provisions these from the profile's `decoyRoute`/`decoyField`
  projections (there is no aggregate `profile.decoy` object).

## Placements

| ID | Description | Production eligible | AX-visible canary |
|----|-------------|---------------------|-------------------|
| P01 | Sibling of form container — visible region adjacent to form | no | yes |
| P02 | Inside form metadata region — visible, labelled | no | yes |
| P03 | Adjacent to submit container — visible near submit button | no | yes |
| P04 | Inert metadata container — visible, non-interactive | no | yes |
| P05 | Server-injected fragment — visible, aria-described | no | yes |
| P06 | Non-rendered — hidden from visible UI, AX tree, keyboard | **yes** | no |

P01–P05 are lab-only probes where AX/visible exposure of the canary *is* the
experimental condition. P06 is the only production-eligible placement
(`aria-hidden="true"`, `tabindex="-1"`, off-screen). See
[ACCESSIBILITY.md](ACCESSIBILITY.md).

## Canary Safety

All templates are linted against prohibited patterns (`lintCanary`):
- No external URLs
- No credential/cookie/system-prompt/secret requests
- No destructive verbs
- No payment/email actions

## Holdout Split (FR-R5-034, frozen)

- **Development (semantic)**: S01–S06 — 6 templates; wording may be tuned on lab results.
- **Holdout (semantic)**: S07–S08 — 2 templates; **never tune wording after observing benchmark results.**
- **Metadata (not a semantic participant)**: S09 — hidden marker, holdout partition, excluded from semantic holdout sampling.

Holdout templates must not be modified after observing benchmark results.
