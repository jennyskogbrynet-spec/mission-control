#!/usr/bin/env python3
"""Propose retention actions for the Mission Control evidence root.

This script NEVER deletes, moves, compresses or otherwise mutates anything. It
reads the controller journal, decides which evidence bundles are closed, and
prints the commands a human would run. Deleting evidence is an approval gate
that belongs to Martin, so the script refuses to be told to act.

Classification
    closed        every journal worker whose receipt lives in the bundle is
                  terminal (completed | failed | cancelled)
    open          the journal records a non-terminal worker for the bundle
    unreferenced  the journal never mentions the bundle

Only `closed` bundles are ever proposed for anything. `open` and
`unreferenced` are retained: a bundle the journal cannot speak for is a bundle
we do not understand, and uncertainty preserves.

Buckets
    retain            younger than the archive age
    archive_proposed  closed and older than --archive-days (default 14):
                      propose a tar.zst plus a sha256 manifest so the bundle
                      stays verifiable after compression
    martin_review     closed and older than --review-days (default 90): too old
                      to archive silently; needs an explicit decision

Usage
    scripts/evidence-retention.py                 human-readable proposal
    scripts/evidence-retention.py --json          machine-readable proposal
    scripts/evidence-retention.py --root DIR      audit a different root

See docs/evidence-retention.md.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
import time

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
DEFAULT_EVIDENCE_ROOT = "~/.openclaw/mission-control/evidence"
DEFAULT_JOURNAL_ROOT = (
    "~/.openclaw/workspace/skills/babysential-backlog-orchestrator/.state/runs"
)
REFUSED_FLAGS = ("--apply", "--delete", "--force", "--rm", "--prune", "--execute")


def receipt_prefixes(evidence_root: str) -> list[str]:
    """Every spelling a recorded receiptRef may legitimately use.

    A journal records the path that existed when the worker ran, which may be
    the symlink in `~/tmp` rather than the durable root, and may be unresolved
    where the root itself resolves elsewhere (macOS `/var` -> `/private/var`).
    Matching only the resolved root would silently classify every closed bundle
    as unreferenced, which reads as "retain everything" - safe, but useless.
    """
    prefixes: list[str] = []
    for candidate in (evidence_root, os.path.expanduser("~/tmp")):
        for spelling in (candidate, os.path.realpath(candidate)):
            normalized = spelling.rstrip(os.sep) + os.sep
            if normalized not in prefixes:
                prefixes.append(normalized)
    return prefixes


def journal_index(journal_root: str, evidence_root: str) -> dict[str, list[dict]]:
    """Map bundle name -> the journal workers whose receipts live inside it."""
    index: dict[str, list[dict]] = {}
    prefixes = receipt_prefixes(evidence_root)
    for path in sorted(glob.glob(os.path.join(journal_root, "*.json"))):
        try:
            with open(path) as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            # An unreadable journal proves nothing; it must not make a bundle
            # look closed. Every bundle it would have covered stays unreferenced.
            continue
        for worker in data.get("workers") or []:
            ref = worker.get("receiptRef") or ""
            for prefix in prefixes:
                if ref.startswith(prefix):
                    bundle = ref[len(prefix) :].split(os.sep)[0]
                    index.setdefault(bundle, []).append(
                        {
                            "journal": os.path.basename(path),
                            "workerId": worker.get("workerId"),
                            "taskId": worker.get("taskId"),
                            "status": worker.get("status"),
                            "receiptRef": ref,
                            "receipt_exists": os.path.exists(ref),
                        }
                    )
                    break
    return index


def newest_mtime(path: str) -> float:
    newest = os.lstat(path).st_mtime
    if os.path.isdir(path) and not os.path.islink(path):
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                try:
                    newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
                except OSError:
                    pass
    return newest


def du_kb(path: str) -> int:
    try:
        out = subprocess.run(
            ["du", "-sk", path], capture_output=True, text=True, check=False
        ).stdout.split()
        return int(out[0]) if out else 0
    except (OSError, ValueError):
        return 0


def proposal_commands(path: str) -> list[str]:
    """Exact commands a human runs to archive one bundle, verifiably.

    The manifest is written first and the archive is read back before anything
    is removed, so the compression can be proven lossless rather than assumed.
    """
    name = os.path.basename(path.rstrip(os.sep))
    archive = f"{path.rstrip(os.sep)}.tar.zst"
    return [
        f"find {path!r} -type f -print0 | sort -z | xargs -0 shasum -a 256 > {path.rstrip(os.sep)}.sha256",
        f"tar --zstd -cf {archive!r} -C {os.path.dirname(path)!r} {name!r}",
        f"tar --zstd -tf {archive!r} > /dev/null   # read-back check",
        f"# then, and only with Martin's explicit go: rm -rf {path!r}",
    ]


def build_report(args: argparse.Namespace) -> dict:
    # The unresolved spelling is kept as well: a journal records the path that
    # existed when the worker ran, which is often the unresolved one.
    evidence_root_raw = os.path.expanduser(args.root)
    evidence_root = os.path.realpath(evidence_root_raw)
    journal_root = os.path.expanduser(args.journal_root)
    now = args.now if args.now is not None else time.time()

    index = journal_index(journal_root, evidence_root_raw)

    bundles = []
    if os.path.isdir(evidence_root):
        names = sorted(os.listdir(evidence_root))
    else:
        names = []

    for name in names:
        path = os.path.join(evidence_root, name)
        workers = index.get(name, [])
        statuses = sorted({w["status"] for w in workers})

        if not workers:
            state = "unreferenced"
        elif all(s in TERMINAL_STATUSES for s in statuses):
            state = "closed"
        else:
            state = "open"

        age_days = (now - newest_mtime(path)) / 86400.0

        if state != "closed":
            bucket = "retain"
            reason = f"{state}: only a journal-proven closed bundle is ever proposed"
        elif age_days > args.review_days:
            bucket = "martin_review"
            reason = (
                f"closed and {age_days:.1f} days old, past the {args.review_days}-day "
                "review threshold; needs an explicit decision from Martin"
            )
        elif age_days > args.archive_days:
            bucket = "archive_proposed"
            reason = (
                f"closed and {age_days:.1f} days old, past the {args.archive_days}-day "
                "archive threshold"
            )
        else:
            bucket = "retain"
            reason = f"closed but only {age_days:.1f} days old"

        bundles.append(
            {
                "name": name,
                "path": path,
                "state": state,
                "bucket": bucket,
                "reason": reason,
                "age_days": round(age_days, 2),
                "size_kb": du_kb(path),
                "journal_worker_statuses": statuses,
                "journal_workers": workers,
                "proposed_commands": (
                    proposal_commands(path) if bucket == "archive_proposed" else []
                ),
            }
        )

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now)),
        "evidence_root": evidence_root,
        "journal_root": journal_root,
        "thresholds": {
            "archive_days": args.archive_days,
            "review_days": args.review_days,
        },
        "mutating": False,
        "note": "This tool proposes only. It never deletes, moves or compresses anything.",
        "totals": {
            "bundles": len(bundles),
            "retain": sum(1 for b in bundles if b["bucket"] == "retain"),
            "archive_proposed": sum(
                1 for b in bundles if b["bucket"] == "archive_proposed"
            ),
            "martin_review": sum(1 for b in bundles if b["bucket"] == "martin_review"),
            "archive_proposed_size_kb": sum(
                b["size_kb"] for b in bundles if b["bucket"] == "archive_proposed"
            ),
        },
        "bundles": bundles,
    }


def render(report: dict) -> str:
    lines = [
        f"Evidence retention proposal - {report['generated_at']}",
        f"  root:    {report['evidence_root']}",
        f"  journal: {report['journal_root']}",
        f"  thresholds: archive > {report['thresholds']['archive_days']}d, "
        f"review > {report['thresholds']['review_days']}d",
        "  This tool proposes only. Nothing is deleted, moved or compressed.",
        "",
    ]
    totals = report["totals"]
    lines.append(
        f"{totals['bundles']} bundles: {totals['retain']} retain, "
        f"{totals['archive_proposed']} archive proposed "
        f"({totals['archive_proposed_size_kb'] / 1024:.1f} MB), "
        f"{totals['martin_review']} awaiting Martin"
    )
    lines.append("")
    for bundle in report["bundles"]:
        lines.append(
            f"[{bundle['bucket']}] {bundle['name']}  "
            f"({bundle['size_kb'] / 1024:.1f} MB, {bundle['age_days']:.1f}d, {bundle['state']})"
        )
        lines.append(f"    {bundle['reason']}")
        for command in bundle["proposed_commands"]:
            lines.append(f"    $ {command}")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    refused = [flag for flag in argv if flag in REFUSED_FLAGS]
    if refused:
        print(
            f"refusing {' '.join(refused)}: this tool never mutates the evidence root.\n"
            "Removing evidence is an approval gate. Run the printed commands yourself "
            "after Martin has agreed.",
            file=sys.stderr,
        )
        return 2

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--root",
        default=os.environ.get("MC_EVIDENCE_ROOT") or DEFAULT_EVIDENCE_ROOT,
        help="evidence root to audit (default: $MC_EVIDENCE_ROOT or %(default)s)",
    )
    parser.add_argument("--journal-root", default=DEFAULT_JOURNAL_ROOT)
    parser.add_argument("--archive-days", type=float, default=14.0)
    parser.add_argument("--review-days", type=float, default=90.0)
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    parser.add_argument(
        "--now", type=float, default=None, help="override the clock, for tests"
    )
    args = parser.parse_args(argv)

    if args.archive_days > args.review_days:
        print("--archive-days must not exceed --review-days", file=sys.stderr)
        return 2

    report = build_report(args)
    sys.stdout.write(json.dumps(report, indent=2) + "\n" if args.json else render(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
