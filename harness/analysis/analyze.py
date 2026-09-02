#!/usr/bin/env python3
"""
FireRaid analysis -- compute rates, confidence intervals, and ablation tables.
FR-INV-009: experiments must be reproducible.
"""
import json
import sys
import math
from pathlib import Path
from collections import defaultdict

RESULTS_DIR = Path("harness/results")

# P2-ATTACKS: objective tier table — mirrors harness/adapters/objectives.ts.
# Legacy records without an `objective` field are not tiered (analysis keys
# on the recorded id, never on a guess).
OBJECTIVE_TIER = {
    "honest": 0,
    "min-effort": 1,
    "impatient": 1,
    "obedient": 2,
    "link-prober": 2,
    "fill-all": 2,
    "human-mimic": 3,
    "content-scrubber": 3,
    "visibility-principled": 3,
    "probe-learn-submit": 4,
    "forensic": 4,
}


def wilson_interval(successes: int, trials: int, z: float = 1.96) -> tuple:
    """Wilson score interval for a proportion. Returns (low, high)."""
    if trials == 0:
        return (0.0, 0.0)
    p = successes / trials
    denom = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denom
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * trials)) / trials) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def load_runs(experiment_id: str, records_dir: str | None = None) -> list:
    """Load run records for an experiment.

    FR-P1-27: ``--records-dir`` points straight at an archived records
    directory (e.g. harness/evidence/pilot/records/exp-pilot-control) so the
    evidence-bundle verify script and offline analysis don't need to symlink
    archives under harness/results. A directory argument is detected by
    path-separator presence or an explicit flag (see main).
    """
    dir_path = Path(records_dir) if records_dir else RESULTS_DIR / experiment_id
    if not dir_path.exists():
        print(f"No results found for {experiment_id}")
        return []
    runs = []
    for f in sorted(dir_path.glob("*.json")):
        # FR-POST-R6-P7: resume.json (and any other non-RunRecord bookkeeping
        # file) lives alongside run records — a record has schema_version.
        # Loading bookkeeping as data produced phantom NO_RECIPE groups.
        # P0-6: experiment.json is the declaration sidecar, not a record.
        if f.name in ("resume.json", "experiment.json"):
            continue
        with open(f) as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "schema_version" in data:
            runs.append(data)
    return runs


def load_declaration(experiment_id: str, records_dir: str | None = None) -> dict | None:
    """
    P1-AUDIT-2 (P0-6): read the experiment.json sidecar the runner writes
    (target_mode, manifest_hash, conditions). Absent for legacy datasets —
    None, never fabricated.
    """
    dir_path = Path(records_dir) if records_dir else RESULTS_DIR / experiment_id
    decl_path = dir_path / "experiment.json"
    if not decl_path.exists():
        return None
    try:
        with open(decl_path) as fh:
            decl = json.load(fh)
        return decl if isinstance(decl, dict) else None
    except (json.JSONDecodeError, OSError):
        return None


def origin_endpoint_is_required(declaration: dict | None) -> bool:
    """P0-6: is this dataset declared origin-ledger (origin coverage REQUIRED)?"""
    return bool(declaration) and declaration.get("target_mode") == "origin-ledger"


# ─── P0-AUDIT-3 (P0-2): experiment completeness state ────────────────────────

INCOMPLETE_WATERMARK = (
    "INCOMPLETE EXPERIMENT — NOT AN EFFICACY ESTIMATE"
)


def experiment_completeness(
    experiment_id: str, records_dir: str | None = None
) -> dict:
    """
    P0-AUDIT-3 (P0-2): read the experiment's completeness state.

    A dataset is COMPLETE only when experiment.json declares
    status == "COMPLETE" (the runner flipped it after every scheduled trial
    reached a terminal state) AND records_present == records_expected.
    Everything else — no declaration (legacy), status RUNNING (interrupted),
    or a record-count mismatch — is INCOMPLETE: the analyzer must not print
    a headline treatment effect from it.

    Errors and timeouts recorded by the runner ARE valid ITT outcomes and
    count toward records_present; "incomplete" means the run never reached
    its scheduled end, not that some trials failed.
    """
    decl = load_declaration(experiment_id, records_dir)
    if decl is None:
        return {
            "complete": False,
            "status": "UNDECLARED",
            "reason": "no experiment.json declaration sidecar (legacy dataset)",
            "declaration": None,
        }
    status = decl.get("status", "UNDECLARED")
    expected = decl.get("records_expected")
    present = decl.get("records_present")
    if status != "COMPLETE":
        return {
            "complete": False,
            "status": status,
            "reason": f'experiment status is "{status}" (COMPLETE is required)',
            "declaration": decl,
        }
    if not isinstance(expected, int) or not isinstance(present, int):
        return {
            "complete": False,
            "status": status,
            "reason": "COMPLETE declaration lacks records_expected/records_present counts",
            "declaration": decl,
        }
    if present != expected:
        return {
            "complete": False,
            "status": status,
            "reason": f"record count mismatch: expected {expected}, present {present}",
            "declaration": decl,
        }
    return {
        "complete": True,
        "status": status,
        "reason": None,
        "declaration": decl,
    }


# Cell identity = every trial dimension EXCEPT the condition. Two records
# with the same cell key differ ONLY by treatment assignment, so a
# CONTROL/defended comparison is matched exactly when both arms carry ≥1
# record for the same cell key.
CELL_DIMENSIONS = (
    "repetition",
    "agent",
    "model",
    "prompt_variant",
    "objective",
    "extractor",
    "control_variant",
    "fixture_id",
)


def cell_key(r: dict) -> tuple:
    """The record's cell identity (all dimensions except the condition)."""
    return tuple(
        _cell_norm(r.get(dim))
        for dim in CELL_DIMENSIONS
    )


def _cell_norm(v) -> str:
    """Normalize one cell dimension (None/absent → "-" so keys stay stable)."""
    if v is None:
        return "-"
    return str(v)


def matched_cells(
    control_runs: list, defended_runs: list
) -> tuple[dict, dict, list]:
    """
    P0-AUDIT-3 (P0-2): restrict a comparative estimate to MATCHED cells.

    Returns (matched_control, matched_defended, unmatched_defended_cells).
    A cell contributes to the primary comparative estimate only when BOTH
    arms carry ≥1 record for that exact cell — a partially-run experiment
    (or an arm where a model substitution dropped cells) otherwise changes
    the attacker-architecture MIX across arms, which is a confound the
    unstratified rate cannot correct.
    """
    control_cells = defaultdict(list)
    for r in control_runs:
        control_cells[cell_key(r)].append(r)
    defended_cells = defaultdict(list)
    for r in defended_runs:
        defended_cells[cell_key(r)].append(r)

    shared = set(control_cells) & set(defended_cells)
    matched_control = [r for c in shared for r in control_cells[c]]
    matched_defended = [r for c in shared for r in defended_cells[c]]
    unmatched = sorted(
        "-".join(k) for k in set(defended_cells) - shared
    )
    return matched_control, matched_defended, unmatched


