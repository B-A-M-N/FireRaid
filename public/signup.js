/**
 * FireRaid client telemetry + form submission.
 * Buffers coarse interaction events, flushes before submit.
 * FIX: Now properly prevents default form submission and posts JSON.
 * FIX: Final telemetry events are included in the submit request (FR-R2-008).
 * FR-R6-036: the server-generated capture mask (client config JSON block)
 *   gates EVERY listener — a profile with capturePointer=false captures no
 *   pointer events client-side; randomized telemetry conditions are real.
 *   Fail-safe default when the config is absent/invalid: capture only submit.
 * FR-R6-037: retry-safe outbox — events leave the queue only after the
 *   submit/events request is ACKNOWLEDGED. On verification_required or
 *   network failure, in-flight events return to the FRONT of the queue in
 *   original order. Turnstile resets for a fresh token on retry.
 * FR-R7-014: when interactionScoring is OFF, the client creates NO outbox,
 *   NEVER pushes page_ready, NEVER schedules a periodic flush, and NEVER
 *   calls the telemetry endpoint from the page. A profile that does not
 *   score interaction does not need the telemetry stream at all.
 * FR-R7-015: the outbox represents UNSENT events only — the redundant
 *   keep-alive flush is removed; events leave the queue exactly when the
 *   server's acceptedThrough confirms receipt (or before submit, or on
 *   pagehide).
 * FR-R7-016: 409 is no longer treated as "drop everything"; the server
 *   returns the current watermark (acceptedThrough) so the client trims
 *   only the prefix the server actually has.
 *
 * P0-AUDIT (client opacity): the client NEVER fabricates server state.
 *   The production server deliberately sends no disposition on a received
 *   submission — the client renders "Submission received." and nothing
 *   else. Displaying an internal disposition requires the served client
 *   config to explicitly mark the page an evaluation surface
 *   (evaluationMode:true); it is never inferred from a missing field.
 *
 * P0-AUDIT (client routing): the client's ENTIRE routing comes from the
 *   server-generated config — form selector, submit endpoint, telemetry
 *   endpoint. No path or selector literals live in this file; a host that
 *   remounts the middleware at different routes needs no client change.
 */
