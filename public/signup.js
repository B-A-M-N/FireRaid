/**
 * FireRaid client telemetry + form submission.
 * Buffers coarse interaction events, flushes before submit.
 * FIX: Now properly prevents default form submission and posts JSON.
 * FIX: Final telemetry events are included in the submit request (FR-R2-008).
 */
(function () {
  "use strict";

  const events = [];
  let seq = 0;
  const startTime = Date.now();
  let turnstileToken = null;

  function push(kind, target, meta) {
    events.push({ seq: ++seq, dt: Date.now() - startTime, kind, target, meta });
  }

  // Page ready
  push("page_ready");

  // Form events
  const form = document.getElementById("signup-form");
  if (!form) return;

  const fields = form.querySelectorAll("input, textarea, select");
  fields.forEach((el) => {
    el.addEventListener("focus", () => push("focus", el.name || el.id));
    el.addEventListener("blur", () => push("blur", el.name || el.id));
    el.addEventListener("input", () => push("input", el.name || el.id, { inputType: el.type }));
    el.addEventListener("change", () => push("change", el.name || el.id, { inputType: el.type }));
  });

  // Pointer / key
  document.addEventListener("pointerdown", (e) => {
    push("pointer", e.target.name || e.target.id || e.target.tagName);
  });
  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    push("key", e.target.name || e.target.id || e.target.tagName);
  });

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

  // Submit handler - FIX: prevent default, serialize form, post JSON
  // FR-R2-008: Include buffered events in the submit request
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    push("submit_attempt");

    // Take buffered events for inclusion in submit
    const finalEvents = events.splice(0, events.length);

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

    // Build request body - include final telemetry batch
    const body = {
      csrf: csrfToken,
      turnstileToken: turnstileToken,
      form: formObj,
      eventBatch: finalEvents,
    };

    try {
      const resp = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await resp.json();

      // Render result
      renderResult(result);
    } catch {
      renderResult({ error: "Submission failed. Please try again." });
    }
  });

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

  // Periodic flush (best-effort, non-blocking) for events before submit
  setInterval(flush, 5000);

  function flush() {
    if (events.length === 0) return;
    const batch = events.splice(0, events.length);
    try {
      fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Best-effort flush — telemetry must never break submission UX.
    }
  }
})();