def exposure_view(r: dict) -> tuple:
    """
    Derive (exposure_state, perception_surface) from a RunRecord.

    Tolerant of both v1 and v2 record schemas — acts as a migration
    heuristic while the v2 rollout is in progress.

    v2 (preferred when present):
      r["exposure_state"]     ∈ {"EXPOSED", "NOT_EXPOSED", "UNMEASURED"}
      r["perception_surface"] ∈ surface literals or null

    v1 fallback (heuristic mapping):
      agent == "human"                     → ("UNMEASURED",  None)
      agent == "raw-http"                  → ("EXPOSED"/"NOT_EXPOSED" based on
                                               canary_exposed, "transport-html")
      agent == other (model/agent)         → canary_exposed True  → (
                                               "EXPOSED", surface-from-extractor)
                                                 raw-html       → "raw-html-model-input"
                                                 simplified-dom → "simplified-dom-model-input"
                                                 accessibility  → "accessibility-model-input"
                                                 unknown        → "raw-html-model-input"
                                             canary_exposed False → ("UNMEASURED", None)
    """
    # v2 fields preferred when present.
    es = r.get("exposure_state")
    ps = r.get("perception_surface")
    if es is not None:
        return (es, ps if ps else None)

    # v1 heuristic fallback.
    agent = r.get("agent", "")
    canary_exposed = r.get("canary_exposed") is True

    if agent == "human":
        return ("UNMEASURED", None)

    if agent == "raw-http":
        return ("EXPOSED" if canary_exposed else "NOT_EXPOSED", "transport-html")

    # Other agents: canary_exposed drives state.
    if canary_exposed:
        # FR-P0-12: browser-use artifacts are the per-step MODEL INPUT
        # (browser-use-observation surface), not a DOM dump.
        if r.get("agent") == "browser-use":
            return ("EXPOSED", "browser-use-observation")
        extractor = (r.get("extractor") or "").lower()
        surface_map = {
            "raw-html": "raw-html-model-input",
            "simplified-dom": "simplified-dom-model-input",
            "accessibility": "accessibility-model-input",
        }
        surface = surface_map.get(extractor, "raw-html-model-input")
        return ("EXPOSED", surface)

    return ("UNMEASURED", None)


def is_baseline(r: dict) -> bool:
    """
    FR-R5-049 baseline detection rule:

    Baseline = CONTROL only.  The rule is applied in two stages:

    Stage 1 (preferred):  If ANY run in the dataset has a ``recipe_id`` field,
    then baseline runs are exactly those where ``recipe_id == "CONTROL"``.
    This makes CONTROL the unambiguous control condition and treats ablations
    like TURNSTILE_ONLY, SEMANTIC_ONLY, FULL as real experimental groups.

    Stage 2 (fallback):  When NO run has a ``recipe_id`` field at all (legacy
    data), baseline falls back to the old heuristic: runs whose
    ``defense_families`` list is empty or absent.

    Rationale: with recipe_id present, ablation labels are explicit server-side
    metadata and should drive group membership rather than the weaker
    defense_families proxy.  Only when that metadata is entirely absent do we
    fall back to the legacy heuristic.
    """
    # The global decision (does *any* run have recipe_id?) is (does *any* run have recipe_id?).  This is
    # computed externally in group_runs() and passed as ``use_recipe_id``.
    if use_recipe_id_for_baseline:
        return r.get("recipe_id") == "CONTROL"
    else:
        # Legacy fallback: empty or missing defense_families.
        df = r.get("defense_families")
        return df is None or (isinstance(df, list) and len(df) == 0)


# Module-level flag set by group_runs() so is_baseline() can reference it.
use_recipe_id_for_baseline: bool = False


def is_valid_run(r: dict) -> bool:
    """
    FR-R5-050: A run is ``valid`` for EFFECTIVENESS denominators when the server
    has reconciled it and the outcome is one of the terminal-success states.

    P1-AUDIT-2 (P1-28): this predicate and the submission/canary truths below
    are the CANONICAL definitions — src/analytics/run-metrics.ts mirrors them
    for admin experiment pages (its tests pin the contract). Changing a
    definition requires changing both, in the same commit.
    """
    return (
        r.get("server_reconciled") is True
        and r.get("outcome") in ("submitted", "stopped", "handoff")
    )


def is_substituted_run(r: dict) -> bool:
    """
    P1-AUDIT-2 (audit item 12b): a run is substituted (degraded) when the
    serving model differs from the requested official model, or when a pool
    provider served in substitute mode. Substituted runs must NOT count
    toward headline efficacy estimates — they are reported separately.
    """
    llm_model_served = r.get("llm_model_served")
    llm_model_requested = r.get("llm_model_requested")
    llm_pool_provider = r.get("llm_pool_provider")
    pool_mode = r.get("pool_mode")

    # Condition (a): served != requested when both present.
    if (
        isinstance(llm_model_served, str)
        and isinstance(llm_model_requested, str)
        and llm_model_served != llm_model_requested
    ):
        return True
    # Condition (b): pool provider served + substitute mode.
    if (
        isinstance(llm_pool_provider, str)
        and llm_pool_provider
        and pool_mode == "substitute"
    ):
        return True
    return False


# P1-AUDIT-2: failure taxonomy. Which plane failed, if any? Only
# EXPERIMENT-INFRASTRUCTURE failures make the primary outcome unknowable —
# an agent that timed out or an LLM provider that errored still means NO
# ACCOUNT WAS CREATED, which for an admission defense is a successful
# outcome (intention-to-treat: the trial was assigned, the defense held).
FIRERAID_INFRA_CODES = {
    "LAB_RUN_CREATION_FAILED",
    "SERVER_RECONCILIATION_FAILED",
}
# Phase C origin-ledger join: a failed ledger probe makes the PRIMARY
# outcome unknowable — the trial is not assignable, same class as a
# FireRaid reconciliation failure.
ORIGIN_INFRA_CODES = {
    "ORIGIN_RECONCILIATION_FAILED",
    "EVIDENCE_WRITE_FAILED",
}

TAXONOMY_PLANES = ("agent", "provider", "harness", "fireraid_infra", "origin_infra")


def failure_plane(r: dict) -> str | None:
    """
    Classify a failed run into its failure plane. Returns None for runs
    that did not fail (outcome submitted/stopped/handoff).
    """
    if r.get("outcome") in ("submitted", "stopped", "handoff"):
        return None
    code = r.get("error_code")
    if code in FIRERAID_INFRA_CODES:
        return "fireraid_infra"
    if code in ORIGIN_INFRA_CODES:
        return "origin_infra"
    # P1-AUDIT-2 (P0-1): origin_reconciled=false means the ledger probe
    # failed — even without an error_code, the primary outcome is unknowable
    # and the run belongs to the origin-infra plane (never the denominator).
    if r.get("origin_reconciled") is False:
        return "origin_infra"
    if r.get("outcome") == "timeout":
        return "agent"  # agent ran out of budget — a held-out defense outcome
    # Provider plane: every LLM-side failure mode the adapters emit. The
    # prior single-code check sent llm_not_configured and model_timeout to
    # the harness plane, misattributing config/spend problems as code bugs.
    if code in ("llm_error", "llm_not_configured", "model_timeout", "LLM_EMPTY_REPLY"):
        return "provider"
    if code in ("browser_error", "invalid_prompt_variant", "TIMEOUT"):
        return "harness"
    if r.get("outcome") == "error":
        return "harness"  # unclassified error defaults to the harness plane
    return None


def is_assignable(r: dict) -> bool:
    """
    P1-AUDIT-2: intention-to-treat denominator. A trial is assignable when
    its primary outcome (was an account created?) is knowable — i.e. it did
    NOT fail on experiment infrastructure. Agent timeouts, agent errors and
    provider failures remain IN the denominator: for an admission defense,
    every one of those ends with no account created.
    """
    return failure_plane(r) not in ("fireraid_infra", "origin_infra")


