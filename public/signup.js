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
 *   submit/events request is ACKNOWLEDGED. On verification_required or
 *   network failure, in-flight events return to the FRONT of the queue in
 *   original order. Turnstile resets for a fresh token on retry.
 * FR-R7-014: when interactionScoring is OFF (the production default for
 *   most profiles), the client creates NO outbox, NEVER pushes page_ready,
 *   NEVER schedules a periodic flush, and NEVER calls /api/events from
 *   the page. A profile that does not score interaction does not need the
 *   telemetry stream at all.
 * FR-R7-015: the outbox represents UNSENT events only — the redundant
 *   keep-alive flush is removed; events leave the queue exactly when the
 *   server's acceptedThrough confirms receipt (or before submit, or on
 *   pagehide).
 * FR-R7-016: 409 is no longer treated as "drop everything"; the server
 *   returns the current watermark (acceptedThrough) so the client trims
 *   only the prefix the server actually has.
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

  const form = document.getElementById("signup-form");
  if (!form) return;

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
      const disposition = result.disposition || "REVIEW";
      div.innerHTML = `
        <p class="fr-result-status">Submission received.</p>
        <p class="fr-result-disposition">Status: ${escapeHtml(disposition)}</p>
      `;
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
  if (!MASK.interactionScoring) {
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
        const resp = await fetch("/api/submit", {
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
   * FR-R7-023: server-side MAX_EVENTS_PER_BATCH is 256 (re-benchmarked
   * against the 16 KiB byte budget). Keep this constant in sync with
   * src/types/telemetry.ts.
   */
  const MAX_EVENTS_PER_BATCH = 256;

  /**
   * FR-R7-015 / 016: send one batch and return the server's acceptedThrough
   * seq on success, the same on 409 (trim only what the server actually
   * has), or null on any other failure (leave the queue).
   */
  async function tryAcknowledge(batch) {
    try {
      const resp = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      });
      if (resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return typeof body.acceptedThrough === "number"
          ? body.acceptedThrough
          : batch[batch.length - 1].seq;
      }
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({}));
        if (typeof body.acceptedThrough === "number") {
          return body.acceptedThrough;
        }
        return batch[batch.length - 1].seq;
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

  async function drainToBatches() {
    while (events.length > MAX_EVENTS_PER_BATCH) {
      const batch = events.slice(0, MAX_EVENTS_PER_BATCH);
      const acked = await tryAcknowledge(batch);
      if (acked === null) break;
      trimAcknowledgedPrefix(acked);
    }
  }

  function requeueInFlight(inFlight) {
    if (inFlight.length > 0) {
      events.unshift(...inFlight);
    }
  }

  // Page ready (the first event in every telemetry-on session).
  push("page_ready");

  // Form events — FR-R6-036: each listener gated by its mask flag.
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

  // Pointer / key — FR-R6-036: gated.
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
  window.addEventListener("pagehide", () => {
    if (events.length === 0) return;
    const batch = events.slice();
    try {
      fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      })
        .then(async (resp) => {
          if (resp.ok) {
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
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitInFlight) return;
    submitInFlight = true;
    push("submit_attempt");
    await drainToBatches();
    const inFlight = events.slice();

    const formData = new FormData(form);
    const formObj = {};
    formData.forEach((value, key) => {
      if (key !== "csrf") formObj[key] = value;
    });
    const csrfToken = form.querySelector('[name="csrf"]')?.value || "";

    try {
      const resp = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          csrf: csrfToken,
          turnstileToken,
          form: formObj,
          eventBatch: inFlight,
        }),
      });
      const result = await resp.json();

      if (resp.ok && result.status === "received") {
        trimAcknowledgedPrefix(inFlight[inFlight.length - 1]?.seq ?? seq);
        renderResult(result);
      } else if (resp.status === 403 && result.status === "verification_required") {
        requeueInFlight(inFlight);
        resetTurnstile();
        renderVerificationRequired(result);
      } else {
        requeueInFlight(inFlight);
        renderResult(result);
      }
    } catch {
      requeueInFlight(inFlight);
      renderResult({ error: "Submission failed. Please try again." });
    } finally {
      submitInFlight = false;
    }
  });
})();
