#!/usr/bin/env bash
# Register for the MassDOT Work Zones (WZDx) API and store the key as the
# GitHub Actions secret MASSDOT_WZDX_API_KEY.
#
# Two steps (a confirmation email lands in between):
#   bash scripts/get_wzdx_key.sh register you@example.com "Your Name"
#   bash scripts/get_wzdx_key.sh finish   you@example.com <userId> <code>
# The userId/code come from the confirmation email's link:
#   https://api-app.massdot-swzm.com/confirm-account?userId=...&code=...
set -euo pipefail

API="https://api.massdot-swzm.com/api"
ORIGIN="https://api-app.massdot-swzm.com"
CRED_FILE="$HOME/.config/massdot-wzdx-credentials"
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

post() { # path json [extra curl args...]
  local path="$1" body="$2"; shift 2
  curl -sS --fail-with-body --max-time 60 -b "$COOKIES" -c "$COOKIES" \
    -X POST "$API/$path" \
    -H "Content-Type: application/json" -H "Accept: application/json" \
    -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/" \
    -d "$body" "$@"
}

case "${1:-}" in
register)
  EMAIL="${2:?usage: register <email> <full name>}"
  NAME="${3:?usage: register <email> <full name>}"
  PW="Wz!$(python3 -c 'import secrets,string; print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(18)))')"
  mkdir -p "$(dirname "$CRED_FILE")"
  printf 'email=%s\npassword=%s\n' "$EMAIL" "$PW" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
  echo "registering $EMAIL ..."
  post "Account/Register" "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"fullName\":\"$NAME\"}"
  echo
  echo "OK — password saved to $CRED_FILE"
  echo "Now check your email for the confirmation link, then run:"
  echo "  bash scripts/get_wzdx_key.sh finish $EMAIL <userId> <code>"
  ;;
finish)
  EMAIL="${2:?usage: finish <email> <userId> <code>}"
  USERID="${3:?usage: finish <email> <userId> <code>}"
  CODE="${4:?usage: finish <email> <userId> <code>}"
  PW="$(grep '^password=' "$CRED_FILE" | cut -d= -f2-)"
  echo "confirming account ..."
  post "Account/ConfirmAccount" "{\"userId\":\"$USERID\",\"code\":\"$CODE\"}" || true
  echo "logging in ..."
  post "Account/LogIn" "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" >/dev/null ||
    post "Account/LogIn" "{\"Email\":\"$EMAIL\",\"Password\":\"$PW\"}" >/dev/null
  echo "requesting API key ..."
  RESP="$(post "ApiKey/RequestApiKey" "{}")"
  KEY="$(printf '%s' "$RESP" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if isinstance(d, str):
    print(d)
else:
    print(d.get('key') or d.get('apiKey') or d.get('value') or '')
")"
  if [ -z "$KEY" ]; then
    echo "could not parse key from response:"; echo "$RESP"; exit 1
  fi
  echo "storing as GitHub secret MASSDOT_WZDX_API_KEY ..."
  printf '%s' "$KEY" | gh secret set MASSDOT_WZDX_API_KEY --repo pelednoam/safe-bikes-lanes
  printf 'key=%s\n' "$KEY" >> "$CRED_FILE"
  echo "done — key stored (also kept in $CRED_FILE). Masked: ${KEY:0:6}…${KEY: -4}"
  ;;
reset)
  # complete a password reset from the emailed link, then fetch the API key:
  #   reset '<full reset-password URL from the email>'
  URL="${2:?usage: reset '<reset link url>'}"
  read -r EMAIL TOKEN <<< "$(python3 - "$URL" <<'PYEOF'
import sys
from urllib.parse import urlsplit, parse_qs, unquote
q = parse_qs(urlsplit(sys.argv[1]).query)
print(unquote(q["email"][0]), q["token"][0])
PYEOF
)"
  PW="Wz!$(python3 -c 'import secrets,string; print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(18)))')"
  mkdir -p "$(dirname "$CRED_FILE")"
  printf 'email=%s\npassword=%s\n' "$EMAIL" "$PW" > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
  echo "resetting password for $EMAIL ..."
  python3 - "$EMAIL" "$TOKEN" "$PW" <<'PYEOF' > /tmp/reset_body.json
import json, sys
print(json.dumps({"Email": sys.argv[1], "ResetCode": sys.argv[2], "NewPassword": sys.argv[3]}))
PYEOF
  post "Account/ResetPassword" "$(cat /tmp/reset_body.json)"; rm -f /tmp/reset_body.json
  echo "logging in ..."
  post "Account/LogIn" "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" >/dev/null ||
    post "Account/LogIn" "{\"Email\":\"$EMAIL\",\"Password\":\"$PW\"}" >/dev/null
  echo "requesting API key ..."
  RESP="$(post "ApiKey/RequestApiKey" "{}")"
  KEY="$(printf '%s' "$RESP" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if isinstance(d, str):
    print(d)
else:
    print(d.get('key') or d.get('apiKey') or d.get('value') or '')
")"
  if [ -z "$KEY" ]; then
    echo "could not parse key from response:"; echo "$RESP"; exit 1
  fi
  echo "storing as GitHub secret MASSDOT_WZDX_API_KEY ..."
  printf '%s' "$KEY" | gh secret set MASSDOT_WZDX_API_KEY --repo pelednoam/safe-bikes-lanes
  printf 'key=%s\n' "$KEY" >> "$CRED_FILE"
  echo "done — key stored (also kept in $CRED_FILE). Masked: ${KEY:0:6}…${KEY: -4}"
  ;;
*)
  echo "usage: $0 register <email> \"<full name>\" | finish <email> <userId> <code> | reset '<url>'"
  exit 1
  ;;
esac