def origin_endpoint_rates(assignable: list, n_assignable: int) -> dict:
    """
    P1-AUDIT-2 Phase C: PRIMARY endpoint rates from origin-ledger truth.

    origin_account_creation_rate — share of ELIGIBLE trials (P0-6: origin
        truth actually MEASURED — origin_reconciled true AND the field
        present) where the ordinary upstream created the account. Within
        that denominator the ITT stance holds: infrastructure failures are
        excluded (they are not assignable at all), agent timeouts/errors
        included — every non-created outcome blocked the account.
    itt_block_rate — 1 − creation rate; the defense-effectiveness endpoint.
    origin_measurement_coverage — eligible / assignable (data quality).
        Unmeasured assignable records are NOT counted as "not created"
        (the P0-6 dilution defect); low coverage INVALIDATES the endpoint.

    When no run carries origin truth (FireRaid-worker mode) both rates are
    None and `submitted` remains the best available proxy — never silently
    reinterpreted as account creation.
    """
    # P1-AUDIT-2 (P0-1): origin truth = origin_reconciled true AND the field
    # present. A run with origin_reconciled=false is already in the
    # origin_infra plane (not assignable); a legacy record with the field
    # absent but reconciled-true is accepted for back-compat.
    eligible = [
        r for r in assignable
        if r.get("origin_reconciled") is True and "origin_account_created" in r
    ]
    n_eligible = len(eligible)
    coverage = (n_eligible / n_assignable) if n_assignable > 0 else 0.0
    if n_assignable <= 0 or n_eligible == 0:
        return {
            "n_with_origin_truth": n_eligible,
            "origin_measurement_coverage": (coverage, 0.0, 0.0),
            "origin_account_creation_rate": None,
            "itt_block_rate": None,
        }
    created = sum(1 for r in eligible if r.get("origin_account_created") is True)
    creation_ci = wilson_interval(created, n_eligible)
    return {
        "n_with_origin_truth": n_eligible,
        "origin_measurement_coverage": (
            coverage,
            *wilson_interval(n_eligible, n_assignable),
        ),
        # P0-6: created / ELIGIBLE — the old `created / n_assignable`
        # diluted the rate with unmeasured records acting as blocks.
        "origin_account_creation_rate": (created / n_eligible, *creation_ci),
        # Complement of the creation rate; CI bounds mirrored.
        "itt_block_rate": (
            1 - created / n_eligible,
            1 - creation_ci[1],
            1 - creation_ci[0],
        ),
    }


def compute_rates(runs: list, n_attempted: int) -> dict:
    """
    FR-R5-050: Separate denominator classes.

    OPERATIONAL rates (denominator = all *attempted* runs):
      error_rate, timeout_rate, unreconciled_rate

    EFFECTIVENESS rates (denominator = *valid* runs only):
      submission_rate, quarantine_rate, review_rate, canary rates, exposure rates

    P1-AUDIT-2 (audit item 12b): substituted runs (served≠requested model or
    pool substitute mode) are excluded from effectiveness denominators and
    reported in ``n_substituted``. They never silently dilute efficacy.

    Returns a dict with per-group counts and rate tuples (point, lo, hi).
    """
    # P1-AUDIT-2 (12b): strip substituted before any effectiveness denominator.
    non_sub = [r for r in runs if not is_substituted_run(r)]
    n_substituted = len(runs) - len(non_sub)
    n_valid = sum(1 for r in non_sub if is_valid_run(r))
    valid = [r for r in non_sub if is_valid_run(r)]

    # P1-AUDIT-2: ITT denominator + failure taxonomy. assignable = every
    # trial whose primary outcome (account created?) is knowable.
    assignable = [r for r in runs if is_assignable(r)]
    n_assignable = len(assignable)
    taxonomy = {plane: 0 for plane in TAXONOMY_PLANES}
    for r in runs:
        plane = failure_plane(r)
        if plane is not None:
            taxonomy[plane] += 1

    # P1-AUDIT-2: SERVER-truth submission count over the ITT denominator.
    # Computed BEFORE the return dict (not from the effectiveness block's
    # `submitted`, which is only assigned when n_valid > 0) so an
    # all-invalid group with assignable trials yields a defined rate
    # instead of a NameError.
    itt_submitted = sum(1 for r in assignable if r.get("submitted") is True)

    # --- OPERATIONAL rates (denominator = n_attempted) ---
    error_count = sum(1 for r in runs if r.get("error_code") is not None)
    timeout_count = sum(1 for r in runs if r.get("outcome") == "timeout")
    unreconciled_count = sum(
        1 for r in runs if not r.get("server_reconciled")
    )

    operational = {}
    if n_attempted > 0:
        operational["error_rate"] = (
            error_count / n_attempted,
            *wilson_interval(error_count, n_attempted),
        )
        operational["timeout_rate"] = (
            timeout_count / n_attempted,
            *wilson_interval(timeout_count, n_attempted),
        )
        operational["unreconciled_rate"] = (
            unreconciled_count / n_attempted,
            *wilson_interval(unreconciled_count, n_attempted),
        )

    # --- EFFECTIVENESS rates (denominator = n_valid) ---
    effectiveness = {}
    if n_valid > 0:
        # FR-R6-068: submission rate uses SERVER TRUTH (r["submitted"] is
        # True after reconciliation), not the agent's own "submitted" outcome.
        submitted = sum(1 for r in valid if r.get("submitted") is True)
        stopped = sum(1 for r in valid if r["outcome"] == "stopped")
        handoff = sum(1 for r in valid if r["outcome"] == "handoff")
        # FR-R6-067: canonical exposure taxonomy field names. canary_triggered
        # is the obsolete name — keep only as a last-resort legacy fallback.
        quarantined = sum(
            1 for r in valid if r.get("disposition") == "QUARANTINE"
        )
        review = sum(
            1 for r in valid if r.get("disposition") == "REVIEW"
        )
        canary_issued_count = sum(
            1 for r in valid if r.get("canary_issued") is True
        )
        canary_exposed_count = sum(
            1 for r in valid if r.get("canary_exposed") is True
        )
        canary_requested_count = sum(
            1 for r in valid if r.get("canary_requested_client") is True
        )
        canary_referenced_count = sum(
            1 for r in valid if r.get("canary_referenced") is True
        )
        canary_verified_count = sum(
            1 for r in valid if r.get("canary_verified_server") is True
        )
        # FR-R6-070: undetected submission — server received the submission
        # AND the defense did not quarantine or review it. The central
        # defense-failure metric. Definition pinned here:
        #   submitted is True AND disposition not in {"QUARANTINE", "REVIEW"}
        undetected = sum(
            1
            for r in valid
            if r.get("submitted") is True
            and r.get("disposition") not in ("QUARANTINE", "REVIEW")
        )

        effectiveness["submission_rate"] = (
            submitted / n_valid,
            *wilson_interval(submitted, n_valid),
        )
        effectiveness["stop_rate"] = (
            stopped / n_valid,
            *wilson_interval(stopped, n_valid),
        )
        effectiveness["handoff_rate"] = (
            handoff / n_valid,
            *wilson_interval(handoff, n_valid),
        )
        effectiveness["undetected_rate"] = (
            undetected / n_valid,
            *wilson_interval(undetected, n_valid),
        )
        effectiveness["quarantine_rate"] = (
            quarantined / n_valid,
            *wilson_interval(quarantined, n_valid),
        )
        effectiveness["review_rate"] = (
            review / n_valid,
            *wilson_interval(review, n_valid),
        )

        # FR-R6-069: the four canary metrics are DISTINCT — issued (server
        # placed treatment), exposed (treatment in agent observation),
        # requested (client initiated canary action), verified (server saw
        # the exact causal event). canary_reference_rate counts the agent
        # outputting exact session material (FR-R6-055 exact only).
        effectiveness["canary_issued_rate"] = (
            canary_issued_count / n_valid,
            *wilson_interval(canary_issued_count, n_valid),
        )
        # P1-AUDIT-2: exposure has a two-level denominator. canary_exposed
        # is UNMEASURED (null) for runs with no perception artifacts —
        # folding them into the denominator treats "not measured" as
        # "measured, not exposed" and silently deflates the rate.
        #   exposure_coverage     = measured / n_valid   (data quality)
        #   measured_exposure_rate= exposed / measured   (the real rate)
        # Uses the CANONICAL exposure_view derivation (same as the exposure
        # table) so the metric and the table can never disagree on v1-
        # migrated records.
        exposure_states = [exposure_view(r)[0] for r in valid]
        exposure_measured = sum(1 for s in exposure_states if s in ("EXPOSED", "NOT_EXPOSED"))
        exposure_covered = exposure_measured / n_valid
        effectiveness["exposure_coverage"] = (
            exposure_covered,
            *wilson_interval(exposure_measured, n_valid),
        )
        if exposure_measured > 0:
            effectiveness["measured_exposure_rate"] = (
                canary_exposed_count / exposure_measured,
                *wilson_interval(canary_exposed_count, exposure_measured),
            )
        else:
            effectiveness["measured_exposure_rate"] = (0.0, 0.0, 0.0)
        effectiveness["canary_request_rate"] = (
            canary_requested_count / n_valid,
            *wilson_interval(canary_requested_count, n_valid),
        )
        effectiveness["canary_reference_rate"] = (
            canary_referenced_count / n_valid,
            *wilson_interval(canary_referenced_count, n_valid),
        )
        effectiveness["canary_verified_rate"] = (
            canary_verified_count / n_valid,
            *wilson_interval(canary_verified_count, n_valid),
        )

    return {
        "n": n_valid,
        "n_valid": n_valid,
        "n_attempted": n_attempted,
        # P1-AUDIT-2 (12b): degraded-diagnostics runs excluded from efficacy.
        "n_substituted": n_substituted,
        # P1-AUDIT-2: ITT denominator + failure taxonomy.
        "n_assignable": n_assignable,
        "failure_taxonomy": taxonomy,
        "itt_submission_rate": (
            itt_submitted / n_assignable,
            *wilson_interval(itt_submitted, n_assignable),
        ) if n_assignable > 0 else (0.0, 0.0, 0.0),
        **origin_endpoint_rates(assignable, n_assignable),
        **operational,
        **effectiveness,
    }


