/**
 * FR-P1-03 — durable-labeled test doubles.
 *
 * The reference adapters (ReferenceTelemetryAdapter / ReferenceCanaryStore /
 * ReferenceSubmissionStore) default to VOLATILE (in-memory, lost on
 * restart). The PRODUCTION middleware constructor (createFireRaidMiddleware)
 * now rejects volatile evidence stores — a production wiring must survive
 * restarts.
 *
 * Behavior tests that exercise the PRODUCTION admission/claim/taxonomy paths
 * with in-memory stores are NOT testing durability; they are testing request
 * semantics. These subclasses keep the exact reference behavior but declare
 * `durability: "durable"`, asserting the durable-interface contract the
 * production path requires. They stand in for "a host that wires a real
 * durable backend" for behavior-testing purposes — the persistence concern
 * itself is pinned separately by the durability-rejection tests.
 */
import {
  ReferenceTelemetryAdapter,
  ReferenceCanaryStore,
  ReferenceSubmissionStore,
} from "../../../src/host-adapter/reference-adapters.js";

export class DurableTelemetryAdapter extends ReferenceTelemetryAdapter {
  constructor() {
    super();
    this.durability = "durable"; // FR-P1-03: this double represents durable backing
  }
}

export class DurableCanaryStore extends ReferenceCanaryStore {
  constructor() {
    super();
    this.durability = "durable";
  }
}

export class DurableSubmissionStore extends ReferenceSubmissionStore {
  constructor() {
    super();
    this.durability = "durable";
  }
}