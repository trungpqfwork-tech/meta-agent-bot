#!/usr/bin/env bash
# Per-host setup for the page-cskh admin agent.
#
# Idempotent: safe to re-run. Creates/repairs a dedicated Hermes profile, copies
# the provider config + API keys from the active profile (messaging tokens are
# deliberately left behind), trusts this repo so its .agents/skills load, and
# prints the manual steps that involve secrets.
#
# Usage:
#   scripts/setup-admin-agent.sh [--profile NAME] [--repo DIR] [--runtime-env FILE] [--check] [--no-config-copy] [--no-gateway-start]
#
# Optional runtime .env keys for Telegram admin chat:
#   PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN=<bot token from @BotFather>
#   PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS=<numeric Telegram user id[,id...]>
#
# Why a separate profile: the admin agent has tools and reads the runtime dir,
# while the customer-facing completion is tool-less and must never share that
# context.
set -euo pipefail

PROFILE="cskh-admin"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ENV=""
CHECK_ONLY=0
COPY_CONFIG=1
START_GATEWAY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --repo)    REPO="$(cd "${2:?}" && pwd)"; shift 2 ;;
    --runtime-env) RUNTIME_ENV="$(cd "$(dirname "${2:?}")" && pwd)/$(basename "$2")"; shift 2 ;;
    --check)   CHECK_ONLY=1; shift ;;
    --no-config-copy) COPY_CONFIG=0; shift ;;
    --no-gateway-start) START_GATEWAY=0; shift ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ACTIVE_HOME="${HERMES_HOME:-$HOME/.hermes}"