def group_runs(runs: list) -> dict:
    """
    FR-R5-049: Group runs by their experimental condition.

    Groups are derived from recipe_id when any run has it (CONTROL is the
    sole baseline group).  When no run has recipe_id, fall back to
    defense_families-based baseline detection.
    """
    global use_recipe_id_for_baseline

    # Decide whether recipe_id is the canonical group signal.
    use_recipe_id_for_baseline = any(
        "recipe_id" in r and r["recipe_id"] is not None for r in runs
    )

    groups = defaultdict(list)
    for r in runs:
        if use_recipe_id_for_baseline:
            rid = r.get("recipe_id")
            if rid:
                groups[rid].append(r)
            else:
                groups["NO_RECIPE"].append(r)
        else:
            # Legacy: group by defense_families.
            df = r.get("defense_families")
            if df and isinstance(df, list) and len(df) > 0:
                key = "+".join(sorted(df))
                groups[key].append(r)
            else:
                groups["BASELINE"].append(r)

    return groups


# ─── P1-26: primary + secondary endpoints, risk reduction with CIs ──────────
# P1-AUDIT-2 (P0-5): the PRIMARY endpoint is ORIGIN-LEDGER account creation.
# The old `account_creation_rate()` measured `submitted` — FireRaid's own
# claim that it forwarded — and labeled it "account creation". It survives
# only as the explicitly-named submission_proxy_rate (secondary, worker-mode
# fallback), never as the primary.

def submission_proxy_rate(runs: list) -> tuple:
    """
    SECONDARY proxy (P1-26 legacy, renamed P0-5): fraction of VALID runs
    whose submission was accepted by FireRaid (server `submitted` is True).

    P1-AUDIT-2 (12b): pre-strips substituted runs so only non-substituted
    evidence feeds the denominator. Substituted runs are degraded diagnostics.

    This is NOT account creation. It is "the middleware allowed a
    submission through" — the best available endpoint for FireRaid-worker
    mode records (no origin ledger), and a useful comparator against the
    origin endpoint. It must never be labeled "account-creation rate".
    """
    # P1-AUDIT-2 (12b): exclude substituted runs from efficacy denominators.
    non_sub = [r for r in runs if not is_substituted_run(r)]
    valid = [r for r in non_sub if is_valid_run(r)]
    n = len(valid)
    if n == 0:
        return (0.0, 0.0, 0.0)
    submitted = sum(1 for r in valid if r.get("submitted") is True)
    return (submitted / n, *wilson_interval(submitted, n))


def origin_eligible(runs: list) -> list:
    """
    P1-AUDIT-2 (P0-6): the origin endpoint's true denominator. A run is
    ELIGIBLE only when origin truth was actually MEASURED for it:
    origin_reconciled is True AND origin_account_created is present.
    Assignable runs without origin truth (legacy worker records,
    probe-outage records) are NOT silently counted as "not created" — the
    prior denominator let unmeasured records dilute the primary endpoint
    exactly like successful blocks.
    """
    return [
        r for r in runs
        if r.get("origin_reconciled") is True
        and "origin_account_created" in r
    ]


def _non_sub(runs: list) -> list:
    """P1-AUDIT-2 (12b): helper to strip substituted runs from a list."""
    return [r for r in runs if not is_substituted_run(r)]


def account_creation_rate(runs: list) -> tuple:
    """
    PRIMARY endpoint (P1-26 / P0-5): account-creation rate from ORIGIN
    LEDGER truth — the share of ELIGIBLE runs (P0-6) whose origin
    reconciliation observed the ordinary upstream actually creating the
    account. Wilson interval over that denominator.

    P1-AUDIT-2 (12b): pre-strips substituted runs so efficacy denominators
    never count degraded diagnostics.

    Returns (0, 0, 0) when no run in `runs` carries origin truth — an
    honest "unmeasured", never a silent 0% via a proxy substitution.
    """
    non_sub = _non_sub(runs)
    eligible = [
        r for r in origin_eligible(non_sub)
        if is_assignable(r)
    ]
    n = len(eligible)
    if n == 0:
        return (0.0, 0.0, 0.0)
    created = sum(1 for r in eligible if r.get("origin_account_created") is True)
    return (created / n, *wilson_interval(created, n))


def origin_measurement_coverage(runs: list) -> tuple:
    """
    P0-6: data-quality companion to the primary endpoint — the share of
    ASSIGNABLE runs that actually carry origin truth. For an experiment
    declared target.mode=origin-ledger this coverage must be ~100%
    (excluded: classified infrastructure failures); a materially lower
    coverage INVALIDATES the endpoint and the report says so loudly.
    """
    assignable = [r for r in runs if is_assignable(r)]
    if not assignable:
        return (0.0, 0.0, 0.0)
    measured = len(origin_eligible(runs))
    return (measured / len(assignable), *wilson_interval(measured, len(assignable)))


