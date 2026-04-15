#!/usr/bin/env bash
set -euo pipefail

# claude-mem fork deployment script
# Usage: bash deploy.sh [--skip-build] [--skip-openclaw-restart]
#
# Deploys the claude-mem fork (kemychen/claude-mem) to the local openclaw installation.
# Handles: git pull, build, worker replacement, openclaw plugin update, restart.

readonly FORK_DIR="${HOME}/claude-mem-fork"
readonly EXTENSION_DIR="${HOME}/.openclaw/extensions/claude-mem"
readonly SETTINGS_FILE="${HOME}/.claude-mem/settings.json"
readonly OPENCLAW_CONFIG="${HOME}/.openclaw/openclaw.json"
readonly OPENCLAW_LOG="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
readonly WORKER_LOG="${HOME}/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log"

SKIP_BUILD=false
SKIP_OPENCLAW_RESTART=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-openclaw-restart) SKIP_OPENCLAW_RESTART=true ;;
  esac
done

log() { echo "[deploy] $(date +%H:%M:%S) $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ============================================================================
# Step 1: Pull and build
# ============================================================================

if [[ ! -d "$FORK_DIR" ]]; then
  log "Cloning fork..."
  git clone https://github.com/kemychen/claude-mem.git "$FORK_DIR"
fi

cd "$FORK_DIR"

if [[ "$SKIP_BUILD" == false ]]; then
  log "Pulling latest..."
  git pull

  log "Installing dependencies..."
  npm install --ignore-scripts 2>/dev/null

  log "Building..."
  npm run build
  log "Build complete."
else
  log "Skipping build (--skip-build)"
fi

# ============================================================================
# Step 2: Kill existing worker
# ============================================================================

log "Stopping worker..."
WORKER_PID=$(pgrep -f "worker-service.cjs" | head -1 || true)
if [[ -n "$WORKER_PID" ]]; then
  kill -9 "$WORKER_PID" 2>/dev/null || true
  sleep 2
  log "Killed worker PID $WORKER_PID"
else
  log "No worker running."
fi

# ============================================================================
# Step 3: Copy build artifacts
# ============================================================================

log "Copying worker-service.cjs..."
cp -f "$FORK_DIR/plugin/scripts/worker-service.cjs" "$EXTENSION_DIR/plugin/scripts/worker-service.cjs"

log "Copying mcp-server.cjs..."
cp -f "$FORK_DIR/plugin/scripts/mcp-server.cjs" "$EXTENSION_DIR/plugin/scripts/mcp-server.cjs"

log "Copying openclaw plugin dist..."
# Detect target path (official install uses dist/index.js, not openclaw/dist/index.js)
if [[ -f "$EXTENSION_DIR/dist/index.js" ]]; then
  cp -f "$FORK_DIR/openclaw/dist/index.js" "$EXTENSION_DIR/dist/index.js"
elif [[ -d "$EXTENSION_DIR/openclaw/dist" ]]; then
  cp -f "$FORK_DIR/openclaw/dist/index.js" "$EXTENSION_DIR/openclaw/dist/index.js"
fi

log "Copying openclaw skills..."
if [[ -d "$FORK_DIR/openclaw/skills" ]]; then
  cp -r "$FORK_DIR/openclaw/skills" "$EXTENSION_DIR/"
  log "Skills copied: $(ls "$EXTENSION_DIR/skills" | tr '\n' ' ')"
fi

# ============================================================================
# Step 4: Fix openclaw.plugin.json (remove kind: "memory" if present)
# ============================================================================

PLUGIN_JSON="$EXTENSION_DIR/openclaw.plugin.json"
if [[ -f "$PLUGIN_JSON" ]]; then
  if python3 -c "import json; d=json.load(open('$PLUGIN_JSON')); exit(0 if d.get('kind')=='memory' else 1)" 2>/dev/null; then
    log "Fixing openclaw.plugin.json: removing kind=memory..."
    python3 -c "
import json
f = '$PLUGIN_JSON'
d = json.load(open(f))
d.pop('kind', None)
json.dump(d, open(f, 'w'), indent=2)
"
  fi
fi

# ============================================================================
# Step 5: Fix openclaw.json config
# ============================================================================

log "Checking openclaw.json config..."
python3 -c "
import json, sys

f = '$OPENCLAW_CONFIG'
d = json.load(open(f))
changed = False

# Ensure slots.memory = memory-core (not claude-mem)
slots = d.get('plugins', {}).get('slots', {})
if slots.get('memory') == 'claude-mem':
    d['plugins']['slots']['memory'] = 'memory-core'
    print('[deploy] Fixed: plugins.slots.memory -> memory-core')
    changed = True

# Ensure memory-core is enabled
mc = d.get('plugins', {}).get('entries', {}).get('memory-core', {})
if not mc.get('enabled', True):
    d['plugins']['entries']['memory-core']['enabled'] = True
    print('[deploy] Fixed: memory-core.enabled -> true')
    changed = True

# Ensure claude-mem is enabled
cm = d.get('plugins', {}).get('entries', {}).get('claude-mem', {})
if not cm.get('enabled', True):
    d['plugins']['entries']['claude-mem']['enabled'] = True
    print('[deploy] Fixed: claude-mem.enabled -> true')
    changed = True

# Ensure plugins.allow includes claude-mem
allow = d.get('plugins', {}).get('allow')
if isinstance(allow, list) and 'claude-mem' not in allow:
    d['plugins']['allow'].append('claude-mem')
    print('[deploy] Fixed: added claude-mem to plugins.allow')
    changed = True

if changed:
    json.dump(d, open(f, 'w'), indent=2)
    print('[deploy] Config updated.')
else:
    print('[deploy] Config OK, no changes needed.')
"

# ============================================================================
# Step 6: Wait for worker to auto-restart (openclaw manages it)
# ============================================================================

log "Waiting for worker to start..."
for i in $(seq 1 12); do
  sleep 3
  if curl -s http://127.0.0.1:37777/api/health >/dev/null 2>&1; then
    PROVIDER=$(curl -s http://127.0.0.1:37777/api/health | python3 -c "import sys,json;print(json.load(sys.stdin).get('ai',{}).get('provider','?'))" 2>/dev/null)
    log "Worker healthy. Provider: $PROVIDER"
    break
  fi
  if [[ $i -eq 12 ]]; then
    log "WARNING: Worker not healthy after 36s. Check manually."
  fi
done

# ============================================================================
# Step 7: Restart openclaw gateway (if requested)
# ============================================================================

if [[ "$SKIP_OPENCLAW_RESTART" == false ]]; then
  log "Restarting openclaw gateway..."
  GATEWAY_PID=$(pgrep -f "^openclaw-gateway$" | head -1 || true)
  if [[ -n "$GATEWAY_PID" ]]; then
    kill -9 "$GATEWAY_PID" 2>/dev/null || true
    sleep 10
    log "Gateway restarted."
  else
    log "WARNING: openclaw-gateway not found."
  fi
fi

# ============================================================================
# Step 8: Verify
# ============================================================================

log "=== Verification ==="

# Worker health
HEALTH=$(curl -s http://127.0.0.1:37777/api/health 2>/dev/null)
if [[ -n "$HEALTH" ]]; then
  echo "$HEALTH" | python3 -c "import sys,json;d=json.load(sys.stdin);print('[verify] Worker: pid=%s provider=%s uptime=%ss' % (d.get('pid'),d.get('ai',{}).get('provider'),d.get('uptime','?')/1000 if isinstance(d.get('uptime'),int) else '?'))" 2>/dev/null
else
  log "WARNING: Worker not responding."
fi

# Openclaw plugins
if [[ -f "$OPENCLAW_LOG" ]]; then
  READY=$(grep "ready.*plugins" "$OPENCLAW_LOG" | tail -1)
  if [[ -n "$READY" ]]; then
    echo "$READY" | python3 -c "import sys,json;d=json.loads(sys.stdin.readline());print('[verify] Gateway:',d.get('1',d.get('0','?')))" 2>/dev/null || true
  fi
fi

# Corpus supplement
if [[ -f "$OPENCLAW_LOG" ]]; then
  CORPUS=$(grep "corpus supplement" "$OPENCLAW_LOG" | tail -1)
  if [[ -n "$CORPUS" ]]; then
    log "Corpus supplement: REGISTERED"
  else
    log "WARNING: Corpus supplement not found in logs."
  fi
fi

# Database counts
python3 -c "
import sqlite3
db = '$HOME/.claude-mem/claude-mem.db'
con = sqlite3.connect(db)
obs = con.execute('SELECT count(*) FROM observations').fetchone()[0]
ss = con.execute('SELECT count(*) FROM session_summaries').fetchone()[0]
failed = con.execute(\"SELECT count(*) FROM pending_messages WHERE status='failed'\").fetchone()[0]
print(f'[verify] DB: observations={obs} summaries={ss} failed={failed}')
" 2>/dev/null || log "WARNING: Cannot read database."

log "=== Deployment complete ==="
