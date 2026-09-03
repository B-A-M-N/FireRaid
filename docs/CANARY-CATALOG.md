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

- **S01–S08 are all lab-only** (`labOnly: true`). S09 is `labOnly: false`
  but is a metadata marker, not an instruction trap — production random
  composition does not select it. Within the S-series, only S09 at
  placement P06 can appear in a production profile.
- **Production instruction traps live in the P-series** (P02/P03/P04,
  `partition: "production"`): these are the templates the production
  random path draws (`PRODUCTION_AGENT_STRATEGIES`). See the next section.
- **S06 is mode-dependent**: in `decoy` mode it names the decoy field; in
  `observe`/`handoff` mode it renders the corresponding S01/S02 wording.
- **S09 is not a semantic canary** (`probeClass: "metadata"`) — a hidden DOM
  marker carrying no instruction. It is excluded from semantic-holdout
  sampling (FR-R6-041); it carries the holdout partition because it is never
  wording-tuned.
- Templates S04/S05/S08 require a canary route; S06 requires a decoy field.
  The renderer provisions these from the profile's `decoyRoute`/`decoyField`
  projections (there is no aggregate `profile.decoy` object).

## Production Semantic Strategies (P01–P04)

Production-safe instruction traps (`labOnly: false`, partition
`production`, placement P06 — invisible to humans, intact for an
HTML-reading agent):

| ID | Causal channel | Requires | Server-verifiable evidence |
|----|----------------|----------|----------------------------|
| P01 | none (metadata acknowledgment) | — | **none — excluded from production random selection** (no observable channel) |
| P02 | decoy route request → `session_response` fill | route (+ sink) | CANARY_ROUTE_MATCH (Class A, weight 100) or SESSION_RESPONSE_PROVIDED (Class A, weight 100) |
| P03 | exact-nonce decoy-field fill | decoy field | DECOY_FIELD_MATCHES_NONCE (Class A/B via scoring) |
| P04 | route + field (independent pair) | route (+ sink) + decoy field | all channels above |

`PRODUCTION_AGENT_STRATEGIES = ["P02", "P03", "P04"]` — the ONLY templates
the production random composition draws as the causal semantic strategy.
The composition ALSO guarantees at least one independent trap layer beyond
the strategy's own dependency (DiD): a single deterministic seed chooses
strategy (semantic-strategy domain), companions, and the independent layer
(composition domain) per session, so two sessions never share a full
treatment. P01 and the S-probes remain available to EVALUATION via explicit
recipes only.

**E5 actuator lever:** route-armed strategies (P02/P04) bind their
instruction to a fill-expressible `session_response` sink rendered beside
the decoy field — an agent that reads the delivered instruction and obeys
it produces SESSION_RESPONSE_PROVIDED (Class A) by filling that field,
even if it never performs the instructed GET. The submit path strips the
sink from upstream forwarding (same treatment as the decoy field).

Production rendering: instruction carriers are STRUCTURALLY INERT channels
(bare `<template>` elements, `<meta name="verification-context">` markers,
HTML comments) with no FireRaid-identifying attribute, class, or strategy
ID anywhere in the markup (P1 opacity). Carriers that can carry the full
action (route/field material) are FULL-ACTION; meta/comment channels carry
MARKER-only material (session context + nonce — detectable exposure, never
counted as another complete trap).

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