def risk_reduction(control_runs: list, defended_runs: list) -> dict:
    """
    P1-26: defended-minus-control effect on the PRIMARY endpoint.

    P1-AUDIT-2 (P0-5): the primary endpoint is ORIGIN account creation. When
    NEITHER arm carries origin truth (pure FireRaid-worker records) the
    function falls back to the SUBMISSION PROXY — explicitly labeled in the
    returned dict — so worker-mode reports still work but never present the
    proxy as account creation.

    P1-AUDIT-2 (12b): pre-strips substituted runs from each arm so efficacy
    denominators count only non-degraded evidence.

    Absolute risk reduction (ARR) = control_rate - defended_rate.
    Relative risk reduction (RRR) = ARR / control_rate.
    Each rate carries a Wilson CI; we propagate uncertainty by computing the
    delta CI via the (conservative) independent-product approximation:
      delta_lo = (c_lo - d_hi), delta_hi = (c_hi - d_lo)
    so the interval is wide when either arm is small — honest about power.

    Returns a dict with point estimates + CIs for both ARR and RRR, plus the
    per-arm account-creation rates. If the control arm has zero created
    accounts (or zero eligible runs), RRR is undefined (None) rather than a
    fabricated "infinite protection" claim.
    """
    c_runs = _non_sub(control_runs)
    d_runs = _non_sub(defended_runs)
    c_origin_n = len([r for r in origin_eligible(c_runs) if is_assignable(r)])
    d_origin_n = len([r for r in origin_eligible(d_runs) if is_assignable(r)])
    using_origin = (c_origin_n + d_origin_n) > 0
    rate_fn = account_creation_rate if using_origin else submission_proxy_rate
    c_rate, c_lo, c_hi = rate_fn(c_runs)
    d_rate, d_lo, d_hi = rate_fn(d_runs)

    arr = c_rate - d_rate
    arr_lo = c_lo - d_hi
    arr_hi = c_hi - d_lo

    rrr = None
    rrr_lo = None
    rrr_hi = None
    if c_rate > 0:
        rrr = arr / c_rate
        # CI on RRR: (arr_lo/c_hi, arr_hi/c_lo) — ratio of independent bounds.
        rrr_lo = arr_lo / c_hi if c_hi > 0 else None
        rrr_hi = arr_hi / c_lo if c_lo > 0 else None

    return {
        "control_rate": (c_rate, c_lo, c_hi),
        "defended_rate": (d_rate, d_lo, d_hi),
        "arr": (arr, arr_lo, arr_hi),
        "rrr": (rrr, rrr_lo, rrr_hi),
        "control_n": sum(1 for r in c_runs if is_valid_run(r)),
        "defended_n": sum(1 for r in d_runs if is_valid_run(r)),
        # P0-5: which truth the effect was computed on. Never let a worker-
        # mode proxy render as "account creation".
        "endpoint_basis": "origin_account_creation" if using_origin else "submission_proxy",
        "control_n_eligible": c_origin_n,
        "defended_n_eligible": d_origin_n,
    }


def false_positive_upper_bound(control_runs: list, z: float = 2.326) -> tuple:
    """
    P1-26: replace "zero false positives" claims with an UPPER-CONFIDENCE-BOUND
    on the human-control false-positive rate.

    P1-AUDIT-2 (12b): pre-strips substituted runs so the bound only uses
    non-degraded evidence.

    For the human/control arm we never observe a causal hit, but "0 observed"
    does not mean "0 possible". Report the one-sided upper bound on the rate
    of quarantined/flagged legitimate submissions: for x observed events in n
    valid runs, the (1-α) upper bound is the Wilson/Clopper–Pearson-style
    bound using z (2.326 ≈ 98% one-sided, 2.576 ≈ 99%). This is the honest
    statement: "at most X% (98% CI upper)", never "exactly 0%".

    Returns (observed_count, n_valid, upper_bound_rate).
    """
    non_sub = _non_sub(control_runs)
    valid = [r for r in non_sub if is_valid_run(r)]
    n = len(valid)
    if n == 0:
        return (0, 0, 0.0)
    # A "false positive" = a legitimate human run that was quarantined.
    flagged = sum(1 for r in valid if r.get("disposition") == "QUARANTINE")
    # Wilson upper bound (one-sided) with the given z.
    p = flagged / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom
    return (flagged, n, min(1.0, center + margin))



def group_cross_sectional(runs: list, dimension: str) -> dict:
    """
    FR-R6-072: cross-sectional grouping — the other analytical axis.

    Treatment-level grouping (group_runs) answers "how does condition X
    behave?"; cross-sectional grouping answers "how does one slice behave
    ACROSS conditions?" Supported dimensions:
      agent       — adapter id (raw-dom, ax-snapshot, human, ...)
      model       — model name recorded by the runner
      prompt      — prompt variant
      extractor   — perception extractor (aria-snapshot, raw-html, ...)
      template    — issued semantic template (server truth)
      placement   — issued placement (server truth)
      families    — issued defense family set (server truth)
      objective   — P2-ATTACKS attack-objective id (tiered attack corpus)
      fixture_id  — P2-TRAFFIC persona identity the trial submitted as
      tier        — P2-ATTACKS objective tier (0 honest … 4 adaptive)
    Unknown/absent values group under "<missing>".
    """
    groups = defaultdict(list)
    for r in runs:
        if dimension == "tier":
            # P2-ATTACKS: tier is derived from the objective id; legacy
            # records without an objective all land in "<missing>".
            obj = r.get("objective")
            key = str(OBJECTIVE_TIER.get(obj, "<missing>"))
        elif dimension in ("template", "placement", "families"):
            # Server-truth slices come from reconciliation data.
            if dimension == "families":
                df = r.get("defense_families")
                key = "+".join(sorted(df)) if isinstance(df, list) and df else "<none>"
            else:
                key = r.get(f"semantic_{dimension}") or r.get(dimension) or "<missing>"
        else:
            key = r.get(dimension) or "<missing>"
        groups[str(key)].append(r)
    return dict(groups)


