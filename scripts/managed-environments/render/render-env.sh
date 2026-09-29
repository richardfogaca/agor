#!/usr/bin/env bash
# Per-branch Agor instance on Render (Docker web service + persistent disk at /home/agor).
# Usage: render-env.sh <start|stop|logs|nuke> <github-slug> <git-ref>
#
# Secrets come from the caller's Global env vars and are never printed:
#   RENDER_API_KEY, RENDER_OWNER_ID, RENDER_AGOR_ADMIN_PASSWORD (start only)
# Optional: RENDER_PLAN (default standard), RENDER_DISK_GB (default 10), RENDER_REGION (default oregon)
#
# Start pushes the branch's committed HEAD to the same-named branch of <github-slug>
# (use a fork you own; Render builds from GitHub), then creates or updates the service
# `agor-<branch>`. Stop suspends it (disk kept). Nuke deletes the service AND its disk.
set -euo pipefail

action=${1:?action}; slug_repo=${2:?github slug}; ref=${3:?git ref}
: "${RENDER_API_KEY:?Save RENDER_API_KEY in your global environment}"
: "${RENDER_OWNER_ID:?Save RENDER_OWNER_ID in your global environment}"

name="agor-$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//; s/-*$//' | cut -c1-40)"
repo_url="https://github.com/$slug_repo"
api=https://api.render.com/v1

r() { curl -fsS -H "Authorization: Bearer $RENDER_API_KEY" -H 'Accept: application/json' -H 'Content-Type: application/json' "$@"; }
find_id() {
  r "$api/services?name=$name&ownerId=$RENDER_OWNER_ID&limit=20" \
    | jq -r --arg n "$name" '[.[].service | select(.name == $n)][0].id // empty'
}
wait_live() { # service id, deploy id
  for _ in $(seq 1 120); do
    st=$(r "$api/services/$1/deploys/$2" | jq -r '.status')
    echo "deploy $2: $st" >&2
    case $st in
      live) return 0 ;;
      build_failed|update_failed|canceled|pre_deploy_failed) return 1 ;;
    esac
    sleep 15
  done
  return 1
}

id=$(find_id)
case $action in
  start)
    : "${RENDER_AGOR_ADMIN_PASSWORD:?Save RENDER_AGOR_ADMIN_PASSWORD in your global environment}"
    if [ -n "$(git status --porcelain)" ]; then echo "warning: uncommitted changes are not deployed" >&2; fi
    git push -q -f "$repo_url.git" "HEAD:refs/heads/$ref" 2>&1 | grep -v '^remote' >&2 || true
    url="https://$name.onrender.com"
    envvars=$(jq -n --arg pw "$RENDER_AGOR_ADMIN_PASSWORD" --arg url "$url" --arg label "$ref" '[
      {key:"AGOR_RUNTIME_TARGET",value:"production-source"},
      {key:"AGOR_ADMIN_PASSWORD",value:$pw},
      {key:"AGOR_AGENTIC_TOOLS",value:"claude-code"},
      {key:"AGOR_BASE_URL",value:$url},
      {key:"CORS_ORIGIN",value:$url},
      {key:"DAEMON_HOST",value:"0.0.0.0"},
      {key:"NODE_ENV",value:"production"},
      {key:"INSTANCE_LABEL",value:$label}]')
    if [ -z "$id" ]; then
      body=$(jq -n --arg n "$name" --arg o "$RENDER_OWNER_ID" --arg repo "$repo_url" --arg ref "$ref" \
        --arg plan "${RENDER_PLAN:-standard}" --arg region "${RENDER_REGION:-oregon}" \
        --argjson gb "${RENDER_DISK_GB:-10}" --argjson env "$envvars" '{
        type:"web_service", name:$n, ownerId:$o, repo:$repo, branch:$ref, autoDeploy:"no", envVars:$env,
        serviceDetails:{runtime:"docker", plan:$plan, region:$region, healthCheckPath:"/health",
          disk:{name:"agor-home", mountPath:"/home/agor", sizeGB:$gb},
          envSpecificDetails:{dockerfilePath:"./docker/Dockerfile", dockerContext:"."}}}')
      res=$(r -X POST "$api/services" -d "$body")
      id=$(jq -r '.service.id' <<<"$res"); dep=$(jq -r '.deployId' <<<"$res")
      echo "created $name ($id)" >&2
    else
      r -X POST "$api/services/$id/resume" >/dev/null 2>&1 || true
      r -X PUT "$api/services/$id/env-vars" -d "$envvars" >/dev/null
      r -X PATCH "$api/services/$id" -d "$(jq -n --arg ref "$ref" '{branch:$ref}')" >/dev/null
      dep=$(r -X POST "$api/services/$id/deploys" -d '{}' | jq -r '.id')
      echo "updated $name ($id)" >&2
    fi
    wait_live "$id" "$dep" || { echo "deploy failed; see logs" >&2; exit 1; }
    url=$(r "$api/services/$id" | jq -r '.serviceDetails.url')
    echo "AGOR_ENVIRONMENT_RESULT=$(jq -cn --arg u "$url" '{app:$u, health:($u+"/health")}')"
    ;;
  stop)
    [ -n "$id" ] || { echo "no service $name; nothing to stop" >&2; exit 0; }
    r -X POST "$api/services/$id/suspend" >/dev/null; echo "suspended $name (disk kept)"
    ;;
  logs)
    [ -n "$id" ] || { echo "no service $name" >&2; exit 0; }
    r "$api/logs?ownerId=$RENDER_OWNER_ID&resource=$id&limit=150&direction=backward" \
      | jq -r '.logs | reverse[] | "\(.timestamp) \(.message)"'
    ;;
  nuke)
    [ -n "$id" ] || { echo "no service $name; nothing to delete" >&2; exit 0; }
    r -X DELETE "$api/services/$id" >/dev/null; echo "deleted $name and its disk"
    ;;
  *) echo "unknown action $action" >&2; exit 2 ;;
esac
