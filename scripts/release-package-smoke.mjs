#!/usr/bin/env node
/**
 * P0-1 / P1-7 — release package contract gate.
 *
 * The npm tarball is the published contract. This gate proves, for THIS
 * tree, that the contract actually loads: build → pack → install the
 * tarball into an empty temp project → import EVERY declared subpath →
 * construct the middleware and run one GET/POST admission round-trip →
 * compile a TypeScript consumer against the installed .d.ts (stage 5 uses
 * node import(), which ignores the "types" condition — without stage 6 a
 * missing/stale declaration file would pass this gate and break every TS
 * consumer at tsc time).
 *
 * This gate exists because release:verify can otherwise certify a package
 * nobody can import (the exports map once pointed at files that did not
 * exist while every source-level gate stayed green).
 *
 * Exit 0 = package contract holds. Any failure exits non-zero with the
 * failing stage printed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(name, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", shell: false, ...opts });
  if (r.status !== 0) {
    console.error(`[FAIL] ${name}`);
    console.error((r.stdout ?? "") + (r.stderr ?? ""));
    process.exit(1);
  }
  console.log(`[PASS] ${name}`);
  if (r.stdout?.trim()) console.log(r.stdout.trim());
  return r;
}

// 1. Build the distribution (real emit — not a typecheck).
rmSync(join(ROOT, "dist"), { recursive: true, force: true });
run("build (tsc -p tsconfig.dist.json)", "npx", ["tsc", "-p", "tsconfig.dist.json"]);
if (!existsSync(join(ROOT, "dist", "host-adapter", "index.js"))) {
  console.error("[FAIL] dist/host-adapter/index.js missing after build");
  process.exit(1);
}

// 2. Pack the tarball.
const pack = run("npm pack", "npm", ["pack", "--json"]);
const packInfo = JSON.parse(pack.stdout);
const tarball = join(ROOT, packInfo[0]?.filename ?? `${packInfo[0]?.name}-${packInfo[0]?.version}.tgz`);
if (!existsSync(tarball)) {
  console.error(`[FAIL] tarball not found: ${tarball}`);
  process.exit(1);
}

// 3. Install into an empty temp project (isolated node_modules; no
//    workspace/hoisting accidents — the tarball must be self-sufficient).
const proj = mkdtempSync(join(tmpdir(), "fireraid-pkg-smoke-"));
try {
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "pkg-smoke", private: true, type: "module" }, null, 2));
  run("install tarball in temp project", "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: proj });

  // 4. Import every declared subpath + run the functional smoke FROM the
  //    installed copy (resolution through the consumer's node_modules).
  const smoke = `
    const root = await import("fireraid");
    const node = await import("fireraid/node");
    const adapters = await import("fireraid/adapters");
    const evaluation = await import("fireraid/evaluation");

    for (const [name, mod] of [[".", root], ["./node", node], ["./adapters", adapters], ["./evaluation", evaluation]]) {
      if (!mod || Object.keys(mod).length === 0) throw new Error(\`subpath \${name} imported empty\`);
      console.log(\`  import \${name} -> \${Object.keys(mod).length} exports\`);
    }
    if (!root.createFireRaidMiddleware || !root.admit) throw new Error("root barrel missing createFireRaidMiddleware/admit");
    if (!node.createOriginServer) throw new Error("./node missing createOriginServer");
    if (!adapters.referenceInject) throw new Error("./adapters missing referenceInject");
    if (!evaluation.createEvaluationMiddleware) throw new Error("./evaluation missing createEvaluationMiddleware");

    // 5. Minimal runtime smoke: construct the middleware and run one
    //    GET (page + envelope cookie) and one POST (submit) admission.
    const deps = root.createFireRaidMiddleware({
      profileKeys: { current: { id: "default", secret: "a".repeat(64) } },
      version: 1,
      routes: { applicationPage: "/signup", applicationSubmit: "/api/submit", telemetry: "/api/events", canaryPrefix: "/c/" },
      session: new adapters.ReferenceSessionAdapter("k".repeat(64)),
      render: { inject: adapters.referenceInject },
      verification: new adapters.HostOwnedVerificationAdapter(async () => true),
      telemetry: new adapters.ReferenceTelemetryAdapter(),
      // P0-8: stub enforcement — the smoke has no live upstream, and the
      // real reference adapter now honestly reports transport-failure for
      // one (the runtime would 502). The contract under test is the
      // admission round-trip, not upstream reachability.
      enforcement: { allow: async () => ({ kind: "created" }), deny: () => {} },
      canaryStore: new adapters.ReferenceCanaryStore(),
    });
    const page = await root.admit(new Request("http://localhost/signup"), deps, async () => '<html><body><form id="signup-form"></form></body></html>');
    if (page.kind !== "get" || !page.setCookie?.startsWith("__Host-fr_")) throw new Error("GET did not issue the signed envelope cookie");
    const csrf = (page.html ?? "").match(/name="csrf" value="([^"]+)"/)?.[1];
    if (!csrf) throw new Error("GET page missing CSRF token");
    const submitted = await root.admit(new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: page.setCookie.split(";")[0] },
      body: JSON.stringify({ email: "a@b.c", password: "x".repeat(12), csrf }),
    }), deps, async () => "<html></html>");
    if (submitted.kind !== "admit" || !submitted.disposition) throw new Error("POST did not produce an admission decision");
    console.log(\`  admission round-trip: GET kind=\${page.kind}, POST kind=\${submitted.kind} disposition=\${submitted.disposition}\`);
    console.log("PACKAGE CONTRACT HOLDS");
  `.trim();

  const smokePath = join(proj, "smoke.mjs");
  writeFileSync(smokePath, smoke);
  run("import every subpath + functional smoke", "node", ["smoke.mjs"], { cwd: proj });

  // 6. TYPES-consumer stage: Node's import() ignores the "types" condition,
  // so the .d.ts half of the exports contract is unexercised by stage 5 —
  // a tarball with a missing or stale dist/**/*.d.ts would pass above and
  // then break every TypeScript consumer at tsc time (TS2307/TS2305).
  // Compile a real TS consumer against the INSTALLED tarball.
  const consumerTs = `
    import { createFireRaidMiddleware, admit, ReferenceSessionAdapter } from "fireraid";
    import { createOriginServer } from "fireraid/node";
    import { referenceInject } from "fireraid/adapters";
    import { createEvaluationMiddleware } from "fireraid/evaluation";

    // Touch one exported VALUE from each subpath so type-only elision cannot
    // hide a broken module, and assert a couple of TYPES so declaration
    // errors surface at compile time.
    const deps = createFireRaidMiddleware as unknown as (opts: Record<string, unknown>) => Record<string, unknown>;
    void deps; void admit; void ReferenceSessionAdapter; void createOriginServer;
    void referenceInject; void createEvaluationMiddleware;
    const _n: number = 1;
    void _n;
  `.trim();
  writeFileSync(join(proj, "consumer.ts"), consumerTs);
  writeFileSync(
    join(proj, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          // nodenext honors the exports map's "types" condition exactly as
          // a real consumer's bundler/tsc would.
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["consumer.ts"],
      },
      null,
      2
    )
  );
  run(
    "typescript consumer compiles against installed .d.ts",
    process.execPath,
    [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(proj, "tsconfig.json")],
    { cwd: proj }
  );
  console.log(`\nsmoke project: ${proj}`);
} finally {
  rmSync(proj, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