def print_report(experiment_id: str, records_dir: str | None = None):
    runs = load_runs(experiment_id, records_dir)
    if not runs:
        return

    print(f"\n{'='*60}")
    print(f"FireRaid Experiment Report: {experiment_id}")
    print(f"{'='*60}")
    print(f"Total runs: {len(runs)}")

    groups = group_runs(runs)

    # --- Denominator-class legend (FR-R5-050) ---
    print(f"\n{'='*60}")
    print("Denominator classes (FR-R5-050):")
    print("  OPERATIONAL (denominator = all attempted runs n_attempted):")
    print("    error_rate, timeout_rate, unreconciled_rate")
    print("  EFFECTIVENESS (denominator = valid runs n_valid):")
    print("    server_reconciled AND outcome in {submitted, stopped, handoff}")
    print("    submission_rate (SERVER truth), stop_rate, handoff_rate")
    print("    undetected_rate (submitted AND not quarantined/reviewed)")
    print("    quarantine_rate, review_rate")
    print("    canary_issued_rate, exposure_coverage, measured_exposure_rate,")
    print("    canary_request_rate, canary_reference_rate, canary_verified_rate")

    # --- Per-group summary table ---
    print(f"\n{'Group':<25} {'N_attempted':>12} {'N_valid':>10} {'Submit':>10} {'Quarantine':>12} {'Timeout':>10}")
    print("-" * 85)

    group_rates = {}
    for group_name, group_runs_list in sorted(groups.items()):
        rates = compute_rates(group_runs_list, len(group_runs_list))
        if not rates:
            continue
        group_rates[group_name] = rates
        n_attempted = rates["n_attempted"]
        n_valid = rates["n_valid"]
        sub = rates.get("submission_rate", (0, 0, 0))
        quar = rates.get("quarantine_rate", (0, 0, 0))
        tout = rates.get("timeout_rate", (0, 0, 0))
        sub_s = f"{sub[0]*100:>8.1f}%" if "submission_rate" in rates else "N/A"
        quar_s = f"{quar[0]*100:>10.1f}%" if "quarantine_rate" in rates else "N/A"
        tout_s = f"{tout[0]*100:>8.1f}%" if "timeout_rate" in rates else "N/A"
        sub_count = rates.get("n_substituted", 0)
        sub_line = f" (substituted={sub_count})" if sub_count > 0 else ""
        print(
            f"{group_name:<25} {n_attempted:>12} {n_valid:>10} "
            f"{sub_s} "
            f"{quar_s} "
            f"{tout_s}{sub_line}"
        )

    # Identify baseline group for delta table (FR-R5-049)
    baseline_group = None
    # With recipe_id, CONTROL is baseline.
    if use_recipe_id_for_baseline and "CONTROL" in group_rates:
        baseline_group = "CONTROL"
    # Legacy fallback.
    elif "BASELINE" in group_rates:
        baseline_group = "BASELINE"

    # --- Delta table (FR-R5-049) ---
    if baseline_group:
        baseline_rates = group_rates[baseline_group]
        print(f"\n{'='*60}")
        print(f"Delta Table: each group vs {baseline_group} (FR-R5-049)")
        print(f"{'='*60}")
        print(
            f"{'Group':<25} {'Delta (submit)':>16} {'Delta (quarantine)':>18} "
            f"{'Delta (timeout)':>15} {'Delta (unreconciled)':>20}"
        )
        print("-" * 80)

        for group_name in sorted(group_rates.keys()):
            if group_name == baseline_group:
                continue
            rates = group_rates[group_name]
            # Skip groups with no effectiveness data (n_valid == 0) — and a
            # baseline with n_valid == 0 makes every delta undefined.
            no_group_rates = "submission_rate" not in rates
            no_baseline = "submission_rate" not in baseline_rates
            if no_group_rates or no_baseline:
                reason = "baseline n_valid=0" if no_baseline else "group n_valid=0"
                print(
                    f"{group_name:<25} {'N/A (' + reason + ')':>16} {'N/A':>18} "
                    f"{'N/A':>15} {'N/A':>20}"
                )
                continue
            sub_delta = (
                rates["submission_rate"][0] - baseline_rates["submission_rate"][0]
            )
            quar_delta = (
                rates["quarantine_rate"][0] - baseline_rates["quarantine_rate"][0]
            )
            tout_delta = (
                rates["timeout_rate"][0] - baseline_rates["timeout_rate"][0]
            )
            unr_delta = (
                rates["unreconciled_rate"][0] - baseline_rates["unreconciled_rate"][0]
            )
            print(
                f"{group_name:<25} "
                f"{sub_delta:>15.4f} "
                f"{quar_delta:>17.4f} "
                f"{tout_delta:>14.4f} "
                f"{unr_delta:>19.4f}"
            )

    # --- FR-R6-071: human/control false-positive analysis ---
    control_runs = [
        r for r in runs
        if isinstance(r.get("agent"), str) and r["agent"].startswith("human")
    ]
    if control_runs:
        print(f"\n{'='*60}")
        print("Human control false-positive analysis (FR-R6-071)")
        print(f"{'='*60}")
        print(f"{'Control':<25} {'N_valid':>10} {'Quarantine':>12} {'Review':>10} {'Causal-hit':>12}")
        print("-" * 65)
        # Slice by control variant when the runner recorded one (agent id
        # suffix or fixture/mode field); fall back to a single row.
        variants = defaultdict(list)
        for r in control_runs:
            agent = r.get("agent", "human")
            variant = r.get("control_variant") or agent.replace("human-", "").replace("human", "normal")
            variants[variant].append(r)
        for variant, rs in sorted(variants.items()):
            rates = compute_rates(rs, len(rs))
            if "quarantine_rate" not in rates:
                continue
            # Causal canary hit = server-verified (canary_verified_server
            # is True), not merely quarantined by disposition.
            causal = sum(
                1 for r in rs
                if r.get("canary_verified_server") is True
            )
            print(
                f"{variant:<25} {rates['n_valid']:>10} "
                f"{rates['quarantine_rate'][0]*100:>10.1f}% "
                f"{rates['review_rate'][0]*100:>8.1f}% "
                f"{causal:>12}"
            )

    # --- FR-R6-072: cross-sectional breakdown ---
    # P2: objective/fixture_id/tier slices join the report whenever the run
    # carries those dimensions (legacy records show "<missing>" once each
    # and the len<=1 guard suppresses the table).
    for dimension in ("agent", "model", "template", "objective", "fixture_id", "tier"):
        sliced = group_cross_sectional(runs, dimension)
        if len(sliced) <= 1:
            continue
        print(f"\nCross-sectional by {dimension} (FR-R6-072):")
        print(f"  {dimension.capitalize():<23} {'N_att':>8} {'N_valid':>8} {'Submit':>8} {'Quarantine':>11}")
        print("  " + "-" * 60)
        for slice_name, slice_runs in sorted(sliced.items()):
            rates = compute_rates(slice_runs, len(slice_runs))
            if not rates:
                continue
            sub = rates.get("submission_rate", (0, 0, 0))
            quar = rates.get("quarantine_rate", (0, 0, 0))
            print(
                f"  {slice_name:<23} {rates['n_attempted']:>8} {rates['n_valid']:>8} "
                f"{sub[0]*100:>6.1f}% {quar[0]*100:>9.1f}%"
            )

    # --- Exposure breakdown by perception surface (FR-R7-004) ---
    print(f"\n{'='*60}")
    print("Exposure breakdown by perception surface (FR-R7-004)")
    print(f"{'='*60}")
    # Tally (state, surface) pairs across all runs.
    exposure_counts = defaultdict(int)
    for r in runs:
        try:
            state, surface = exposure_view(r)
        except Exception:
            continue
        exposure_counts[(state, surface)] += 1

    # Print: rows = perception_surface (null for UNMEASURED/no-surface).
    print(f"{'Surface':<35} {'EXPOSED':>10} {'NOT_EXPOSED':>12} {'UNMEASURED':>12}")
    print("-" * 65)

    # Collect unique surfaces, keeping null last.
    surfaces = sorted(
        {s for _, s in exposure_counts.keys() if s is not None}
    )
    # Row for null surface (UNMEASURED with no perception surface).
    for surf in surfaces + [None]:
        exposed = exposure_counts.get(("EXPOSED", surf), 0)
        not_exposed = exposure_counts.get(("NOT_EXPOSED", surf), 0)
        unmeasured = exposure_counts.get(("UNMEASURED", surf), 0)
        # Only print the row if at least one count is non-zero.
        if exposed + not_exposed + unmeasured == 0:
            continue
        label = surf if surf is not None else "(null)"
        print(f"  {label:<35} {exposed:>10} {not_exposed:>12} {unmeasured:>12}")

    # Overall exposure summary.
    total_exposed = sum(c for (st, _), c in exposure_counts.items() if st == "EXPOSED")
    total_not_exposed = sum(c for (st, _), c in exposure_counts.items() if st == "NOT_EXPOSED")
    total_unmeasured = sum(c for (st, _), c in exposure_counts.items() if st == "UNMEASURED")
    print(f"  {'TOTAL':<35} {total_exposed:>10} {total_not_exposed:>12} {total_unmeasured:>12}")

    # --- Overall (all runs combined) ---
    overall = compute_rates(runs, len(runs))
    if overall:
        print(f"\n{'OVERALL':<25} {overall['n_attempted']:>12} {overall['n_valid']:>10} "
              f"{overall['submission_rate'][0]*100:>8.1f}% "
              f"{overall['quarantine_rate'][0]*100:>10.1f}% "
              f"{overall['timeout_rate'][0]*100:>8.1f}%")

        print(f"\n95% confidence intervals (Wilson):")
        for metric in [
            "submission_rate", "undetected_rate", "stop_rate", "quarantine_rate",
            "exposure_coverage", "measured_exposure_rate", "canary_request_rate",
            "canary_reference_rate", "canary_verified_rate",
        ]:
            if metric not in overall:
                continue
            val, lo, hi = overall[metric]
            print(f"  {metric:<25} {val*100:>6.1f}%  [{lo*100:.1f}%, {hi*100:.1f}%]")


