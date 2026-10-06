#!/usr/bin/env bash
# One-time wiring of the banana server to New API, run on the VM from server/:
#   ./bootstrap-gateway.sh <root username> <root password>
# It logs in as the gateway admin, creates a system access token named
# "banana-server" with every scope the admin can grant, writes it to .env as
# GATEWAY_TOKEN, restarts the banana container and uploads ../content.json.
set -euo pipefail
cd "$(dirname "$0")"
USER_="${1:?root username}"; PASS="${2:?root password}"
G="${GATEWAY_LOCAL_URL:-http://127.0.0.1:3000}"
B="${BANANA_LOCAL_URL:-http://127.0.0.1:8787}"
J="content-type: application/json"

login=$(curl -s -m 15 -X POST "$G/api/user/login" -H "$J" -d "{\"username\":\"$USER_\",\"password\":\"$PASS\"}")
SESS=$(printf '%s' "$login" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"]["access_token"] if d.get("success") else "")')
UID_=$(printf '%s' "$login" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["data"]["user"]["id"] if d.get("success") else "")')
[ -n "$SESS" ] || { echo "gateway login failed: $login" >&2; exit 1; }
H1="Authorization: Bearer $SESS"; H2="New-Api-User: $UID_"

scopes=$(curl -s -m 15 -H "$H1" -H "$H2" "$G/api/user/access_tokens/catalog" | python3 -c '
import sys, json
d = json.load(sys.stdin)["data"]
out = []
for g in d["groups"]:
    for r in g["resources"]:
        for a in r["actions"]:
            out.append(r["resource"] + ":" + a["action"])
print(json.dumps(out))')
echo "scopes offered: $scopes"

# Creating a token is a critical action: New API wants a fresh security proof
# (the admin's password, bound to exactly these scopes) in X-Security-Proof.
proof=$(curl -s -m 15 -X POST "$G/api/verify" -H "$H1" -H "$H2" -H "$J" \
  -d "{\"method\":\"password\",\"scope\":\"access_token.generate\",\"context\":{\"scopes\":$scopes,\"expires_at\":0},\"password\":$(printf '%s' "$PASS" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}")
PROOF=$(printf '%s' "$proof" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("data") or {}).get("proof_token","") if d.get("success") else "")')
[ -n "$PROOF" ] || { echo "security verification failed: $proof" >&2; exit 1; }

created=$(curl -s -m 15 -X POST "$G/api/user/access_tokens" -H "$H1" -H "$H2" -H "$J" -H "X-Security-Proof: $PROOF" \
  -d "{\"name\":\"banana-server\",\"scopes\":$scopes,\"expires_at\":0}")
TOKEN=$(printf '%s' "$created" | python3 -c '
import sys, json
d = json.load(sys.stdin)
data = d.get("data") or {}
for k in ("token", "access_token", "secret", "key", "plain_token", "value"):
    v = data.get(k)
    if isinstance(v, str) and v:
        print(v); break')
if [ -z "$TOKEN" ]; then echo "could not create the access token: $created" >&2; exit 1; fi
echo "access token created (${#TOKEN} chars)"

if grep -q '^GATEWAY_TOKEN=' .env; then sed -i "s|^GATEWAY_TOKEN=.*|GATEWAY_TOKEN=$TOKEN|" .env; else echo "GATEWAY_TOKEN=$TOKEN" >> .env; fi
docker compose up -d banana >/dev/null
sleep 3

ADMIN=$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2-)
echo "banana: $(curl -s -m 5 "$B/")"
echo "content: $(curl -s -m 15 -X PUT "$B/content" -H "x-admin-token: $ADMIN" -H "$J" --data-binary @../content.json)"
echo "gateway check: $(curl -s -m 15 -H "Authorization: Bearer $TOKEN" -H "$H2" "$G/api/user/search?keyword=$USER_" | head -c 120)"
