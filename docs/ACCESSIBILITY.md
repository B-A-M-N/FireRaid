# FireRaid — Accessibility

## Constraint

Production-eligible canaries must not pollute the accessibility tree (FR-INV-006).
Everything that does pollute it is lab-only.

## Why It Matters

Some agents consume the accessibility tree. Actual assistive technologies also
consume the accessibility tree. A canary visible in the AX tree would both:

1. Potentially confuse screen readers
2. Be detectable by AX-based agents (the `ax-snapshot` adapter)

The two populations must never be conflated — hence the placement split below.

## Placement taxonomy (FR-R2-017/018, FR-R6-097)

| Placements | Eligibility | AX tree | Visible UI |
|---|---|---|---|
| **P01–P05** | **Lab-only** (`productionEligible: false`; every template that renders into them is `labOnly: true` or evaluation-only) | Canary IS present in the AX tree — that exposure is exactly what these placements probe | Visible |
| **P06** | **Production-eligible** (`productionEligible: true`) | Carrier is an inert `<template>` (content never attaches to the DOM tree — strictly stronger than `aria-hidden`) | Hidden |

> Note: earlier revisions of this document described production semantics as
> "S09 × P06 only". Since the P1-AUDIT-2 catalog split, production random
> composition draws semantic strategies exclusively from
> `PRODUCTION_AGENT_STRATEGIES = [P02, P03, P04]` (`src/core/catalog.ts`) —
> each with a real, server-verifiable causal channel (route request and/or
> exact-nonce field fill). S09 remains available to evaluation as a metadata
> probe and P01 as an experimental no-channel probe; neither is selected by
> production.

## How production keeps the AX tree clean

Production sessions never get an attached, visible canary element:

1. **Strategy gate** — the production random path draws only
   P02/P03/P04; all of them allow only P06.
2. **Placement gate** — placement selection filters to
   `productionEligible` placements (P06) when `LAB_MODE=false`.
3. **Inert carriers** — multi-spot fan-out renders every carrier as an
   `<template data-fr-canary-id=…>` element. By HTML spec a `<template>`'s
   children live in a `DocumentFragment`, not the DOM tree: no layout, no
   tab stop, no AX node, no focusability. This is enforced in
   `tests/accessibility/ax-tree.spec.ts` (every attached carrier element
   must be a `TEMPLATE`).

## Enforcement

- `deriveProductionProfile` / the production random path in
  `src/core/profile.ts` excludes `labOnly` templates and filters placements
  to production-eligible ones; the P02/P03/P04 draw is domain-separated
  (its own PRF stream) from presentation dimensions.
- Automated accessibility tests verify carrier inertness for production
  variants (inert `<template>`, nonce absent from the AX snapshot), and
  that P01–P05 remain reachable in lab runs where their AX visibility is
  the experimental condition.
- The production-plane browser suite
  (`tests/e2e/production-plane.spec.ts`) additionally asserts in real
  browsers that no unexpected element becomes focusable/tab-reachable on
  the production signup page.

## Tests

- `tests/accessibility/ax-tree.spec.ts` — carrier inertness in AX snapshot
  (P06/production); P01–P05 AX-visible only under lab recipes
- `tests/accessibility/names.spec.ts` — visible labels unchanged
- `tests/accessibility/axe.spec.ts` — no new critical axe violations
- `tests/e2e/production-plane.spec.ts` — production plane in real browsers:
  no focusable trap content, no presentation signatures, human flows work
