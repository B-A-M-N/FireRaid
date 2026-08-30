/**
 * FireRaid admin — vanilla JS dashboard.
 * FIX: Proper login flow (FR-025).
 * FIX: Use textContent instead of innerHTML (FR-026).
 * FIX: Use addEventListener instead of inline onclick (FR-027).
 * FIX: Timestamps use milliseconds (FR-028).
 */
(function () {
  "use strict";

  const api = {
    async get(path) {
      const resp = await fetch(path, { credentials: "include" });
      if (resp.status === 401) {
        showLogin();
        throw new Error("Unauthorized");
      }
      if (!resp.ok) throw new Error(`API error: ${resp.status}`);
      return resp.json();
    },
    async post(path, body) {
      const resp = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (resp.status === 401) {
        showLogin();
        throw new Error("Unauthorized");
      }
      if (!resp.ok) throw new Error(`API error: ${resp.status}`);
      return resp.json();
    },
  };

  function badge(disposition) {
    const cls = disposition === "QUARANTINE" ? "fr-badge-quarantine"
      : disposition === "REVIEW" ? "fr-badge-review"
      : "fr-badge-accept";
    const span = document.createElement("span");
    span.className = `fr-badge ${cls}`;
    span.textContent = disposition || "—";
    return span.outerHTML;
  }

  function formatDate(ts) {
    if (!ts) return "—";
    // FIX: Timestamps are in milliseconds
    return new Date(ts).toLocaleString();
  }

  function showLogin() {
    document.getElementById("login-view").classList.remove("fr-hidden");
    document.getElementById("dashboard-view").classList.add("fr-hidden");
  }

  function showDashboard() {
    document.getElementById("login-view").classList.add("fr-hidden");
    document.getElementById("dashboard-view").classList.remove("fr-hidden");
    loadAll();
  }

  async function loadAll() {
    await Promise.all([loadSummary(), loadSessions(), loadExperiments()]);
  }

  async function loadSummary() {
    try {
      const data = await api.get("/api/admin/summary");
      document.getElementById("m-sessions").textContent = data.sessions;
      document.getElementById("m-submitted").textContent = data.submitted;
      document.getElementById("m-quarantined").textContent = data.quarantined;
      document.getElementById("m-causal").textContent = data.causalHits;
      document.getElementById("m-experiments").textContent = data.experiments;
    } catch {
      // Not logged in
    }
  }

  async function loadSessions() {
    try {
      const data = await api.get("/api/admin/sessions?limit=50");
      const tbody = document.getElementById("sessions-body");
      tbody.innerHTML = "";
      if (!data.sessions.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.textContent = "No sessions yet";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      data.sessions.forEach((s) => {
        const tr = document.createElement("tr");

        const idTd = document.createElement("td");
        idTd.title = s.id;
        idTd.textContent = s.id.slice(0, 12) + "...";
        tr.appendChild(idTd);

        const dateTd = document.createElement("td");
        dateTd.textContent = formatDate(s.created_at);
        tr.appendChild(dateTd);

        const profileTd = document.createElement("td");
        profileTd.textContent = "v" + s.profile_version;
        tr.appendChild(profileTd);

        const dispTd = document.createElement("td");
        dispTd.innerHTML = badge(s.final_disposition);
        tr.appendChild(dispTd);

        const scoreTd = document.createElement("td");
        scoreTd.textContent = s.final_score ?? "—";
        tr.appendChild(scoreTd);

        const actionTd = document.createElement("td");
        const btn = document.createElement("button");
        btn.textContent = "View";
        btn.addEventListener("click", () => viewSession(s.id));
        actionTd.appendChild(btn);
        tr.appendChild(actionTd);

        tbody.appendChild(tr);
      });
    } catch {
      const tbody = document.getElementById("sessions-body");
      tbody.innerHTML = "";
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = "Not authorized";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  async function loadExperiments() {
    try {
      const data = await api.get("/api/admin/experiments");
      const tbody = document.getElementById("experiments-body");
      tbody.innerHTML = "";
      if (!data.experiments.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.textContent = "No experiments yet";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      data.experiments.forEach((e) => {
        const tr = document.createElement("tr");

        const idTd = document.createElement("td");
        idTd.textContent = e.id;
        tr.appendChild(idTd);

        const nameTd = document.createElement("td");
        nameTd.textContent = e.name || "—";
        tr.appendChild(nameTd);

        const statusTd = document.createElement("td");
        statusTd.textContent = e.status;
        tr.appendChild(statusTd);

        const dateTd = document.createElement("td");
        dateTd.textContent = formatDate(e.created_at);
        tr.appendChild(dateTd);

        tbody.appendChild(tr);
      });
    } catch {
      // ignore
    }
  }

  async function viewSession(sessionId) {
    try {
      const data = await api.get(`/api/admin/sessions/${sessionId}`);
      const section = document.getElementById("session-detail");
      const content = document.getElementById("session-detail-content");
      section.classList.remove("fr-hidden");
      content.innerHTML = "";

      const h3 = document.createElement("h3");
      h3.textContent = data.session.id;
      content.appendChild(h3);

      const p1 = document.createElement("p");
      p1.textContent = `Profile: v${data.session.profile_version} / ${data.session.profile_id}`;
      content.appendChild(p1);

      const p2 = document.createElement("p");
      p2.textContent = `Disposition: ${data.session.final_disposition || "—"} | Score: ${data.session.final_score ?? "—"}`;
      content.appendChild(p2);

      const h4 = document.createElement("h4");
      h4.textContent = "Canary Evidence";
      content.appendChild(h4);

      const table = document.createElement("table");
      table.className = "fr-table";
      const thead = document.createElement("thead");
      thead.innerHTML = "<tr><th>Family</th><th>Class</th><th>Verified</th><th>When</th></tr>";
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      if (data.canaryHits && data.canaryHits.length) {
        data.canaryHits.forEach((h) => {
          const tr = document.createElement("tr");
          tr.className = `fr-evidence-${h.evidence_class}`;
          
          const familyTd = document.createElement("td");
          familyTd.textContent = h.family;
          tr.appendChild(familyTd);
          
          const classTd = document.createElement("td");
          classTd.textContent = h.evidence_class;
          tr.appendChild(classTd);
          
          const verifiedTd = document.createElement("td");
          verifiedTd.textContent = h.verified ? "YES" : "no";
          tr.appendChild(verifiedTd);
          
          const whenTd = document.createElement("td");
          whenTd.textContent = formatDate(h.created_at);
          tr.appendChild(whenTd);
          
          tbody.appendChild(tr);
        });
      } else {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.textContent = "None";
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      content.appendChild(table);

      section.scrollIntoView({ behavior: "smooth" });
    } catch {
      alert("Failed to load session");
    }
  }

  // Login handler
  document.getElementById("login-btn").addEventListener("click", async () => {
    const secret = document.getElementById("admin-secret").value;
    try {
      const result = await api.post("/api/admin/login", { secret });
      if (result.ok) {
        showDashboard();
      }
    } catch {
      document.getElementById("login-error").textContent = "Invalid secret";
    }
  });

  // Logout handler
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api.post("/api/admin/logout");
    showLogin();
  });

  // Check if already logged in
  api.get("/api/admin/summary").then(showDashboard).catch(showLogin);
})();
