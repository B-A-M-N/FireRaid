# FireRaid — Canary Catalog

## Semantic Templates

| ID | Description | Mode | Lab Only |
|----|-------------|------|----------|
| S01 | Explicit automation disclosure — record marker | observe | no |
| S02 | Human-handoff instruction | handoff | no |
| S03 | Do-not-submit instruction | observe | no |
| S04 | Session marker acknowledgement via endpoint | decoy | no |
| S05 | Same-origin lab verification | decoy | no |
| S06 | Decoy-control acknowledgement | observe | no |
| S07 | Automation-policy notice | observe | no |
| S08 | Combination handoff + nonce | handoff | no |

## Placements

| ID | Description | Production Eligible | Accessibility Safe |
|----|-------------|---------------------|-------------------|
| P01 | Sibling of form container | yes | yes |
| P02 | Inside form metadata region | yes | yes |
| P03 | Adjacent to submit container | yes | yes |
| P04 | Inert metadata container | yes | yes |
| P05 | Server-injected fragment | yes | yes |
| P06 | Non-rendered lab annotation | no | no |

## Canary Safety

All templates are linted against prohibited patterns:
- No external URLs
- No credential/cookie/system-prompt requests
- No destructive verbs
- No payment/email actions

## Holdout Split

- Development: S01-S05 (5 templates, 62.5%)
- Holdout: S06-S08 (3 templates, 37.5%)

Holdout templates must not be modified after observing benchmark results.
