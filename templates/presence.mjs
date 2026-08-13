// Claude Code Collaborator — presence client shared by the vendored hooks.
// Fire-and-mostly-forget HTTP to the team sync server, engineered so a missing
// or down server can never hurt a session: short timeouts, a 60s circuit
// breaker, and every failure swallowed.
import fs from 'node:fs';
import path from 'node:path';
import { identity as baseIdentity } from './common.mjs';

const REQUEST_TIMEOUT_MS = 1200;
const BREAKER_MS = 60_000;

export function presenceConfig(team) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(team, 'config.json'), 'utf8'));
  } catch {}
  const p = cfg.presence || {};
  return {
    url: process.env.CCC_SYNC_URL || String(p.url || '').replace(/\/+$/, ''),
    token: process.env.CCC_SYNC_TOKEN || String(p.token || ''),
    user: String(p.user || ''),
    enabled: Boolean(process.env.CCC_SYNC_URL || p.url),
  };
}

export function identity(cfg) {
  return baseIdentity(cfg.user);
}

export function repoName(team) {
  // Project root is the parent of .claude/team. A stable human-readable name is
  // enough for grouping; remote URLs can differ per developer anyway.
  return path.basename(path.resolve(team, '..', '..'));
}

function breakerFile(team) {
  return path.join(team, '.presence-down');
}

function breakerTripped(team) {
  try {
    return Date.now() - fs.statSync(breakerFile(team)).mtimeMs < BREAKER_MS;
  } catch {
    return false;
  }
}

function tripBreaker(team) {
  try {
    fs.writeFileSync(breakerFile(team), String(Date.now()));
  } catch {}
}

async function request(cfg, team, method, pathname, { params, body, timeoutMs } = {}) {
  if (!cfg.enabled || breakerTripped(team)) return null;
  const url = new URL(cfg.url + pathname);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    tripBreaker(team);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Post one event; resolves to the server reply (may include `conflicts`) or null. */
export function postEvent(cfg, team, event) {
  return request(cfg, team, 'POST', '/events', { body: event });
}

/** Fetch active teammate sessions for this repo; null on any failure. */
export function getActivity(cfg, team) {
  return request(cfg, team, 'GET', '/activity', { params: { repo: repoName(team) } });
}

/** Fetch recent touches on a file by other sessions; null on any failure. */
export function getFileActivity(cfg, team, relPath, excludeSession) {
  return request(cfg, team, 'GET', '/file-activity', {
    params: { path: relPath, repo: repoName(team), exclude: excludeSession || '' },
  });
}

export function formatAge(seconds) {
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// ---------- handoff bundles (Phase 3; CLI context, so timeouts are generous) ----------
export function postHandoff(cfg, team, bundle) {
  return request(cfg, team, 'POST', '/handoffs', { body: bundle, timeoutMs: 5000 });
}

export function getHandoff(cfg, team, id) {
  return request(cfg, team, 'GET', `/handoffs/${encodeURIComponent(id)}`, { timeoutMs: 5000 });
}

export function listHandoffs(cfg, team) {
  return request(cfg, team, 'GET', '/handoffs', { params: { repo: repoName(team) }, timeoutMs: 5000 });
}
