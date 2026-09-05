/**
 * P1-22: Compile-tested production example fixture.
 * This file is type-checked as part of the docs/examples gate.
 * Run: tsc --noEmit examples/node-production.ts
 */

import {
  createFireRaidMiddleware,
  ReferenceSessionAdapter,
  referenceInject,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
  HostOwnedVerificationAdapter,
} from "../src/host-adapter/index.js";
import { createOriginServer, closeServer } from "../src/runtime/node.js";
import type { OriginServerOptions } from "../src/runtime/node.js";
import type { MiddlewareDeps } from "../src/host-adapter/middleware.js";
import type { DefenseProfile } from "../src/types/profile.js";
import type { OriginAssessment } from "../src/runtime/node.js";

const PROFILE_SECRET = process.env.FIRERAID_PROFILE_SECRET ?? "dev-secret-do-not-use-in-prod-0123456789abcdef";
const CSRF_SECRET = process.env.FIRERAID_CSRF_SECRET ?? "dev-csrf-secret-do-not-use-in-prod-0123456789abcdef";

const middlewareDeps: MiddlewareDeps = {
  profileKeys: { current: { id: "default", secret: PROFILE_SECRET } },
  version: 1,
  csrfSecret: CSRF_SECRET,
  upstreamRegisterUrl: "http://localhost:5051/api/register",
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
  // P0-3: HostOwnedVerificationAdapter requires an explicit callback
  verification: new HostOwnedVerificationAdapter(async (_profile: DefenseProfile, _input) => {
    // In production, verify the challenge token here (e.g., Turnstile)
    return true;
  }),
};

async function main(): Promise<void> {
  const validatedDeps = createFireRaidMiddleware({
    ...middlewareDeps,
    routes: middlewareDeps.routes,
  });

  const htmlLoader = async (): Promise<string> => {
    return `<!DOCTYPE html><html><body><form id="signup-form"></form></body></html>`;
  };

  const options: OriginServerOptions = {
    middlewareDeps: validatedDeps,
    htmlLoader,
    port: 8443,
    routes: middlewareDeps.routes!,
    onAssessment: (assessment: OriginAssessment): void => {
      // Host-internal: persist annotation, join to review workflow
      console.log("Assessment:", assessment.disposition, assessment.score);
    },
  };

  const server = createOriginServer(options);
  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  console.log(`FireRaid origin server listening on port ${options.port}`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await closeServer(server);
    process.exit(0);
  });
}

main().catch(console.error);
