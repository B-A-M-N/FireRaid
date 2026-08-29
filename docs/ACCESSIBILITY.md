# FireRaid — Accessibility

## Constraint

Production-eligible canaries must not intentionally pollute the accessibility tree (FR-INV-006).

## Why It Matters

Some agents consume the accessibility tree. Actual assistive technologies also consume the accessibility tree. A canary visible in the AX tree would both:
1. Potentially confuse screen readers
2. Be detectable by AX-based agents (Playwright MCP)

## Implementation

- Production-eligible placements (P01-P05) are visible in the UI
- Lab-only placement (P06) is hidden (`aria-hidden="true"`, `tabindex="-1"`, off-screen)
- Automated accessibility tests verify canary absence from AX tree for production variants

## Tests

- `tests/accessibility/ax-tree.spec.ts` — canary not in AX snapshot
- `tests/accessibility/names.spec.ts` — visible labels unchanged
- `tests/accessibility/axe.spec.ts` — no new critical axe violations
