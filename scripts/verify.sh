#!/usr/bin/env bash
# The verification gate.
#
# "The tests pass" says nothing about the tree as a whole. This script checks the
# things a reviewer cannot see by reading a diff: that no secret or internal
# working file is tracked, that no scraped-text path renders through innerHTML,
# that no host outside Instagram is contacted, that the pure modules stay pure,
# that colours are defined in exactly one file, and that every link in the
# README points at a file that exists.
#
# Usage: npm run verify   (or: bash scripts/verify.sh)
# Exits non-zero on the first group containing a failure.

set -u
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
SKIPPED=0

group() { printf '\n== %s ==\n' "$1"; }
ok()      { PASS=$((PASS + 1));   printf '  [ok]    %s\n' "$1"; }
bad()     { FAIL=$((FAIL + 1));   printf '  [FAIL]  %s\n' "$1"; }
skip()    { SKIPPED=$((SKIPPED + 1)); printf '  [skip]  %s\n' "$1"; }

# Tracked text files, excluding binaries we cannot meaningfully grep.
tracked_text() {
  git ls-files | grep -vE '\.(png|jpg|jpeg|gif|ico|woff2?)$' || true
}

# ---------------------------------------------------------------- 1. shape --
group '1. repository shape'

for f in README.md LICENSE .gitignore package.json SECURITY.md CONTRIBUTING.md docs/ARCHITECTURE.md docs/SAFETY.md; do
  if [ -f "$f" ]; then ok "present: $f"; else bad "missing: $f"; fi
done

if grep -qi 'MIT License' LICENSE && [ "$(wc -c < LICENSE)" -gt 800 ]; then
  ok 'LICENSE holds a full MIT text'
else
  bad 'LICENSE is missing or truncated'
fi

if node -e "const p=require('./package.json'); process.exit(p.type==='module' ? 0 : 1)"; then
  ok 'package.json is an ES-module package'
else
  bad 'package.json is not "type": "module"'
fi

if node -e "const p=require('./package.json'); const d=p.dependencies||{}; const dd=p.devDependencies||{}; process.exit(Object.keys(d).length+Object.keys(dd).length===0 ? 0 : 1)"; then
  ok 'zero runtime and dev dependencies'
else
  bad 'package.json declares dependencies'
fi

if node scripts/gen-icons.mjs --check > /dev/null 2>&1; then
  ok 'committed icons match scripts/gen-icons.mjs'
else
  bad 'committed icons are stale relative to the generator'
fi

# ---------------------------------------------------------------- 2. hygiene --
group '2. nothing private or internal in the tree'

if git ls-files | grep -E '(^|/)(_working_docs/|thinking/|node_modules/|dist/|build/)|(^|/)\.env($|\.)|\.pem$|\.key$|\.igcrm\.json$|(^|/)secrets\.json$' > /dev/null; then
  bad 'a working, secret or generated file is tracked:'
  git ls-files | grep -E '(^|/)(_working_docs/|thinking/|node_modules/|dist/|build/)|(^|/)\.env($|\.)|\.pem$|\.key$|\.igcrm\.json$|(^|/)secrets\.json$' | sed 's/^/          /'
else
  ok 'no working docs, secrets or generated artefacts are tracked'
fi