def print_endpoints(
    experiment_id: str,
    records_dir: str | None = None,
    allow_incomplete: bool = False,
):
    """
    P1-26: endpoints report.

    PRIMARY endpoint = ORIGIN account-creation rate (the ordinary upstream's
    own ledger). For each defended condition vs CONTROL, print absolute +
    relative risk reduction with propagated CIs — computed on the origin
    endpoint when origin truth exists (P0-5), explicitly labeled as the
    submission proxy otherwise. Origin measurement coverage (P0-6) is
    reported per arm; a coverage the origin-ledger protocol cannot justify
    INVALIDATES the endpoint and is said so in the output. Then print the
    human-control false-positive UPPER bound (never a "zero" claim).
    Secondary endpoints (legit completion, REVIEW/QUARANTINE, retry success,
    causal hits, stop/handoff, errors/timeouts, p50/p95 latency, storage
    cost) are summarized from compute_rates per group.
    """
    runs = load_runs(experiment_id, records_dir)
    if not runs:
        return

    print(f"\n{'='*70}")
    print(f"FireRaid Endpoints Report: {experiment_id}")
    print(f"{'='*70}")

    # ── P0-AUDIT-3 (P0-2): completeness gate ────────────────────────────────
    # A dataset the runner never drove to a terminal state for every
    # scheduled trial — or whose record set disagrees with its declaration —
    # is an interrupted experiment. Printing headline ARR/RRR from it
    # invites exactly the confound this gate exists to prevent (partial
    # runs leave arms with different attacker-architecture mixes). The
    # operational summary below is always honest; the EFFICACY table is
    # what gets withheld.
    completeness = experiment_completeness(experiment_id, records_dir)
    allow_note = ""
    if not completeness["complete"]:
        print(f"\n  *** {INCOMPLETE_WATERMARK} ***")
        print(f"  Reason: {completeness['reason']}")
        decl = completeness.get("declaration") or {}
        if decl.get("planned_trials") is not None:
            print(
                f"  planned_trials={decl.get('planned_trials')}"
                + (
                    f", records_expected={decl.get('records_expected')}, "
                    f"records_present={decl.get('records_present')}"
                    if decl.get("records_expected") is not None
                    else ""
                )
            )
        print(
            "  Errors/timeouts are valid ITT outcomes; an INTERRUPTED "
            "experiment is not. Re-run to completion (or resume) before\n"
            "  estimating efficacy."
        )
        if not allow_incomplete:
            print(
                "\n  Headline ARR/RRR withheld. Operational summary only.\n"
                "  (Re-run with --allow-incomplete-diagnostics to override — "
                "output stays watermarked.)\n"
            )
            _print_operational_summary(runs)
            return
        allow_note = (
            "  (--allow-incomplete-diagnostics: operational diagnostics "
            "below are STILL NOT AN EFFICACY ESTIMATE)\n"
        )
    elif allow_incomplete:
        allow_note = ""

    if allow_note:
        print(allow_note)

    groups = group_runs(runs)
    if "CONTROL" not in groups:
        print("No CONTROL group found — cannot compute defended-minus-control deltas.")
        return

    control = groups["CONTROL"]

    # P0-6: for a dataset DECLARED origin-ledger, incomplete origin coverage
    # on assignable trials invalidates the primary endpoint — the report
    # says so prominently instead of rendering a diluted rate.
    declaration = load_declaration(experiment_id, records_dir)
    if origin_endpoint_is_required(declaration):
        all_assignable = [r for r in runs if is_assignable(r)]
        n_elig = len(origin_eligible(runs))
        if all_assignable and n_elig < len(all_assignable):
            print(
                f"\n  *** ORIGIN ENDPOINT INVALID (P0-6): experiment is declared\n"
                f"  origin-ledger but only {n_elig}/{len(all_assignable)} assignable\n"
                f"  trials carry origin truth. The endpoint is NOT reported as an\n"
                f"  efficacy result; re-run the missing trials or exclude them via\n"
                f"  the classified-infrastructure protocol. ***\n"
            )

    # P0-5: the primary endpoint is the ORIGIN ledger. The submission proxy
    # prints alongside it whenever both are measurable — the two MUST be
    # allowed to diverge (a forwarded submission is not a created account).
    control_origin_n = len(origin_eligible(control))
    using_origin = control_origin_n > 0 or any(
        len(origin_eligible(rs)) > 0 for name, rs in groups.items() if name != "CONTROL"
    )
    rate_fn = account_creation_rate if using_origin else submission_proxy_rate
    basis_label = (
        "origin account-creation (PRIMARY)"
        if using_origin
        else "submission proxy (NO origin truth in dataset — NOT account creation)"
    )

    c_rate, c_lo, c_hi = rate_fn(control)
    print(f"\nPRIMARY endpoint: {basis_label}")
    print(f"  CONTROL: {c_rate*100:.1f}% [{c_lo*100:.1f}%, {c_hi*100:.1f}%]  (n_eligible={len([r for r in origin_eligible(control) if is_assignable(r)])}, n_valid={sum(1 for r in control if is_valid_run(r))})")
    # P0-6: coverage, always visible for the primary endpoint.
    cov, cov_lo, cov_hi = origin_measurement_coverage(control)
    print(f"  CONTROL origin measurement coverage: {cov*100:.1f}% [{cov_lo*100:.1f}%, {cov_hi*100:.1f}%] (eligible/assignable)")
    # P0-5 divergence visibility: the proxy prints next to the origin truth.
    if using_origin:
        p_rate, p_lo, p_hi = submission_proxy_rate(control)
        print(
            f"  CONTROL submission proxy (secondary, for divergence): "
            f"{p_rate*100:.1f}% [{p_lo*100:.1f}%, {p_hi*100:.1f}%]"
        )
    print(f"  {'Condition':<22} {'Defended%':>10} {'ARR':>10} {'RRR':>10}  {'ARR 95% CI':>18}")
    print("  " + "-" * 72)
    for name in sorted(groups.keys()):
        if name == "CONTROL":
            continue
        defended = groups[name]
        # P0-AUDIT-3 (P0-2): the headline comparative estimate uses MATCHED
        # cells only — a cell (all trial dimensions except the condition)
        # contributes only when BOTH arms carry it. Unmatched defended
        # cells would silently change the attacker mix across arms.
        m_control, m_defended, unmatched = matched_cells(control, defended)
        if unmatched:
            print(
                f"  {name:<22} NOTE: {len(unmatched)} cell(s) have no CONTROL "
                f"twin — excluded from ARR/RRR (matched n={len(m_defended)})"
            )
        if not m_defended:
            print(
                f"  {name:<22} NO MATCHED CELLS — no comparative estimate "
                f"(every defended cell lacks its CONTROL twin)"
            )
            continue
        rr = risk_reduction(m_control, m_defended)
        d_rate = rr["defended_rate"][0]
        arr = rr["arr"][0]
        rrr = rr["rrr"][0]
        arr_ci = f"[{rr['arr'][1]*100:.1f}%, {rr['arr'][2]*100:.1f}%]"
        rrr_s = f"{rrr*100:.1f}%" if rrr is not None else "n/a"
        print(f"  {name:<22} {d_rate*100:>9.1f}% {arr*100:>9.1f}% {rrr_s:>10}  {arr_ci:>18}")
        # Per-arm coverage: a defended arm measured on 60% of its trials is
        # not an efficacy result.
        arm_cov = origin_measurement_coverage(m_defended)[0]
        if using_origin and arm_cov < 1.0:
            n_assign = len([r for r in m_defended if is_assignable(r)])
            n_elig = len([r for r in origin_eligible(m_defended) if is_assignable(r)])
            print(
                f"  {'':22} WARNING: origin coverage {arm_cov*100:.1f}% "
                f"({n_elig}/{n_assign} assignable measured) — unmeasured "
                f"trials are EXCLUDED, not counted as blocks"
            )
    if using_origin:
        print(
            f"\n  endpoint basis: {risk_reduction(control, groups[sorted(k for k in groups if k != 'CONTROL')[0]])['endpoint_basis']}"
            if len(groups) > 1
            else "\n  endpoint basis: origin_account_creation"
        )

    # Human-control false-positive upper bound (honest, never "zero").
    human_control = [r for r in control if str(r.get("agent", "")).startswith("human")]
    if human_control:
        flagged, n, ub = false_positive_upper_bound(human_control)
        print(f"\nHuman-control false-positive UPPER bound (98% CI one-sided):")
        print(f"  observed quarantined legit runs: {flagged}/{n}")
        print(f"  => at most {ub*100:.2f}% (98% CI upper) — NOT '0%'")

    # P1-AUDIT-2 (P1-18): legitimate-user FP per DEFENDED condition.
    # CONTROL answers "does the base flow work?"; only defended arms answer
    # "does FireRaid incorrectly impede legitimate users?". Host enforcement
    # blocks REVIEW too (fail-closed admission), so a legitimate REVIEW is a
    # user-impacting FP event even when it is not a QUARANTINE — both are
    # counted, REVIEW listed separately.
    human_defended = [
        r
        for name, rs in groups.items()
        if name != "CONTROL"
        for r in rs
        if str(r.get("agent", "")).startswith("human")
    ]
    if human_defended:
        print(f"\nDefended-condition human false positives (P1-18):")
        print(f"  {'Condition':<22} {'N_human':>8} {'Quar':>6} {'Rev':>6} {'FP%':>8} {'FP UB%':>8} {'Acct%':>8}")
        print("  " + "-" * 66)
        for name in sorted(groups.keys()):
            if name == "CONTROL":
                continue
            hs = [r for r in groups[name] if str(r.get("agent", "")).startswith("human")]
            if not hs:
                continue
            quar = sum(1 for r in hs if r.get("disposition") == "QUARANTINE")
            rev = sum(1 for r in hs if r.get("disposition") == "REVIEW")
            n = len(hs)
            fp = quar + rev
            # Reuse the honest one-sided bound over the FP count: build a
            # pseudo-run list with disposition REVIEW for the extra FPs so
            # the bound counts BOTH blocking dispositions, not just QUARANTINE.
            bounded = []
            for r in hs:
                rr = dict(r)
                if rr.get("disposition") == "REVIEW":
                    rr["disposition"] = "QUARANTINE"
                bounded.append(rr)
            _, _, fp_ub = false_positive_upper_bound(bounded)
            acct = sum(
                1 for r in hs if r.get("origin_account_created") is True
            )
            fp_rate = fp / n if n else 0.0
            print(
                f"  {name:<22} {n:>8} {quar:>6} {rev:>6} "
                f"{fp_rate*100:>7.1f}% {fp_ub*100:>7.1f}% "
                f"{(acct / n * 100 if n else 0):>7.1f}%"
            )
    missing_human = sorted(
        name
        for name in groups.keys()
        if name != "CONTROL"
        and not any(
            str(r.get("agent", "")).startswith("human") for r in groups[name]
        )
    )
    if missing_human:
        print(f"  P1-18 NOTE: no human runs under: {', '.join(missing_human)}")
        print("  (defended-legit-user FP is UNMEASURED there — CONTROL's bound does not transfer)")

    # Secondary endpoints per defended group.
    print(f"\nSECONDARY endpoints per condition:")
    print(f"  {'Condition':<22} {'N_valid':>8} {'Submit%':>9} {'Rev%':>7} {'Quar%':>7} {'Stop%':>7} {'Hand%':>7} {'Err%':>7}")
    print("  " + "-" * 70)
    for name in sorted(groups.keys()):
        g = groups[name]
        rates = compute_rates(g, len(g))
        if not rates:
            continue
        sub = rates.get("submission_rate", (0, 0, 0))[0]
        rev = rates.get("review_rate", (0, 0, 0))[0]
        quar = rates.get("quarantine_rate", (0, 0, 0))[0]
        stop = rates.get("stop_rate", (0, 0, 0))[0]
        hand = rates.get("handoff_rate", (0, 0, 0))[0]
        err = rates.get("error_rate", (0, 0, 0))[0]
        print(f"  {name:<22} {rates['n_valid']:>8} {sub*100:>8.1f}% {rev*100:>6.1f}% {quar*100:>6.1f}% {stop*100:>6.1f}% {hand*100:>6.1f}% {err*100:>6.1f}%")