(function () {
  "use strict";

  // ── FR-R6-036: server-generated capture mask + routing ───────────────────
  const DEFAULT_CONFIG = {
    telemetry: {
      captureFocus: false,
      captureInput: false,
      captureChange: false,
      capturePointer: false,
      captureKey: false,
      captureSubmit: true, // submit tracking is core UX, not a treatment
    },
    interactionScoring: false,
    // FR-P0-5: defaults mirror the server schema; the rendered config is
    // authoritative when present.
    limits: { maxEventsPerBatch: 256, maxBatchBytes: 16 * 1024 },
    // P0-AUDIT: client routing — fail-safe defaults mirror the reference
    // middleware's canonical route table.
    endpoints: {
      formSelector: "#signup-form",
      submit: "/api/submit",
      telemetry: "/api/events",
    },
    // P0-AUDIT: evaluation surfaces declare themselves. Absent ⇒ production
    // (opaque receipts; the disposition is never rendered).
    evaluationMode: false,
  };

  function readClientConfig() {
    try {
      // The config island id is emitted by the shared renderer — one id per
      // mode (app-runtime-config in production, fr-client-config on
      // evaluation surfaces). Reading both is presentation-tolerance, not
      // mode inference: the MODE still comes only from the parsed config.
      const el =
        document.getElementById("app-runtime-config") ||
        document.getElementById("fr-client-config");
      if (!el) return DEFAULT_CONFIG;
      const parsed = JSON.parse(el.textContent);
      const t = parsed && typeof parsed === "object" ? parsed.telemetry : null;
      if (!t || typeof t !== "object") return DEFAULT_CONFIG;
      const bool = (v) => typeof v === "boolean" ? v : false;
      // FR-P0-5: server-derived batch limits — count AND byte caps travel
      // with the config so the client can never drift from the server schema.
      const limits = parsed.limits && typeof parsed.limits === "object" ? parsed.limits : {};
      const limitsOut = {
        maxEventsPerBatch:
          typeof limits.maxEventsPerBatch === "number" && limits.maxEventsPerBatch > 0
            ? Math.floor(limits.maxEventsPerBatch)
            : 256,
        maxBatchBytes:
          typeof limits.maxBatchBytes === "number" && limits.maxBatchBytes > 0
            ? Math.floor(limits.maxBatchBytes)
            : 16 * 1024,
      };
      // P0-AUDIT: routing — every endpoint from the server, shape-checked;
      // any malformed entry falls back to the canonical route default
      // (never a partial mix of invented paths).
      const endpoints = parsed.endpoints && typeof parsed.endpoints === "object" ? parsed.endpoints : {};
      const routeOf = (v, fallback) =>
        typeof v === "string" && v.length > 0 ? v : fallback;
      const endpointsOut = {
        formSelector: routeOf(endpoints.formSelector, DEFAULT_CONFIG.endpoints.formSelector),
        submit: routeOf(endpoints.submit, DEFAULT_CONFIG.endpoints.submit),
        telemetry: routeOf(endpoints.telemetry, DEFAULT_CONFIG.endpoints.telemetry),
      };
      return {
        telemetry: {
          captureFocus: bool(t.captureFocus),
          captureInput: bool(t.captureInput),
          captureChange: bool(t.captureChange),
          capturePointer: bool(t.capturePointer),
          captureKey: bool(t.captureKey),
          captureSubmit: typeof t.captureSubmit === "boolean" ? t.captureSubmit : true,
        },
        interactionScoring: bool(parsed.interactionScoring),
        limits: limitsOut,
        endpoints: endpointsOut,
        // Explicit declaration ONLY — a missing field is production.
        evaluationMode: parsed.evaluationMode === true,
      };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  const CONFIG = readClientConfig();
  const MASK = { telemetry: CONFIG.telemetry, interactionScoring: CONFIG.interactionScoring, limits: CONFIG.limits };

  // P0-AUDIT: routing — ALL of it from the config. No literals below.
  const form = document.querySelector(CONFIG.endpoints.formSelector);
  if (!form) return;
  const SUBMIT_ENDPOINT = CONFIG.endpoints.submit;
  const TELEMETRY_ENDPOINT = CONFIG.endpoints.telemetry;

  let turnstileToken = null;
  let submitInFlight = false;

  // ── Shared helpers used by both branches below ─────────────────────────
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderResult(result) {
    const existing = document.getElementById("fr-result");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "fr-result";
    div.className = "fr-result";
    if (result.error) {
      div.innerHTML = `<p class="fr-result-error">${escapeHtml(result.error)}</p>`;
    } else if (result.status === "received") {
      // P0-AUDIT (client opacity): production renders the neutral receipt
      // ONLY — the server sends no disposition, and the client must not
      // invent one ("REVIEW" was exactly such a fabrication, and an oracle
      // an aware agent could read). An internal disposition is shown ONLY
      // on a surface the server explicitly declared an evaluation surface.
      if (CONFIG.evaluationMode && typeof result.disposition === "string") {
        div.innerHTML = `
          <p class="fr-result-status">Submission received.</p>
          <p class="fr-result-disposition">Status: ${escapeHtml(result.disposition)}</p>
        `;
      } else {
        div.innerHTML = `<p class="fr-result-status">Submission received.</p>`;
      }
    }
    form.after(div);
  }

  function renderVerificationRequired(result) {
    const existing = document.getElementById("fr-result");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "fr-result";
    div.className = "fr-result";
    const message = result.message || "Verification required. Please complete the challenge and retry.";
    div.innerHTML =
      `<p class="fr-result-status">${escapeHtml(message)}</p>` +
      `<button type="button" id="fr-retry-btn" class="fr-retry">Retry submission</button>`;
    form.after(div);
    document.getElementById("fr-retry-btn")?.addEventListener("click", () => {
      div.remove();
      form.requestSubmit();
    });
  }

  function resetTurnstile() {
    turnstileToken = null;
    try {
      if (window.turnstile && typeof window.turnstile.reset === "function") {
        window.turnstile.reset();
      }
    } catch {
      // Widget may not exist (Turnstile-disabled environments)
    }
  }

  // ── FR-R7-014: telemetry OFF branch — no outbox, no listeners, no flush.
  if (!CONFIG.interactionScoring) {
    // Turnstile callbacks still needed so the form actually works; they
    // just don't push telemetry.
    window.turnstileOnSuccess = function (token) { turnstileToken = token; };
    window.turnstileOnError = function () {};
    window.turnstileOnExpired = function () { turnstileToken = null; };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitInFlight) return;
      submitInFlight = true;
      try {
        const formData = new FormData(form);
        const formObj = {};
        formData.forEach((value, key) => {
          if (key !== "csrf") formObj[key] = value;
        });
        const csrfToken = form.querySelector('[name="csrf"]')?.value || "";
        const resp = await fetch(SUBMIT_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            csrf: csrfToken,
            turnstileToken,
            form: formObj,
            eventBatch: [],
          }),
        });
        const result = await resp.json();
        if (resp.ok && result.status === "received") {
          renderResult(result);
        } else if (resp.status === 403 && result.status === "verification_required") {
          resetTurnstile();
          renderVerificationRequired(result);
        } else {
          renderResult(result);
        }
      } catch {
        renderResult({ error: "Submission failed. Please try again." });
      } finally {
        submitInFlight = false;
      }
    });
    return;
  }

  // ── Interaction-scoring ON: outbox, listeners, drain on submit / pagehide.
  const events = [];
  let seq = 0;
  const startTime = Date.now();
  // FR-R6-037 + FR-R7-016: last seq the server has acknowledged; used as a
  // debug-visible metric only — the queue itself is the source of truth
  // (and trimAcknowledgedPrefix keeps it minimal).
  let acknowledgedSeq = 0;

  function push(kind, target, meta) {
    events.push({ seq: ++seq, dt: Date.now() - startTime, kind, target, meta });
  }

  /**
   * FR-P0-5: batch-splitting honors BOTH server limits — count
   * (maxEventsPerBatch) and encoded JSON byte size (maxBatchBytes). A batch
   * over the byte cap is 413'd wholesale, so the client must never build one.
   */
  function batchFits(batch) {
    if (batch.length > CONFIG.limits.maxEventsPerBatch) return false;
    try {
      return new TextEncoder().encode(JSON.stringify({ events: batch })).length <= CONFIG.limits.maxBatchBytes;
    } catch {
      return false;
    }
  }

  /**
   * FR-P0-5: take the next sendable batch off the FRONT of the queue. If the
   * first maxEventsPerBatch events exceed the byte cap, keep halving until a
   * sendable prefix is found (a single oversize event is dropped — it cannot
   * ever fit, and its absence degrades one observation, not the stream).
   */
  function takeBatch() {
    if (events.length === 0) return null;
    let size = Math.min(events.length, CONFIG.limits.maxEventsPerBatch);
    while (size > 1) {
      const candidate = events.slice(0, size);
      if (batchFits(candidate)) return candidate;
      size = Math.floor(size / 2);
    }
    // Single event still too big? Drop it (cannot ever fit) and continue.
    const dropped = events.shift();
    try {
      console.warn("fireraid: dropped oversize telemetry event", dropped && dropped.seq);
    } catch { /* console may not exist in odd contexts */ }
    return events.length > 0 ? takeBatch() : null;
  }

  /**
   * FR-R7-015 / 016 + FR-P0-2: send one batch and return ONLY what the
   * server actually acknowledged. The client NEVER manufactures an ACK from
   * the submitted batch — if the server does not name acceptedThrough, the
   * queue keeps everything and retries later.
   *   - 200 + acceptedThrough  → server stored through that seq
   *   - 409 + acceptedThrough  → concurrent/conflicting write; trim to the
   *                              authoritative watermark and retry the rest
   *   - anything else          → null (leave the queue untouched)
   */
  async function tryAcknowledge(batch) {
    try {
      const resp = await fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      });
      if (resp.ok || resp.status === 409) {
        const body = await resp.json().catch(() => null);
        if (body && typeof body.acceptedThrough === "number") {
          return body.acceptedThrough;
        }
        // No authoritative ACK → treat as failure; the queue stays intact.
        return null;
      }
      return null;
    } catch {
      return null;
    }
  }

  function trimAcknowledgedPrefix(throughSeq) {
    while (events.length > 0 && events[0].seq <= throughSeq) {
      events.shift();
    }
    acknowledgedSeq = Math.max(acknowledgedSeq, throughSeq);
  }

  /**
   * FR-R7-015 / FR-P0-4/5: drain the outbox through the telemetry endpoint.
   * Each iteration takes a sendable batch off the queue FRONT (splice
   * semantics: nothing is duplicated), sends it, and trims by the server's
   * ACK. Failure leaves the remaining queue intact for the next drain.
   */
  async function drainToBatches() {
    while (events.length > 0) {
      const batch = takeBatch();
      if (!batch) break;
      const acked = await tryAcknowledge(batch);
      if (acked === null) break; // network/server failure — retry later
      trimAcknowledgedPrefix(acked);
    }
  }

  // Page ready (the first event in every telemetry-on session).
  push("page_ready");

  // Form events — FR-R6-036: each listener gated by its mask flag.
  const fields = form.querySelectorAll("input, textarea, select");
  fields.forEach((el) => {
    if (CONFIG.telemetry.captureFocus) {
      el.addEventListener("focus", () => push("focus", el.name || el.id));
    }
    if (CONFIG.telemetry.captureFocus) {
      el.addEventListener("blur", () => push("blur", el.name || el.id));
    }
    if (CONFIG.telemetry.captureInput) {
      el.addEventListener("input", () => push("input", el.name || el.id, { inputType: el.type }));
    }
    if (CONFIG.telemetry.captureChange) {
      el.addEventListener("change", () => push("change", el.name || el.id, { inputType: el.type }));
    }
  });

  // Pointer / key — FR-R6-036: gated.
  if (CONFIG.telemetry.capturePointer) {
    document.addEventListener("pointerdown", (e) => {
      push("pointer", e.target.name || e.target.id || e.target.tagName);
    });
  }
  if (CONFIG.telemetry.captureKey) {
    document.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      push("key", e.target.name || e.target.id || e.target.tagName);
    });
  }

  // Turnstile callbacks.
  window.turnstileOnSuccess = function (token) {
    turnstileToken = token;
    push("turnstile_success");
  };
  window.turnstileOnError = function () {
    push("turnstile_error");
  };
  window.turnstileOnExpired = function () {
    turnstileToken = null;
    push("turnstile_expired");
  };

  // FR-R7-015: one final keep-alive on pagehide (no periodic timer).
  // P1-AUDIT-2 Phase E: the flush takes ONE SENDABLE BATCH (takeBatch — the
  // same count/byte caps the server enforces), not the whole queue. The
  // prior events.slice() could exceed MAX_EVENTS_PER_BATCH or maxBatchBytes
  // on a long session → server 413 → the ENTIRE final batch was lost. One
  // bounded batch is the most the server can accept in a single keepalive
  // request anyway; anything older was already drained by earlier flushes.
  window.addEventListener("pagehide", () => {
    if (events.length === 0) return;
    const batch = takeBatch();
    if (!batch) return;
    try {
      fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      })
        .then(async (resp) => {
          if (resp.ok || resp.status === 409) {
            const body = await resp.json().catch(() => ({}));
            if (typeof body.acceptedThrough === "number") {
              trimAcknowledgedPrefix(body.acceptedThrough);
            }
          }
        })
        .catch(() => {});
    } catch {
      // pagehide is best-effort; nothing to do.
    }
  });

  // Submit handler.
  // FR-P0-4: the submit batch is SPLICED out of the queue, not copied —
  // the old slice() + requeueInFlight(unshift) pair duplicated every seq on
  // a verification/network failure, making the retry batch malformed
  // (strictly-increasing seq is a server rejection condition).
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitInFlight) return;
    submitInFlight = true;
    push("submit_attempt");
    await drainToBatches();

    // P1-AUDIT-2 (P1-14): attach at most ONE BOUNDED batch to the submit —
    // the same takeBatch() cap the telemetry contract enforces. The prior
    // splice(0, events.length) re-sent the WHOLE residual queue when a drain
    // failed (network down, or a host plane without a telemetry route),
    // building an eventBatch the server contract explicitly rejects
    // (>256 events → TOO_MANY_EVENTS → the whole registration died on
    // telemetry transport, exactly the coupling P1-14 forbids). The rest of
    // the queue stays for the next drain; registration never depends on it.
    const submitBatch = takeBatch() ?? [];
    if (submitBatch.length > 0) {
      events.splice(0, submitBatch.length);
    }

    const formData = new FormData(form);
    const formObj = {};
    formData.forEach((value, key) => {
      if (key !== "csrf") formObj[key] = value;
    });
    const csrfToken = form.querySelector('[name="csrf"]')?.value || "";

    // Requeue WITHOUT duplication: put the splice'd events back at the
    // front, in order, exactly once.
    function requeue(batch) {
      if (batch.length > 0) events.unshift(...batch);
    }

    try {
      const resp = await fetch(SUBMIT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          csrf: csrfToken,
          turnstileToken,
          form: formObj,
          eventBatch: submitBatch,
        }),
      });
      const result = await resp.json();

      if (resp.ok && result.status === "received") {
        // Server finalized the session — the stream is consumed either way.
        trimAcknowledgedPrefix(submitBatch[submitBatch.length - 1]?.seq ?? seq);
        renderResult(result);
      } else if (resp.status === 403 && result.status === "verification_required") {
        // Not finalized — retry with the SAME events (they were spliced out,
        // so putting them back is not a duplication).
        requeue(submitBatch);
        resetTurnstile();
        renderVerificationRequired(result);
      } else {
        requeue(submitBatch);
        renderResult(result);
      }
    } catch {
      requeue(submitBatch);
      renderResult({ error: "Submission failed. Please try again." });
    } finally {
      submitInFlight = false;
    }
  });
})();
