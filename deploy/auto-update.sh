#!/usr/bin/env bash
# =============================================================================
# auto-update.sh — deploy new commits from GitHub (run by claude-office-update.timer)
#
# Reads /etc/claude-office/autoupdate.env (OFFICE_SRC = the git checkout,
# OFFICE_DOMAIN, OFFICE_BRANCH), fetches the branch, and when it moved:
# fast-forwards the checkout and runs install-vps.sh in auto mode. Never
# touches a checkout with local changes or a diverged history.
#
# Test hook: OFFICE_INSTALL_CMD replaces the install step.
# =============================================================================
set -euo pipefail

ENV_FILE="${OFFICE_AUTOUPDATE_ENV:-/etc/claude-office/autoupdate.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
SRC="${OFFICE_SRC:?OFFICE_SRC missing in $ENV_FILE}"
DOMAIN="${OFFICE_DOMAIN:?OFFICE_DOMAIN missing in $ENV_FILE}"
BRANCH="${OFFICE_BRANCH:-main}"
LOCK="${OFFICE_AUTOUPDATE_LOCK:-/run/claude-office-update.lock}"

exec 9>"$LOCK"
flock -n 9 || { echo "Another update is running"; exit 0; }

# Why: this runs as root from a systemd timer, while the checkout belongs to
# the user who cloned it. Git (2.35.2+) refuses such a repository ("detected
# dubious ownership") unless it is a safe.directory; under `sudo` it lets it
# pass by SUDO_UID, which a timer does not have. So enable-auto-update.sh
# (run with sudo) deployed fine, and every timer run after it failed before
# fetching, leaving the office on that first commit. The exception holds for
# this checkout only and reaches install-vps.sh (its VERSION stamp) through
# the environment; nothing is written to any git config.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$SRC"
OWNER="$(stat -c '%u:%g' "$SRC")"
# Root writes FETCH_HEAD, new objects and, on an update, the files: hand them
# back to the checkout's owner on the way out, so that user's own `git pull`
# keeps working
[ "$(id -u)" -eq 0 ] && trap 'chown -R "$OWNER" "$SRC"' EXIT

cd "$SRC"
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
[ "$LOCAL" = "$REMOTE" ] && exit 0

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Local changes in $SRC: not updating (git status to see them)" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
  echo "History diverged in $SRC: not updating" >&2
  exit 1
fi

echo "Updating ${LOCAL:0:7} -> ${REMOTE:0:7}"
git merge -q --ff-only "origin/$BRANCH"
if [ -n "${OFFICE_INSTALL_CMD:-}" ]; then
  eval "$OFFICE_INSTALL_CMD"
else
  OFFICE_AUTO=1 bash "$SRC/deploy/install-vps.sh" "$DOMAIN"
fi