TOKEN_HITS=$(tracked_text | xargs -r grep -nE 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|BEGIN (OPENSSH|RSA|EC|PGP) PRIVATE KEY|sk-[A-Za-z0-9]{20,}' 2>/dev/null || true)
if [ -n "$TOKEN_HITS" ]; then
  bad 'token-shaped string in the tree:'
  printf '%s\n' "$TOKEN_HITS" | sed 's/^/          /'
else
  ok 'no token-shaped string in any tracked file'
fi

PATH_HITS=$(tracked_text | xargs -r grep -nE '/home/[a-z]|/Users/[A-Za-z]|C:\\\\[A-Za-z]' 2>/dev/null || true)
if [ -n "$PATH_HITS" ]; then
  bad 'absolute local path in the tree:'
  printf '%s\n' "$PATH_HITS" | sed 's/^/          /'
else
  ok 'no absolute local paths in any tracked file'
fi

# The gate itself is excluded: it has to spell the forbidden names in order to
# forbid them. .gitignore is excluded because it lists the same names as ignore
# rules. Both remain covered by the token and path scans above.
INTERNAL_HITS=$(tracked_text | grep -vE '^(\.gitignore|scripts/verify\.sh)$' | xargs -r grep -nE 'AGENT_RULES|IMPLEMENTATION_LOG|AUDIT_AND_TODO|NEXT_SESSIONS_ROADMAP|chunking mechanism|GAP-[0-9]{2}|DEC-0[0-9]|REQUIREMENTS_AND_PRODUCTION_VISION|CODE_COLLECTION_AND_ADAPTATION_PLAN' 2>/dev/null || true)
if [ -n "$INTERNAL_HITS" ]; then
  bad 'internal process reference in public text:'
  printf '%s\n' "$INTERNAL_HITS" | sed 's/^/          /'
else
  ok 'no internal process references in public text'
fi

# ------------------------------------------------------------- 3. code rules --
group '3. code safety invariants'

if [ -d src ]; then
  INNER=$(grep -rnE '\.innerHTML\s*=' src/ 2>/dev/null || true)
  if [ -n "$INNER" ]; then
    bad 'innerHTML assignment (scraped text is third-party input):'
    printf '%s\n' "$INNER" | sed 's/^/          /'
  else
    ok 'no innerHTML assignment in src/'
  fi

  DOCWRITE=$(grep -rnE 'document\.write|eval\(|new Function\(' src/ 2>/dev/null || true)
  if [ -n "$DOCWRITE" ]; then
    bad 'dynamic code or document injection in src/:'
    printf '%s\n' "$DOCWRITE" | sed 's/^/          /'
  else
    ok 'no document.write / eval / new Function in src/'
  fi

  HOSTS=$(grep -rhoE 'https?://[A-Za-z0-9.-]+' src/ 2>/dev/null | sort -u | grep -vE 'instagram\.com$|www\.w3\.org$|example\.com$' || true)
  if [ -n "$HOSTS" ]; then
    bad 'host outside instagram.com referenced in src/:'
    printf '%s\n' "$HOSTS" | sed 's/^/          /'
  else
    ok 'src/ references no host outside instagram.com'
  fi

  IMPURE=$(grep -rnE '\bchrome\.|\bdocument\.|\bwindow\.|localStorage' src/core src/storage 2>/dev/null || true)
  if [ -n "$IMPURE" ]; then
    bad 'browser API inside a pure module:'
    printf '%s\n' "$IMPURE" | sed 's/^/          /'
  else
    ok 'src/core and src/storage touch no browser API'
  fi

  BAD_CSS=$(find src -name '*.css' ! -path '*/design/tokens.css' 2>/dev/null | xargs -r grep -lE '#[0-9a-fA-F]{3,8}\b' 2>/dev/null || true)
  if [ -n "$BAD_CSS" ]; then
    bad 'hex colour declared outside design/tokens.css:'
    printf '%s\n' "$BAD_CSS" | sed 's/^/          /'
  else
    ok 'colours are declared only in design/tokens.css'
  fi
else
  skip 'src/ does not exist yet'
fi

# ------------------------------------------------------------------ 4. tests --
group '4. test suite'

if compgen -G 'tests/*.test.js' > /dev/null 2>&1; then
  if node --test tests/ > /tmp/igcrm-tests.log 2>&1; then
    ok "node --test tests/ passed ($(grep -c '^# pass' /tmp/igcrm-tests.log || true) report lines, see log for detail)"
  else
    bad 'node --test tests/ failed:'
    tail -n 20 /tmp/igcrm-tests.log | sed 's/^/          /'
  fi
else
  skip 'no test files yet (they land with the modules they guard)'
fi

# ---------------------------------------------------------------- 5. honesty --
group '5. README links resolve'

BADLINKS=0
while IFS= read -r link; do
  target=${link%%#*}
  [ -z "$target" ] && continue
  case "$target" in
    http*|mailto:*) continue ;;
  esac
  if [ ! -e "$target" ]; then
    bad "README links to a missing file: $target"
    BADLINKS=1
  fi
done < <(grep -oE '\]\([^)]+\)' README.md | sed -E 's/^\]\((.*)\)$/\1/' | sort -u)
[ "$BADLINKS" -eq 0 ] && ok 'every relative link in README.md exists'

if grep -q '^## Status' README.md; then
  ok 'README carries an honest status table'
else
  bad 'README has no Status section'
fi

# ------------------------------------------------------------------- summary --
printf '\n%s\n' '----------------------------------------------'
printf 'checks passed: %d   failed: %d   skipped: %d\n' "$PASS" "$FAIL" "$SKIPPED"
if [ "$FAIL" -gt 0 ]; then
  echo 'VERIFICATION FAILED'
  exit 1
fi
echo 'VERIFICATION PASSED'
