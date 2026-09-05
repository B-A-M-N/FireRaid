/**
 * P1-22: compile-tested LOCAL/DEMO example fixture (NOT a production wiring).
 * This file is type-checked as part of the docs/examples gate.
 * Run: tsc --noEmit examples/node-local.ts
 *
 * P1-2: an example must not silently admit everyone — people copy examples.
 * The verifier below is therefore a hard stub: constructing this example
 * without wiring a real verifier THROWS at startup (fail closed), and the
 * placeholder callback makes the failure explicit rather than admitting
 * everyone. Runnable (permissive) examples live in origin-server.mjs under
 * explicit dev-mode flags.
 *
 * P1-4: renamed from `node-production.ts` to `node-local.ts`. It wires the
 * Reference (VOLATILE, in-memory) stores — telemetry, canary, submission —
 * so it is a LOCAL/INTEGRATION wiring, never a production deployment. Under
 * FR-P1-03 (closure 6), the production factory demands EXACT
 * `durability === "durable"` and has NO public volatile opt-out; these
 * stores keep their true "volatile" label and the example routes through
 * `createEvaluationMiddleware` — the validator's internal evaluation path,
 * the sanctioned home of non-durable wiring. A real production host must
 * substitute DURABLE adapters (D1/R2/Postgres/…) over the SAME interface,
 * then use `createFireRaidMiddleware`.
 */

import {
  ReferenceSessionAdapter,
  referenceInject,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
  ReferenceSubmissionStore,
  HostOwnedVerificationAdapter,
} from "../src/host-adapter/index.js";
import { createEvaluationMiddleware } from "../src/eval/evaluation-middleware.js";
import { createOriginServer, closeServer } from "../src/runtime/node.js";
import type { OriginServerOptions } from "../src/runtime/node.js";
import type { MiddlewareDeps } from "../src/host-adapter/middleware.js";
import type { DefenseProfile } from "../src/types/profile.js";
import type { OriginAssessment } from "../src/runtime/node.js";
import type { VerificationInput } from "../src/host-adapter/interface.js";

const PROFILE_SECRET = process.env.FIRERAID_PROFILE_SECRET;
const CSRF_SECRET = process.env.FIRERAID_CSRF_SECRET;

// Secrets come from the environment, never defaults.
if (!PROFILE_SECRET || !CSRF_SECRET) {
  throw new Error(
    "node-local example requires FIRERAID_PROFILE_SECRET and " +
    "FIRERAID_CSRF_SECRET in the environment (a deployment that starts with " +
    "a placeholder secret is worse than one that refuses to start)."
  );
}

/**
 * P1-2: the verification seam is deliberately UNIMPLEMENTED here.
 *
 * Wire your real challenge verification (Turnstile siteverify, hCaptcha,
 * or a signed-token check) into this callback. Returning `true`
 * unconditionally would make the example admit every submission as
 * human-verified — the single most dangerous thing a copied example can
 * do — so this one fails closed until an operator supplies the check.
 */
async function verifyHuman(
  _profile: DefenseProfile,
  _input: VerificationInput
): Promise<boolean> {
  throw new Error(
    "verification not configured: implement verifyHuman() against your " +
    "challenge provider before accepting production traffic"
  );
}

const middlewareDeps = {
  profileKeys: { current: { id: "default", secret: PROFILE_SECRET } },
  version: 1,
  csrfSecret: CSRF_SECRET,
  upstreamRegisterUrl: process.env.FIRERAID_UPSTREAM_REGISTER_URL ?? "http://localhost:5051/api/register",
  routes: {
    applicationPage: "/signup",
    applicationSubmit: "/api/submit",
    telemetry: "/api/events",
    canaryPrefix: "/c/",
  },
  session: new ReferenceSessionAdapter(PROFILE_SECRET),
  render: { inject: referenceInject },
  telemetry: new ReferenceTelemetryAdapter(),
  enforcement: new ReferenceEnforcementAdapter(),
  canaryStore: new ReferenceCanaryStore(),
  // FR-P0-02: one session → one irreversible forward. The reference store is
  // in-memory (volatile — restarts lose claim history); a production host
  // implements HostSubmissionStore over its own DURABLE database.
  submissionStore: new ReferenceSubmissionStore(),
  verification: new HostOwnedVerificationAdapter(verifyHuman),
};

async function main(): Promise<void> {
  // FR-P1-03/P1-4 (closure 6): LOCAL wiring of honestly-volatile reference
  // stores — the EVALUATION constructor's internal validator path permits
  // the explicit "volatile" label; the PRODUCTION factory would reject them
  // (and rejects any durability value that is not exactly "durable"). A
  // production deploy must wire durable adapters and call
  // createFireRaidMiddleware.
  const validatedDeps = createEvaluationMiddleware({
    ...middlewareDeps,
    routes: middlewareDeps.routes,
    // No lab conditions: this is the production SHAPE, just with in-memory
    // (non-durable) stores. Equivalent to a local integration harness.
  });

  const htmlLoader = async (): Promise<string> => {
    return `<!DOCTYPE html><html><body><form id="signup-form"></form></body></html>`;
  };

  // P1-1: createOriginServer CONSTRUCTS the server; the host owns binding.
  // (The old `port` option was dead configuration — accepted, never used.)
  const PORT = Number(process.env.PORT ?? 8443);
  // Evaluation deps are structurally the production shape plus the (empty)
  // eval override surface; the origin server consumes the MiddlewareDeps
  // portion — cast asserts that known-safe subset.
  const options: OriginServerOptions = {
    middlewareDeps: validatedDeps as unknown as MiddlewareDeps,
    htmlLoader,
    routes: middlewareDeps.routes!,
    // P0-6: behind a reverse proxy, pin the public origin so a spoofed
    // Host header cannot influence request URLs.
    publicOrigin: process.env.FIRERAID_PUBLIC_ORIGIN,
    onAssessment: (assessment: OriginAssessment): void => {
      // Host-internal: persist annotation, join to review workflow.
      // P0-5: returning a Promise here makes this hook part of the
      // durability chain — the receipt is not sent until it resolves.
      console.log("Assessment:", assessment.disposition, assessment.score);
    },
  };

  const server = createOriginServer(options);
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`FireRaid origin server listening on port ${PORT}`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await closeServer(server);
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
