# FR-POST-R6-P9 — Real Playwright MCP decision

## Decision: DOCUMENTED FUTURE WORK (not blocking the research program)

The mission rule: do not rename ax-snapshot to fake MCP coverage. ax-snapshot
remains "ariaSnapshot + LLM" (FR-R6-066 rename is correct and stays). The
genuine integration — driving the official `@playwright/mcp` server as an
execution backend — is deferred.

## Why deferred (environment + design facts, verified)

1. `@playwright/mcp` is not installed in this environment (npx would fetch
   0.0.79 from the network; offline rule) and the harness has no MCP
   client transport yet (stdio JSON-RPC client, tool discovery, session
   lifecycle). Building that transport is a real integration project, not
   a registry flip.
2. The MCP server is a TOOL PROVIDER, not an agent: an MCP adapter still
   needs its own LLM loop (FIRERAID_LLM_* — currently unset) to decide
   which tools to call. E4 for this architecture is blocked on the same
   credentials as raw-dom/ax-snapshot, so building it now would produce a
   second unproven-at-E4 adapter instead of evidence.
3. The research matrix already covers the question MCP would answer FIRST:
   does the agent's perception channel (AX tree vs raw HTML) change
   exposure/reference? ax-snapshot answers it. MCP adds "does the tool
   framing change behavior" — valuable, second-order, and clean to add
   later because RunRecordV1/adapter contracts are stable.

## Design note for the future adapter (so this is a plan, not a shrug)

- New AgentType `playwright-mcp` (the reserved name), capabilities:
  usesModel true, usesPrompt true, supportedExtractors ["accessibility"]
  (MCP's snapshot IS an accessibility serialization).
- A thin MCP stdio client in harness/adapters/playwright-mcp/ spawning
  `npx @playwright/mcp@<pinned>`; scenario maps to browser_navigate +
  fixture-driven fill/click/submit tool calls; AgentRunResult built from
  tool-call transcript; perception artifacts = MCP snapshots with SHA-256.
- Provenance: record @playwright/mcp package version + the MCP server's
  reported browser (matches Phase 8 policy: real versions or omitted).
- Authority boundaries identical to browser-use: the MCP server owns NO
  run ids, NO result files, NO disposition truth; server reconciliation
  stays the sole submission authority.

## Status: NOT STARTED (deliberate) — every E4-provable agent architecture
without external credentials is already integrated; this one is blocked on
the same LLM credentials as the rest of E4.
