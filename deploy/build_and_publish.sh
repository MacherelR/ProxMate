#!/usr/bin/env bash
# Build ProxMate's backend + frontend images from your LOCAL working tree (not a
# released tag) and push them to a registry — for testing changes before they're
# released, or for self-hosting a fork. Uses the project's own Dockerfiles
# (backend/Dockerfile, frontend/Dockerfile) exactly as docker-compose.yml does;
# the only addition is an OPTIONAL PostgreSQL patch for the backend (off by
# default — see deploy/Dockerfile.backend.postgres).
set -euo pipefail

# ─── Variables — edit these, or override via env: FOO=bar ./build_and_publish.sh

# Registry + image path prefix you're pushing to.
REGISTRY="${REGISTRY:-registry.example.com/your-namespace}"

# Image tag. Keep it distinct from any real release tag you track, so this never
# gets picked up by anything other than a deployment you point at it on purpose.
TAG="${TAG:-local-test}"

# Public FQDN this ProxMate will actually be served on. Baked into the frontend's
# JS bundle at build time (Next.js NEXT_PUBLIC_* convention) — must match wherever
# you actually point DNS + TLS, or the browser will call the wrong host.
FQDN="${FQDN:-proxmate.example.com}"

# Build the backend against PostgreSQL instead of the default SQLite (see
# docs/api.md's "Running on PostgreSQL" section). FOR A FRESH DATABASE ONLY.
PATCH_POSTGRES="${PATCH_POSTGRES:-false}"

# Which images to build/push, and whether to actually push (PUSH=false builds +
# tags locally only, e.g. to inspect the image before publishing).
BUILD_BACKEND="${BUILD_BACKEND:-true}"
BUILD_FRONTEND="${BUILD_FRONTEND:-true}"
PUSH="${PUSH:-true}"

# Set to false if you're already logged in to $REGISTRY (docker login is
# otherwise re-run every time — harmless, just an extra prompt/no-op).
DOCKER_LOGIN="${DOCKER_LOGIN:-true}"

# ─── End of variables ───────────────────────────────────────────

REPO_ROOT="${PROXMATE_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
[[ -d "$REPO_ROOT/backend" && -d "$REPO_ROOT/frontend" ]] \
  || die "REPO_ROOT ($REPO_ROOT) doesn't look like a ProxMate checkout (no backend/ or frontend/) — set PROXMATE_REPO_DIR"
if [[ "$PUSH" == true && "$REGISTRY" == *example.com* ]]; then
  die "REGISTRY is still the placeholder ($REGISTRY) — set it to your real registry, or run with PUSH=false"
fi
if [[ "$BUILD_FRONTEND" == true && "$FQDN" == "proxmate.example.com" ]]; then
  log "WARNING: FQDN is still the placeholder default — confirm this is really the hostname you'll serve on."
fi

BACKEND_IMAGE="$REGISTRY/proxmate-backend:$TAG"
FRONTEND_IMAGE="$REGISTRY/proxmate-frontend:$TAG"

if [[ "$DOCKER_LOGIN" == true ]]; then
  log "Logging in to ${REGISTRY%%/*}"
  docker login "${REGISTRY%%/*}"
fi

if [[ "$BUILD_BACKEND" == true ]]; then
  if [[ "$PATCH_POSTGRES" == true ]]; then
    log "Building $BACKEND_IMAGE (PostgreSQL)"
    docker build -f "$REPO_ROOT/deploy/Dockerfile.backend.postgres" -t "$BACKEND_IMAGE" "$REPO_ROOT/backend"
  else
    log "Building $BACKEND_IMAGE (SQLite, stock Dockerfile)"
    docker build -t "$BACKEND_IMAGE" "$REPO_ROOT/backend"
  fi
  if [[ "$PUSH" == true ]]; then
    log "Pushing $BACKEND_IMAGE"
    docker push "$BACKEND_IMAGE"
  fi
fi

if [[ "$BUILD_FRONTEND" == true ]]; then
  log "Building $FRONTEND_IMAGE (NEXT_PUBLIC_*=https://$FQDN)"
  docker build \
    --build-arg NEXT_PUBLIC_API_URL="https://$FQDN/api" \
    --build-arg NEXT_PUBLIC_SITE_URL="https://$FQDN" \
    -t "$FRONTEND_IMAGE" "$REPO_ROOT/frontend"
  if [[ "$PUSH" == true ]]; then
    log "Pushing $FRONTEND_IMAGE"
    docker push "$FRONTEND_IMAGE"
  fi
fi

log "Done:"
[[ "$BUILD_BACKEND" == true ]] && echo "  $BACKEND_IMAGE"
[[ "$BUILD_FRONTEND" == true ]] && echo "  $FRONTEND_IMAGE  (FQDN: $FQDN)"
