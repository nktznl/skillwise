#!/usr/bin/env python3
"""Measure discovery quality against the ground truth in cases.json.

Runs the real pipeline against the live ecosystem, so results move as the
ecosystem moves. That is deliberate: a discovery tool that only passes against a
frozen fixture is not being tested on the job it actually does.

  python3 evals/run_eval.py            # all cases
  python3 evals/run_eval.py --case pdf # one case
"""
import argparse, importlib.util, json, os, statistics, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "ds", os.path.join(HERE, "..", "skills", "skill-scout", "scripts", "discover_skills.py"))
ds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ds)


def matches(cand, want):
    if "repo" in want and cand["repo"].lower() != want["repo"].lower():
        return False
    return cand["name"].lower() == want["name"].lower()


def run_case(case, k):
    t0 = time.time()
    results, coverage = ds.discover(case["queries"], max(k, 10))
    top_k, top_10 = results[:k], results[:10]

    ranks = [i + 1 for i, c in enumerate(top_k)
             for w in case["expect"] if matches(c, w)]
    hit = bool(ranks)
    mrr = 1.0 / min(ranks) if ranks else 0.0
    violations = [f'{c["name"]} ({c["repo"]})' for c in top_10
                  for w in case["forbid"] if matches(c, w)]

    return {
        "id": case["id"], "queries": case["queries"],
        "expected": len(case["expect"]), "hit": hit or not case["expect"],
        "rank": min(ranks) if ranks else None, "mrr": round(mrr, 3),
        "violations": violations, "clean": not violations,
        "coverage": coverage, "seconds": round(time.time() - t0, 1),
        "top": [{"rank": i + 1, "name": c["name"], "repo": c["repo"],
                 "score": c["score"], "fit": c["signals"]["fit"]}
                for i, c in enumerate(top_k)],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case")
    ap.add_argument("--json", action="store_true", help="emit raw results")
    args = ap.parse_args()

    spec_data = json.load(open(os.path.join(HERE, "cases.json")))
    k = spec_data["k"]
    cases = [c for c in spec_data["cases"] if not args.case or c["id"] == args.case]

    rows = []
    for case in cases:
        r = run_case(case, k)
        rows.append(r)
        if args.json:
            continue
        status = "PASS" if r["hit"] and r["clean"] else "FAIL"
        detail = f'rank {r["rank"]}' if r["rank"] else ("no expectation" if not case["expect"] else "MISS")
        print(f'{status}  {r["id"]:<16} {detail:<16} {r["seconds"]:>5}s  '
              f'{r["coverage"]["repos_found"]:>4} repos -> {r["coverage"]["skills_read"]:>4} skills read')
        if r["violations"]:
            print(f'      forbidden in top 10: {", ".join(r["violations"])}')
        if case["expect"] and not r["rank"]:
            print("      top: " + ", ".join(f'{t["name"]}({t["score"]})' for t in r["top"]))

    if args.json:
        print(json.dumps(rows, indent=2))
        return

    passed = sum(1 for r in rows if r["hit"] and r["clean"])
    scored = [r["mrr"] for r in rows if r["expected"]]
    print("\n" + "-" * 62)
    print(f'pass {passed}/{len(rows)}   '
          f'MRR {statistics.mean(scored):.3f}   '
          f'clean {sum(1 for r in rows if r["clean"])}/{len(rows)}   '
          f'{sum(r["seconds"] for r in rows):.0f}s total')
    sys.exit(0 if passed == len(rows) else 1)


if __name__ == "__main__":
    main()
