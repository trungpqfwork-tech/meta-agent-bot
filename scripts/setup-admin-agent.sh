#!/usr/bin/env bash
# Per-host setup for the page-cskh admin agent.
#
# Idempotent: safe to re-run. Creates/repairs a dedicated Hermes profile, copies
# the provider config + API keys from the active profile (messaging tokens are
# deliberately left behind), trusts this repo so its .agents/skills load, and
# prints the manual steps that involve secrets.
#
# Usage:
#   scripts/setup-admin-agent.sh [--profile NAME] [--repo DIR] [--check] [--no-config-copy]
#
# Why a separate profile: the admin agent has tools and reads the runtime dir,
# while the customer-facing completion is tool-less and must never share that
# context.
set -euo pipefail

PROFILE="cskh-admin"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=0
COPY_CONFIG=1

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --repo)    REPO="$(cd "${2:?}" && pwd)"; shift 2 ;;
    --check)   CHECK_ONLY=1; shift ;;
    --no-config-copy) COPY_CONFIG=0; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ACTIVE_HOME="${HERMES_HOME:-$HOME/.hermes}"
PROFILE_HOME="$ACTIVE_HOME/profiles/$PROFILE"
REPO_REAL="$(cd "$REPO" && pwd -P)"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
todo() { printf '  [todo] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; }

command -v hermes >/dev/null 2>&1 || { fail "hermes not on PATH"; exit 1; }
[ -f "$REPO/.agents/skills/page-cskh-admin/SKILL.md" ] \
  || { fail "missing $REPO/.agents/skills/page-cskh-admin/SKILL.md"; exit 1; }

say "repo         : $REPO_REAL"
say "profile      : $PROFILE"
say "profile home : $PROFILE_HOME"
say ""

profile_ready()  { [ -f "$PROFILE_HOME/config.yaml" ] && [ -f "$PROFILE_HOME/.env" ]; }
model_set()      { [ "$(HERMES_HOME="$PROFILE_HOME" hermes config get model.default 2>/dev/null | tail -1)" != "Config key not set: model.default" ]; }
trust_recorded() { grep -qF "$REPO_REAL" "$PROFILE_HOME/config.yaml" 2>/dev/null; }
cwd_ok()         { [ "$(HERMES_HOME="$PROFILE_HOME" hermes config get terminal.cwd 2>/dev/null | tail -1)" = "$REPO_REAL" ]; }

if [ "$CHECK_ONLY" = "1" ]; then
  say "check only:"
  [ -d "$PROFILE_HOME" ] && ok "profile exists" || todo "profile $PROFILE missing -> run without --check"
  profile_ready && ok "profile has config.yaml + .env" || todo "profile has no config.yaml/.env (no model, no provider keys)"
  trust_recorded && ok "repo trusted for this profile (project skills load)" \
                 || todo "repo not trusted for this profile -> run without --check"
  cwd_ok && ok "terminal.cwd points at the repo (AGENTS.md + project skills load)" \
         || todo "terminal.cwd is not the repo -> AGENTS.md and project skills will NOT load -> run without --check"
  exit 0
fi

say "1. Hermes profile"
if [ -d "$PROFILE_HOME" ]; then
  ok "profile $PROFILE already exists"
else
  hermes profile create "$PROFILE" --clone --description "Page CSKH admin/ops agent"
  ok "created profile $PROFILE (cloned config + provider keys, no chat tokens)"
fi

if ! profile_ready && [ "$COPY_CONFIG" = "1" ]; then
  say "   provisioning config + keys from $ACTIVE_HOME (values never printed)"
  [ -f "$ACTIVE_HOME/config.yaml" ] || { fail "no $ACTIVE_HOME/config.yaml to copy"; exit 1; }
  [ -f "$ACTIVE_HOME/.env" ] || { fail "no $ACTIVE_HOME/.env to copy"; exit 1; }
  mkdir -p "$PROFILE_HOME"
  cp "$ACTIVE_HOME/config.yaml" "$PROFILE_HOME/config.yaml"
  # Provider/API keys only: messaging tokens stay behind, so the admin bot is
  # paired explicitly and never inherits the alert bot.
  grep -vE '^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX|TEAMS|EMAIL|TWILIO|SMS|LINE|DINGTALK|MATTERMOST)_' \
    "$ACTIVE_HOME/.env" > "$PROFILE_HOME/.env"
  chmod 600 "$PROFILE_HOME/.env"
  ok "copied config.yaml + provider keys (mode 600), messaging tokens excluded"
fi

say "2. Trust this repo for the profile (project skills load only when trusted)"
HERMES_HOME="$PROFILE_HOME" hermes skills trust "$REPO_REAL" >/dev/null
trust_recorded && ok "repo trusted in $PROFILE_HOME/config.yaml" \
               || { fail "trust not recorded"; exit 1; }

say "3. Point the profile's working directory at this repo"
# terminal.cwd MUST be absolute. With the default "." the session cwd resolves to
# the Hermes home instead of the launch dir, and then AGENTS.md and .agents/skills
# silently do not load - no error, just a dumber agent.
HERMES_HOME="$PROFILE_HOME" hermes config set terminal.cwd "$REPO_REAL" >/dev/null
cwd_ok && ok "terminal.cwd = $REPO_REAL" || { fail "terminal.cwd not set to the repo"; exit 1; }

say "4. Verify"
model_set && ok "model configured for $PROFILE" || todo "no model set: HERMES_HOME=$PROFILE_HOME hermes model"
todo "project-local skills are NOT listed by 'hermes skills list'; verify by running an agent from $REPO_REAL"

say ""
say "Manual steps left (this script never handles secrets):"
todo "pair a Telegram bot to profile $PROFILE:  hermes gateway setup   (or dashboard -> Messaging -> Telegram -> Create with QR)"
todo "set TELEGRAM_ALLOWED_USERS to your numeric Telegram user id (allow_all_users is false)"
todo "use a different bot than the alert bot in the runtime .env, or the admin agent will also read the alert group"
say ""
say "Run the admin agent from the repo so AGENTS.md + the skill apply:"
say "  cd $REPO_REAL && HERMES_HOME=$PROFILE_HOME hermes"
