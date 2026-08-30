#!/usr/bin/env python3
"""
FireRaid analysis -- compute rates, confidence intervals, and ablation tables.
FR-INV-009: experiments must be reproducible.
"""
import json
import sys
import os
import glob
import math
from pathlib import Path
from collections import defaultdict

RESULTS_DIR = Path("harness/results")


def wilson_interval(successes: int, trials: int, z: float = 1.96) -> tuple:
    """Wilson score interval for a proportion. Returns (low, high)."""
    if trials == 0:
        return (0.0, 0.0)
    p = successes / trials
    denom = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denom
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * trials)) / trials) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def load_runs(experiment_id: str) -> list:
    dir_path = RESULTS_DIR / experiment_id
    if not dir_path.exists():
        print(f"No results found for {experiment_id}")
        return []
    runs = []
    for f in sorted(dir_path.glob("*.json")):
        with open(f) as fh:
            runs.append(json.load(fh))
    return runs


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
    # Determine if recipe_id is the canonical group signal.
    has_recipe_id = "recipe_id" in r and r["recipe_id"] is not None
    # We need the global decision (does *any* run have recipe_id?).  This is
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
    """
    return (
        r.get("server_reconciled") is True
        and r.get("outcome") in ("submitted", "stopped", "handoff")
    )


def compute_rates(runs: list, n_attempted: int) -> dict:
    """
    FR-R5-050: Separate denominator classes.

    OPERATIONAL rates (denominator = all *attempted* runs):
      error_rate, timeout_rate, unreconciled_rate

    EFFECTIVENESS rates (denominator = *valid* runs only):
      submission_rate, quarantine_rate, review_rate, canary rates, exposure rates

    Returns a dict with per-group counts and rate tuples (point, lo, hi).
    """
    n_valid = sum(1 for r in runs if is_valid_run(r))
    valid = [r for r in runs if is_valid_run(r)]

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
        submitted = sum(1 for r in valid if r["outcome"] == "submitted")
        stopped = sum(1 for r in valid if r["outcome"] == "stopped")
        handoff = sum(1 for r in valid if r["outcome"] == "handoff")
        triggered = sum(
            1 for r in valid if r.get("canary_triggered", r.get("canary_exposed", False))
        )
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
            1 for r in valid if r.get("canary_exposed", r.get("canary_triggered", False))
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
        effectiveness["canary_trigger_rate"] = (
            triggered / n_valid,
            *wilson_interval(triggered, n_valid),
        )
        effectiveness["quarantine_rate"] = (
            quarantined / n_valid,
            *wilson_interval(quarantined, n_valid),
        )
        effectiveness["review_rate"] = (
            review / n_valid,
            *wilson_interval(review, n_valid),
        )

        # Canary exposure rates (EFFECTIVENESS denominator)
        effectiveness["canary_exposure_rate"] = (
            canary_exposed_count / n_valid,
            *wilson_interval(canary_exposed_count, n_valid),
        )
        effectiveness["canary_issued_rate"] = (
            canary_issued_count / n_valid,
            *wilson_interval(canary_issued_count, n_valid),
        )

    return {
        "n": n_valid,
        "n_valid": n_valid,
        "n_attempted": n_attempted,
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


def print_report(experiment_id: str):
    runs = load_runs(experiment_id)
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
    print("    submission_rate, stop_rate, handoff_rate")
    print("    quarantine_rate, review_rate, canary_trigger_rate")
    print("    canary_exposure_rate, canary_issued_rate")

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
        print(
            f"{group_name:<25} {n_attempted:>12} {n_valid:>10} "
            f"{sub[0]*100:>8.1f}% "
            f"{quar[0]*100:>10.1f}% "
            f"{tout[0]*100:>8.1f}%"
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

    # --- Overall (all runs combined) ---
    overall = compute_rates(runs, len(runs))
    if overall:
        print(f"\n{'OVERALL':<25} {overall['n_attempted']:>12} {overall['n_valid']:>10} "
              f"{overall['submission_rate'][0]*100:>8.1f}% "
              f"{overall['quarantine_rate'][0]*100:>10.1f}% "
              f"{overall['timeout_rate'][0]*100:>8.1f}%")

        print(f"\n95% confidence intervals (Wilson):")
        for metric in ["submission_rate", "stop_rate", "canary_trigger_rate", "quarantine_rate"]:
            val, lo, hi = overall[metric]
            print(f"  {metric:<25} {val*100:>6.1f}%  [{lo*100:.1f}%, {hi*100:.1f}%]")


def export_csv(experiment_id: str, output_path: str):
    runs = load_runs(experiment_id)
    if not runs:
        return
    import csv
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=runs[0].keys())
        writer.writeheader()
        writer.writerows(runs)
    print(f"Exported {len(runs)} runs to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 analyze.py <experiment_id> [--csv output.csv]")
        sys.exit(1)

    exp_id = sys.argv[1]
    if "--csv" in sys.argv:
        idx = sys.argv.index("--csv")
        export_csv(exp_id, sys.argv[idx + 1])
    else:
        print_report(exp_id)
