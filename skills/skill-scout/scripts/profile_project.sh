#!/usr/bin/env bash
# Profile the current project so skill discovery can target real gaps instead of guesses.
# Emits JSON on stdout. Never fails the caller: unknown is a valid answer.
set -uo pipefail

ROOT="${1:-$PWD}"
cd "$ROOT" 2>/dev/null || { echo '{"error":"unreadable root"}'; exit 0; }

PRUNE='-name node_modules -o -name .git -o -name dist -o -name build -o -name vendor -o -name .venv -o -name venv -o -name target -o -name .next -o -name __pycache__ -o -name .terraform'

# --- file census (depth-limited: a profile, not an inventory) ---
FILES=$(find . \( $PRUNE \) -prune -o -type f -print 2>/dev/null | head -20000)
count() { printf '%s\n' "$FILES" | grep -ciE "$1" 2>/dev/null | head -1; }
has()   { printf '%s\n' "$FILES" | grep -qiE "$1" 2>/dev/null && echo true || echo false; }

# --- manifest contents, concatenated once and reused for dependency sniffing ---
MANIFESTS=$(printf '%s\n' "$FILES" | grep -iE '/(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|pubspec\.yaml|Package\.swift|mix\.exs)$' | head -40)
DEPS=""
for m in $MANIFESTS; do DEPS="$DEPS
$(head -c 60000 "$m" 2>/dev/null)"; done
dep() { printf '%s' "$DEPS" | grep -qiE "$1" && echo true || echo false; }

json_list() { # emit a JSON array from newline-separated stdin
  python3 -c 'import sys,json;print(json.dumps([l for l in sys.stdin.read().split("\n") if l.strip()]))' 2>/dev/null || echo '[]'
}

LANGS=$(for pat in "ts:\.tsx?$" "js:\.[cm]?jsx?$" "python:\.py$" "go:\.go$" "rust:\.rs$" "ruby:\.rb$" "php:\.php$" "java:\.java$" "kotlin:\.kts?$" "csharp:\.cs$" "swift:\.swift$" "dart:\.dart$" "elixir:\.exs?$" "sql:\.sql$" "shell:\.(sh|bash|zsh)$" "notebook:\.ipynb$"; do
  n=$(count "${pat#*:}"); [ "$n" -gt 0 ] && echo "${pat%%:*}:$n"
done | sort -t: -k2 -rn | head -6 | cut -d: -f1 | json_list)

detect() { # detect "label:regex" pairs against $DEPS and $FILES
  for pair in "$@"; do
    label="${pair%%:*}"; rx="${pair#*:}"
    if printf '%s' "$DEPS" | grep -qiE "$rx" || printf '%s\n' "$FILES" | grep -qiE "$rx"; then echo "$label"; fi
  done | json_list
}

FRAMEWORKS=$(detect "next:\"next\"|/next\.config" "react:\"react\"" "vue:\"vue\"" "svelte:\"svelte\"" "angular:\"@angular/core\"" "astro:\"astro\"" "remix:\"@remix-run" "nuxt:\"nuxt\"" \
  "django:django" "flask:^flask|\bflask\b" "fastapi:fastapi" "rails:\brails\b" "laravel:laravel/framework" "spring:spring-boot" "express:\"express\"" "nestjs:\"@nestjs/core\"" "electron:\"electron\"" "react-native:\"react-native\"" "flutter:\bflutter\b")
TESTING=$(detect "jest:\"jest\"" "vitest:\"vitest\"" "playwright:playwright" "cypress:\"cypress\"" "pytest:pytest" "rspec:rspec" "testing-library:@testing-library" "go-test:_test\.go$" "junit:junit")
INFRA=$(detect "docker:/Dockerfile|docker-compose" "kubernetes:/k8s/|/kubernetes/|\.helm|Chart\.yaml$" "terraform:\.tf$" "pulumi:Pulumi\.yaml$" "serverless:serverless\.yml$" "github-actions:\.github/workflows/" "gitlab-ci:\.gitlab-ci\.yml$" "circleci:\.circleci/")
DATA=$(detect "prisma:prisma" "drizzle:drizzle-orm" "sqlalchemy:sqlalchemy" "typeorm:typeorm" "alembic:alembic" "postgres:postgres|pg\b" "mongodb:mongodb|mongoose" "redis:\bredis\b" "supabase:supabase" "firebase:firebase" "bigquery:bigquery" "dbt:dbt-core")
CLOUD=$(detect "aws:aws-sdk|boto3" "gcp:google-cloud" "azure:azure-sdk|@azure/" "vercel:vercel" "cloudflare:wrangler|cloudflare" "stripe:\bstripe\b" "twilio:twilio" "sentry:@sentry|sentry-sdk")
AIML=$(detect "anthropic:anthropic|claude-" "openai:\bopenai\b" "langchain:langchain" "pytorch:\btorch\b" "tensorflow:tensorflow" "pandas:\bpandas\b" "huggingface:transformers|huggingface" "mcp:modelcontextprotocol|\bmcp\b")

EXISTING_SKILLS=$(find .claude/skills ~/.claude/skills -maxdepth 2 -name SKILL.md 2>/dev/null | sed 's|/SKILL.md$||;s|.*/||' | sort -u | json_list)
PLUGIN_MARKETPLACES=$(find . -maxdepth 3 -path ./node_modules -prune -o -name marketplace.json -print 2>/dev/null | json_list)

python3 - "$LANGS" "$FRAMEWORKS" "$TESTING" "$INFRA" "$DATA" "$CLOUD" "$AIML" "$EXISTING_SKILLS" "$PLUGIN_MARKETPLACES" <<PY
import json, sys, os
k = ["languages","frameworks","testing","infra","data","cloud","ai_ml","existing_skills","marketplaces"]
out = {}
for key, raw in zip(k, sys.argv[1:]):
    try: out[key] = json.loads(raw)
    except Exception: out[key] = []
out["root"] = os.path.abspath("$ROOT")
out["file_count"] = $(printf '%s\n' "$FILES" | grep -c . | head -1)
out["agent_setup"] = {
    "claude_md": os.path.exists("CLAUDE.md"),
    "agents_md": os.path.exists("AGENTS.md"),
    "dot_claude": os.path.isdir(".claude"),
    "cursor_rules": os.path.isdir(".cursor"),
}
out["signals"] = {
    "has_tests": bool(out["testing"]),
    "has_ci": any(x in out["infra"] for x in ("github-actions","gitlab-ci","circleci")),
    "is_monorepo": os.path.exists("pnpm-workspace.yaml") or os.path.exists("turbo.json") or os.path.exists("nx.json") or os.path.exists("lerna.json"),
    "containerized": "docker" in out["infra"],
}
print(json.dumps(out, indent=2))
PY