PROFILE_HOME="$ACTIVE_HOME/profiles/$PROFILE"
REPO_REAL="$(cd "$REPO" && pwd -P)"
if [ -z "$RUNTIME_ENV" ]; then
  if [ -f "$REPO_REAL/../runtime/.env" ]; then
    RUNTIME_ENV="$(cd "$REPO_REAL/../runtime" && pwd)/.env"
  elif [ -f "$REPO_REAL/.env" ]; then
    RUNTIME_ENV="$REPO_REAL/.env"
  fi
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
todo() { printf '  [todo] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; }

runtime_env_value() {
  local key="${1:?}"
  [ -n "$RUNTIME_ENV" ] && [ -f "$RUNTIME_ENV" ] || return 0
  node -e '
    const {readFileSync}=require("node:fs");
    const {parseEnv}=require("node:util");
    const env=parseEnv(readFileSync(process.argv[1],"utf8"));
    process.stdout.write(env[process.argv[2]] || "");
  ' "$RUNTIME_ENV" "$key"
}

profile_env_value() {
  local key="${1:?}"
  [ -f "$PROFILE_HOME/.env" ] || return 0
  node -e '
    const {readFileSync}=require("node:fs");
    const {parseEnv}=require("node:util");
    const env=parseEnv(readFileSync(process.argv[1],"utf8"));
    process.stdout.write(env[process.argv[2]] || "");
  ' "$PROFILE_HOME/.env" "$key"
}

set_profile_env_values() {
  local token="${1:?}" allowed="${2:?}"
  mkdir -p "$PROFILE_HOME"
  [ -f "$PROFILE_HOME/.env" ] || : > "$PROFILE_HOME/.env"
  chmod 600 "$PROFILE_HOME/.env"
  node -e '
    const fs=require("node:fs");
    const file=process.argv[1], token=process.argv[2], allowed=process.argv[3];
    const drop=new Set(["TELEGRAM_BOT_TOKEN","TELEGRAM_ALLOWED_USERS"]);
    const lines=fs.existsSync(file) ? fs.readFileSync(file,"utf8").split(/\r?\n/) : [];
    const kept=lines.filter(line => {
      const t=line.trim();
      if(!t || t.startsWith("#")) return true;
      const i=t.indexOf("=");
      return i < 0 || !drop.has(t.slice(0,i).trim());
    });
    while(kept.length && kept[kept.length-1] === "") kept.pop();
    kept.push("TELEGRAM_BOT_TOKEN=" + token, "TELEGRAM_ALLOWED_USERS=" + allowed, "");
    fs.writeFileSync(file, kept.join("\n"), {mode:0o600});
  ' "$PROFILE_HOME/.env" "$token" "$allowed"
  chmod 600 "$PROFILE_HOME/.env"
}

admin_token_from_runtime() {
  runtime_env_value PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN
}

admin_allowed_from_runtime() {
  runtime_env_value PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS
}

valid_telegram_token() { [[ "$1" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; }
valid_telegram_users() { [[ "$1" =~ ^[0-9]+([[:space:]]*,[[:space:]]*[0-9]+)*$ ]]; }

apply_admin_telegram_from_runtime() {
  local token allowed
  token="$(admin_token_from_runtime)"
  allowed="$(admin_allowed_from_runtime | tr -d '[:space:]')"
  if [ -z "$token" ] && [ -z "$allowed" ]; then
    return 1
  fi
  [ -n "$token" ] || { fail "PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN missing in $RUNTIME_ENV"; exit 1; }
  [ -n "$allowed" ] || { fail "PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS missing in $RUNTIME_ENV"; exit 1; }
  valid_telegram_token "$token" || { fail "PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN in $RUNTIME_ENV does not look like a BotFather token"; exit 1; }
  valid_telegram_users "$allowed" || { fail "PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS must be numeric Telegram user ids separated by commas"; exit 1; }
  set_profile_env_values "$token" "$allowed"
  return 0
}

telegram_profile_ready() {
  local token allowed
  token="$(profile_env_value TELEGRAM_BOT_TOKEN)"
  allowed="$(profile_env_value TELEGRAM_ALLOWED_USERS | tr -d '[:space:]')"
  [ -n "$token" ] && [ -n "$allowed" ] && valid_telegram_token "$token" && valid_telegram_users "$allowed"
}

gateway_status_summary() {
  HERMES_HOME="$PROFILE_HOME" hermes gateway status 2>/dev/null | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-180 || true
}

start_gateway_if_configured() {
  telegram_profile_ready || return 1
  [ "$START_GATEWAY" = "1" ] || return 2
  if HERMES_HOME="$PROFILE_HOME" hermes gateway install --start-now --start-on-login >/dev/null 2>&1; then
    return 0
  fi
  if HERMES_HOME="$PROFILE_HOME" hermes gateway restart >/dev/null 2>&1; then
    return 0
  fi
  if HERMES_HOME="$PROFILE_HOME" hermes gateway start >/dev/null 2>&1; then
    return 0
  fi
  return 3
}

command -v hermes >/dev/null 2>&1 || { fail "hermes not on PATH"; exit 1; }
[ -f "$REPO/.agents/skills/page-cskh-admin/SKILL.md" ] \
  || { fail "missing $REPO/.agents/skills/page-cskh-admin/SKILL.md"; exit 1; }

say "repo         : $REPO_REAL"
say "profile      : $PROFILE"
say "profile home : $PROFILE_HOME"
if [ -n "$RUNTIME_ENV" ]; then
  say "runtime .env : $RUNTIME_ENV"
else
  say "runtime .env : not found (pass --runtime-env FILE to import admin Telegram bot)"
fi
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
  telegram_profile_ready && ok "Telegram admin bot configured for this profile (token hidden)" \
                         || todo "Telegram admin bot not configured -> add PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN and PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS to runtime .env, then run without --check"
  status="$(gateway_status_summary)"
  [ -n "$status" ] && ok "gateway status: $status" || todo "gateway status unavailable -> run without --check after Telegram is configured"
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

say "4. Telegram admin bot (optional, imported from runtime .env)"
if apply_admin_telegram_from_runtime; then
  ok "imported PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN into profile as TELEGRAM_BOT_TOKEN (value hidden)"
  ok "imported PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS into profile as TELEGRAM_ALLOWED_USERS"
else
  todo "no PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN / PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS in runtime .env"
  if [ -n "$RUNTIME_ENV" ]; then
    todo "add them to $RUNTIME_ENV, then re-run this script; do not reuse the CSKH alert TELEGRAM_BOT_TOKEN"
  else
    todo "pass --runtime-env /path/to/runtime/.env after adding them; do not reuse the CSKH alert TELEGRAM_BOT_TOKEN"
  fi
fi

say "5. Start Telegram gateway"
if telegram_profile_ready; then
  if start_gateway_if_configured; then
    ok "gateway installed/enabled and started for $PROFILE"
  else
    rc=$?
    if [ "$rc" = "2" ]; then
      todo "gateway auto-start disabled by --no-gateway-start"
    else
      todo "gateway auto-start failed: run HERMES_HOME=$PROFILE_HOME hermes gateway install --start-now --start-on-login"
    fi
  fi
else
  todo "gateway not started because Telegram admin bot is not configured yet"
fi

say "6. Verify"
model_set && ok "model configured for $PROFILE" || todo "no model set: HERMES_HOME=$PROFILE_HOME hermes model"
telegram_profile_ready && ok "Telegram admin bot configured for $PROFILE (token hidden)" \
                       || todo "Telegram not configured: add admin Telegram env keys or run HERMES_HOME=$PROFILE_HOME hermes gateway setup"
status="$(gateway_status_summary)"
[ -n "$status" ] && ok "gateway status: $status" || todo "gateway status unavailable"
todo "project-local skills are NOT listed by 'hermes skills list'; verify by running an agent from $REPO_REAL"

say ""
say "Manual steps left:"
if telegram_profile_ready; then
  todo "if Telegram does not respond, check: HERMES_HOME=$PROFILE_HOME hermes gateway status --deep"
else
  todo "pair a Telegram bot to profile $PROFILE by putting PAGE_CSKH_ADMIN_TELEGRAM_BOT_TOKEN in runtime .env or running HERMES_HOME=$PROFILE_HOME hermes gateway setup"
  todo "set PAGE_CSKH_ADMIN_TELEGRAM_ALLOWED_USERS to your numeric Telegram user id (allow_all_users is false)"
fi
todo "use a different bot than the alert bot in the runtime .env, or the admin agent will also read the alert group"
say ""
say "Run the admin agent from the repo so AGENTS.md + the skill apply:"
say "  cd $REPO_REAL && HERMES_HOME=$PROFILE_HOME hermes"
