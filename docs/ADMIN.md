# FireRaid — Admin Dashboard

A lightweight admin interface for inspecting sessions, experiments, and evidence.

## Views

1. **Summary** — aggregate metrics (runs, quarantine rate, causal hits, FP rate)
2. **Sessions** — list all sessions with disposition
3. **Session Inspector** — single session: profile, defense variants, event sequence, evidence, decision
4. **Experiments** — list experiments
5. **Experiment View** — single experiment: runs, metrics, export

## Access Control

Admin routes are protected by `ADMIN_SECRET`. Never expose secrets in the UI.

## Implementation

Vanilla HTML/CSS/TypeScript — no framework needed.