def _print_operational_summary(runs: list):
    """
    P0-AUDIT-3 (P0-2): the diagnostic view printed for INCOMPLETE datasets —
    counts and data-quality state only, never a treatment-effect estimate.
    Everything here describes what EXISTS on disk; nothing compares arms.
    """
    groups = group_runs(runs)
    print(f"  Dataset: {len(runs)} record(s), {len(groups)} condition group(s)")
    print(f"  {'Condition':<22} {'N':>6} {'Sub%':>7} {'Err%':>7} {'Timeout%':>9}")
    print("  " + "-" * 56)
    for name in sorted(groups.keys()):
        g = groups[name]
        n = len(g)
        sub = sum(1 for r in g if r.get("submitted") is True)
        err = sum(1 for r in g if r.get("outcome") == "error")
        tmo = sum(1 for r in g if r.get("outcome") == "timeout")
        pct = lambda k: (k / n * 100) if n else 0.0
        print(
            f"  {name:<22} {n:>6} {pct(sub):>6.1f}% {pct(err):>6.1f}% {pct(tmo):>8.1f}%"
        )
    # Attacker-architecture mix per arm — the confound that makes partial
    # datasets structurally incomparable.
    by_agent = defaultdict(lambda: defaultdict(int))
    for r in runs:
        by_agent[r.get("recipe_id") or "NO_RECIPE"][r.get("agent", "?")] += 1
    if by_agent:
        print("\n  Attacker-architecture mix per condition (the mix a partial")
        print("  run silently skews — comparative estimates require it balanced):")
        for cond in sorted(by_agent):
            mix = ", ".join(f"{a}×{n}" for a, n in sorted(by_agent[cond].items()))
            print(f"    {cond:<22} {mix}")


def export_csv(experiment_id: str, output_path: str, records_dir: str | None = None):
    runs = load_runs(experiment_id, records_dir)
    if not runs:
        return
    import csv
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=runs[0].keys())
        writer.writeheader()
        writer.writerows(runs)
    print(f"Exported {len(runs)} runs to {output_path}")


def _cli_value(argv: list, flag: str):
    """Return the value following ``flag`` in argv, or None."""
    if flag in argv:
        return argv[argv.index(flag) + 1]
    return None


if __name__ == "__main__":
    if len(sys.argv) < 2 or "--help" in sys.argv or "-h" in sys.argv:
        print(
            "Usage: python3 analyze.py <experiment_id> "
            "[--records-dir DIR] [--csv output.csv] [--strict] "
            "[--allow-incomplete-diagnostics]"
        )
        if len(sys.argv) >= 2:
            print(
                "\n--records-dir DIR analyzes an archived records directory "
                "(e.g. harness/evidence/pilot/records/exp-pilot-control)\n"
                "directly instead of harness/results/<experiment_id>.\n"
                "\n--allow-incomplete-diagnostics prints the full endpoint "
                "layout for an INCOMPLETE experiment, watermarked "
                "NOT-AN-EFFICACY-ESTIMATE. The comparative table is computed "
                "over matched cells only."
            )
        sys.exit(1 if len(sys.argv) < 2 else 0)

    exp_id = sys.argv[1]
    records_dir = _cli_value(sys.argv, "--records-dir")
    allow_incomplete = "--allow-incomplete-diagnostics" in sys.argv
    if "--csv" in sys.argv:
        idx = sys.argv.index("--csv")
        export_csv(exp_id, sys.argv[idx + 1], records_dir)
    elif "--endpoints" in sys.argv:
        print_endpoints(exp_id, records_dir, allow_incomplete)
    else:
        print_report(exp_id, records_dir)
        # FR-R6-074: official reports must fail if any authoritative run
        # cannot be reconciled — an unreconciled run is a hole in the
        # record, not a data point.
        if "--strict" in sys.argv:
            runs = load_runs(exp_id, records_dir)
            unreconciled = [r for r in runs if not r.get("server_reconciled")]
            if unreconciled:
                print(
                    f"STRICT: {len(unreconciled)}/{len(runs)} runs are NOT "
                    f"server-reconciled — failing report (FR-R6-074)"
                )
                sys.exit(2)
