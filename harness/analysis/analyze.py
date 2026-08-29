#!/usr/bin/env python3
"""
FireRaid analysis — compute rates, confidence intervals, and ablation tables.
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


def compute_rates(runs: list) -> dict:
    valid = [r for r in runs if not r.get("error_code")]
    if not valid:
        return {}
    n = len(valid)
    submitted = sum(1 for r in valid if r["outcome"] == "submitted")
    stopped = sum(1 for r in valid if r["outcome"] == "stopped")
    handoff = sum(1 for r in valid if r["outcome"] == "handoff")
    triggered = sum(1 for r in valid if r["canary_triggered"])
    quarantined = sum(1 for r in valid if r["disposition"] == "QUARANTINE")
    review = sum(1 for r in valid if r["disposition"] == "REVIEW")

    return {
        "n": n,
        "submission_rate": (submitted / n, *wilson_interval(submitted, n)),
        "stop_rate": (stopped / n, *wilson_interval(stopped, n)),
        "handoff_rate": (handoff / n, *wilson_interval(handoff, n)),
        "canary_trigger_rate": (triggered / n, *wilson_interval(triggered, n)),
        "quarantine_rate": (quarantined / n, *wilson_interval(quarantined, n)),
        "review_rate": (review / n, *wilson_interval(review, n)),
    }


def print_report(experiment_id: str):
    runs = load_runs(experiment_id)
    if not runs:
        return

    print(f"\n{'='*60}")
    print(f"FireRaid Experiment Report: {experiment_id}")
    print(f"{'='*60}")
    print(f"Total runs: {len(runs)}")

    # Group by agent
    by_agent = defaultdict(list)
    for r in runs:
        by_agent[r["agent"]].append(r)

    print(f"\n{'Agent':<20} {'N':>5} {'Submit':>10} {'Stop':>10} {'Canary':>10} {'Quarantine':>12}")
    print("-" * 70)

    for agent, agent_runs in sorted(by_agent.items()):
        rates = compute_rates(agent_runs)
        if not rates:
            continue
        n = rates["n"]
        sub = rates["submission_rate"]
        stop = rates["stop_rate"]
        can = rates["canary_trigger_rate"]
        quar = rates["quarantine_rate"]
        print(
            f"{agent:<20} {n:>5} "
            f"{sub[0]*100:>8.1f}% "
            f"{stop[0]*100:>8.1f}% "
            f"{can[0]*100:>8.1f}% "
            f"{quar[0]*100:>10.1f}%"
        )

    # Overall
    overall = compute_rates(runs)
    if overall:
        print(f"\n{'OVERALL':<20} {overall['n']:>5} "
              f"{overall['submission_rate'][0]*100:>8.1f}% "
              f"{overall['stop_rate'][0]*100:>8.1f}% "
              f"{overall['canary_trigger_rate'][0]*100:>8.1f}% "
              f"{overall['quarantine_rate'][0]*100:>10.1f}%")

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
