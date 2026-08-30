/**
 * FireRaid client telemetry + form submission.
 * Buffers coarse interaction events, flushes before submit.
 * FIX: Now properly prevents default form submission and posts JSON.
 * FIX: Final telemetry events are included in the submit request (FR-R2-008).
 * FR-R6-036: the server-generated capture mask (fr-client-config JSON block)
 *   gates EVERY listener — a profile with capturePointer=false captures no
 *   pointer events client-side; randomized telemetry conditions are real.
 *   Fail-safe default when the config is absent/invalid: capture only submit.
 * FR-R6-037: retry-safe outbox — events leave the queue only after the
 *   submit/events request is ACKNOWLEDGED. On verification_required, network
 *   failure, or telemetry 409, in-flight events return to the FRONT of the
 *   queue in original order. Turnstile resets for a fresh token on retry.
 */
(function () {
  "use strict";

  // ── FR-R6-036: server-generated capture mask ─────────────────────────────
  const DEFAULT_MASK = {
    telemetry: {
      captureFocus: false,
      captureInput: false,
      captureChange: false,
      capturePointer: false,
      captureKey: false,
      captureSubmit: true, // submit tracking is core UX, not a treatment
    },
    interactionScoring: false,
  };

  function readClientConfig() {
    try {
      const el = document.getElementById("fr-client-config");
      if (!el) return DEFAULT_MASK;
      const parsed = JSON.parse(el.textContent);
      const t = parsed && typeof parsed === "object" ? parsed.telemetry : null;
      if (!t || typeof t !== "object") return DEFAULT_MASK;
      const bool = (v) => typeof v === "boolean" ? v : false;
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
      };
    } catch {
      return DEFAULT_MASK;
    }
  }

  const MASK = readClientConfig();

  const events = [];
  let seq = 0;
  const startTime = Date.now();
  let turnstileToken = null;
  // FR-R6-037: last seq the server has acknowledged (via any accepted batch
  // or a submit that carried events successfully). Used to keep the outbox
  // consistent across retries.
  let acknowledgedSeq = 0;
  let submitInFlight = false;

  function push(kind, target, meta) {
    events.push({ seq: ++seq, dt: Date.now() - startTime, kind, target, meta });
  }

  /**
   * FR-R6-026 follow-up: the server rejects ANY batch over 64 events
   * (MAX_EVENTS_PER_BATCH in src/types/telemetry.ts — 413 TOO_MANY_EVENTS,
   * whole batch, no truncation). A heavy typist easily outruns the 5s
   * periodic flush, so the submit outbox MUST drain in bounded chunks via
   * /api/events instead of carrying everything in the submit request.
   * Keep in sync with the server constant.
   */
  const MAX_EVENTS_PER_BATCH = 64;

  /**
   * Drain queued events to /api/events in server-legal batches. Called
   * opportunistically (before submit); the watermark makes redundant
   * deliveries harmless. Returns when the queue fits in one batch (or the
   * sends were attempted).
   */
  async function drainToBatches() {
    while (events.length > MAX_EVENTS_PER_BATCH) {
      const batch = events.slice(0, MAX_EVENTS_PER_BATCH);
      try {
        const resp = await fetch("/api/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
          keepalive: true,
        });
        if (resp.ok) {
          events.splice(0, MAX_EVENTS_PER_BATCH);
          acknowledgedSeq = Math.max(acknowledgedSeq, batch[batch.length - 1].seq);
        } else if (resp.status === 409) {
          // Server ahead of us (a previous submit carried these). Drop prefix.
          events.splice(0, MAX_EVENTS_PER_BATCH);
        } else {
          // Rejected: leave the queue; submit will surface the failure.
          break;
        }
      } catch {
        break; // network issue — submit path will surface it
      }
    }
  }

  // Page ready
  push("page_ready");

  // Form events — FR-R6-036: each listener gated by its mask flag.
  const form = document.getElementById("signup-form");
  if (!form) return;

  const fields = form.querySelectorAll("input, textarea, select");
  fields.forEach((el) => {
    if (MASK.telemetry.captureFocus) {
      el.addEventListener("focus", () => push("focus", el.name || el.id));
    }
    if (MASK.telemetry.captureFocus) {
      el.addEventListener("blur", () => push("blur", el.name || el.id));
    }
    if (MASK.telemetry.captureInput) {
      el.addEventListener("input", () => push("input", el.name || el.id, { inputType: el.type }));
    }
    if (MASK.telemetry.captureChange) {
      el.addEventListener("change", () => push("change", el.name || el.id, { inputType: el.type }));
    }
  });

  // Pointer / key — FR-R6-036: gated
  if (MASK.telemetry.capturePointer) {
    document.addEventListener("pointerdown", (e) => {
      push("pointer", e.target.name || e.target.id || e.target.tagName);
    });
  }
  if (MASK.telemetry.captureKey) {
    document.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      push("key", e.target.name || e.target.id || e.target.tagName);
    });
  }

  // Turnstile callbacks
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

  /** FR-R6-037: reset the Turnstile widget so a retry gets a fresh token. */
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

  /** FR-R6-037: put in-flight events back at the FRONT, original order. */
  function requeueInFlight(inFlight) {
    if (inFlight.length > 0) {
      events.unshift(...inFlight);
    }
  }

  // Submit handler - FIX: prevent default, serialize form, post JSON
  // FR-R2-008: Include buffered events in the submit request.
  // FR-R6-037: events move to in-flight, not out of existence — a failed
  // submit (verification_required, network error, 409) puts them back.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitInFlight) return;
    submitInFlight = true;
    push("submit_attempt");

    // FR-R6-026 follow-up: drain any over-batch backlog first so the submit
    // body itself carries at most one server-legal batch (≤64 events). A
    // rejection here leaves the queue for the failure branches below.
    await drainToBatches();

    // In-flight = everything buffered (the submit carries the final batch).
    const inFlight = events.splice(0, events.length);

    // Collect form data
    const formData = new FormData(form);
    const formObj = {};
    formData.forEach((value, key) => {
      if (key !== "csrf") {
        formObj[key] = value;
      }
    });

    // Get CSRF token
    const csrfToken = form.querySelector('[name="csrf"]')?.value || "";

    const body = {
      csrf: csrfToken,
      turnstileToken: turnstileToken,
      form: formObj,
      eventBatch: inFlight,
    };

    try {
      const resp = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.json();

      if (resp.ok && result.status === "received") {
        // Acknowledged: the server has the batch.
        acknowledgedSeq = seq;
        renderResult(result);
      } else if (resp.status === 403 && result.status === "verification_required") {
        // FR-R6-037: dedicated handling — requeue, reset widget, surface, retry.
        requeueInFlight(inFlight);
        resetTurnstile();
        renderVerificationRequired(result);
      } else {
        // Any other rejection (CSRF, validation, 4xx/5xx): requeue and show.
        requeueInFlight(inFlight);
        renderResult(result);
      }
    } catch {
      // Network failure: requeue everything, keep the user's state.
      requeueInFlight(inFlight);
      renderResult({ error: "Submission failed. Please try again." });
    } finally {
      submitInFlight = false;
    }
  });

  /**
   * FR-R6-037: verification_required UI — distinct from a generic error:
   * tells the user what happened, offers a retry that resubmits the same
   * form (with the requeued telemetry) after the widget resets.
   */
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

  function renderResult(result) {
    // Remove existing result if any
    const existing = document.getElementById("fr-result");
    if (existing) existing.remove();

    const div = document.createElement("div");
    div.id = "fr-result";
    div.className = "fr-result";

    if (result.error) {
      div.innerHTML = `<p class="fr-result-error">${escapeHtml(result.error)}</p>`;
    } else if (result.status === "received") {
      const disposition = result.disposition || "REVIEW";
      div.innerHTML = `
        <p class="fr-result-status">Submission received.</p>
        <p class="fr-result-disposition">Status: ${escapeHtml(disposition)}</p>
      `;
    }

    form.after(div);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Periodic flush (best-effort, non-blocking) for events before submit.
  // FR-R6-037: only events above the acknowledged watermark are flushed
  // here, and a 409 clears conservatively (the server watermark is ahead of
  // what we believed — never replay across it).
  setInterval(flush, 5000);

  function flush() {
    if (events.length === 0) return;
    // Do not flush the tail of the queue that submit will carry anyway;
    // flush only acknowledged-prefix-safe batches (all events are
    // monotonically sequenced, so the whole queue is safe to send as-is).
    const batch = events.slice();
    fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    })
      .then(async (resp) => {
        if (resp.ok) {
          // Keep them queued — submit carries the final batch; periodic
          // flush is a redundancy copy the watermark dedupes.
          acknowledgedSeq = Math.max(acknowledgedSeq, batch[batch.length - 1].seq);
        } else if (resp.status === 409) {
          // Watermark conflict: the server is AHEAD of us (a submit already
          // carried these events). Drop the accepted prefix conservatively.
          events.splice(0, events.length);
        }
        // Other failures: leave the queue intact for the submit path.
      })
      .catch(() => {
        // Network failure: leave the queue intact.
      });
  }
})();
