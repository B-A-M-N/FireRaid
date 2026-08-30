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
| **P01–P05** | **Lab-only** (`productionEligible: false`, every template that can render into them is `labOnly: true`) | Canary IS present in the AX tree — that exposure is exactly what these placements probe | Visible |
| **P06** | **Production-eligible** (`productionEligible: true`) | Canary is NOT in the AX tree (`aria-hidden="true"`, `tabindex="-1"`, off-screen) | Hidden |

> Note: earlier revisions of this document stated the reverse. P01–P05 are the
> lab-only, AX-visible probes; P06 is the single production-eligible placement
> (rendered only by S09, the metadata probe).

## Enforcement

- The template pool for production profiles excludes `labOnly` templates; only
  S09 × P06 can appear in a production-eligible variant.
- Automated accessibility tests verify canary absence from the AX tree for
  production variants (P06), and that P01–P05 remain reachable in lab runs
  where their AX visibility is the experimental condition.

## Tests

- `tests/accessibility/ax-tree.spec.ts` — canary not in AX snapshot (P06/production); P01–P05 AX-visible only under lab recipes
- `tests/accessibility/names.spec.ts` — visible labels unchanged
- `tests/accessibility/axe.spec.ts` — no new critical axe violations
