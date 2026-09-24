import { supabase } from "./supabase";

// Falls back to localhost for local dev, but can be overridden via
// VITE_API_URL so the same build works against a deployed backend.
export const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

// Scopes requested when someone signs in / registers *with* GitHub, so the
// token Supabase hands back is usable for syncing repositories later.
// Keep in sync with GITHUB_OAUTH_SCOPES in backend/.env.
export const GITHUB_LOGIN_SCOPES = "read:user user:email repo";

const OAUTH_STATE_KEY = "devpulse:github-oauth-state";
const LOGIN_LINK_KEY = "devpulse:github-login-linked";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function errorMessage(data, fallback) {
  const detail = data?.detail;

  if (typeof detail === "string") {
    return detail;
  }

  // FastAPI validation errors come back as a list of { msg, loc, ... }.
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map((item) => item.msg).filter(Boolean).join(", ") || fallback;
  }

  return fallback;
}

async function request(path, { method = "GET", body } = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    window.location.href = "/login";
    throw new ApiError("You are signed out. Please log in again.", 401);
  }

  const headers = { Authorization: `Bearer ${session.access_token}` };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Could not reach the DevPulse server.", 0);
  }

  // Errors from a proxy or crashed server may not be JSON.
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      errorMessage(data, `Request failed (${response.status})`),
      response.status
    );
  }

  return data;
}

/* ------------------------------------------------------------------ */
/* Connection status                                                   */
/* ------------------------------------------------------------------ */

// -> { connected: boolean, account: { github_username, avatar_url, ... } | null }
export function fetchGithubStatus() {
  return request("/github/account");
}

/* ------------------------------------------------------------------ */
/* "Connect GitHub" (OAuth authorization-code flow)                    */
/* ------------------------------------------------------------------ */

// Step 1: ask the backend for a signed authorize URL, remember its `state`
// in this tab, and send the browser to GitHub.
export async function startGithubConnect() {
  const { authorize_url: authorizeUrl, state } = await request(
    "/github/connect",
    { method: "POST" }
  );

  sessionStorage.setItem(OAUTH_STATE_KEY, state);
  window.location.assign(authorizeUrl);
}

// Step 2 (called from /github/callback): only accept the code if the state
// GitHub echoed back is the one this tab generated. That is what stops
// someone from tricking you into linking *their* GitHub account.
export async function completeGithubConnect(code, state) {
  const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);

  if (!expectedState || expectedState !== state) {
    throw new ApiError(
      "This GitHub connection did not start from this browser tab. Please click Connect GitHub again.",
      400
    );
  }

  return request("/github/callback", {
    method: "POST",
    body: { code, state },
  });
}

/* ------------------------------------------------------------------ */
/* Unlink                                                              */
/* ------------------------------------------------------------------ */

export function disconnectGithub() {
  return request("/github/account", { method: "DELETE" });
}

/* ------------------------------------------------------------------ */
/* Auto-connect when the user logged in / registered with GitHub       */
/* ------------------------------------------------------------------ */

function isGithubLogin(session) {
  const user = session?.user;
  const identities = user?.identities ?? [];

  // If several providers are linked to the account, use the most recent one.
  const latest = [...identities].sort(
    (a, b) =>
      new Date(b.last_sign_in_at || 0) - new Date(a.last_sign_in_at || 0)
  )[0];

  if (latest) {
    return latest.provider === "github";
  }

  return user?.app_metadata?.provider === "github";
}

// Supabase only exposes the GitHub token (`provider_token`) on the session
// that was created by the GitHub login itself. When that is the case, hand it
// to the backend so the account is stored without an extra "Connect" click.
//
// Returns true if the account was linked by this call.
export async function linkGithubFromLogin(session) {
  const providerToken = session?.provider_token;

  if (!providerToken || !isGithubLogin(session)) {
    return false;
  }

  // The token stays in the stored session until it refreshes. Remember which
  // sign-in we already handled, so a page reload (or an explicit "Disconnect")
  // doesn't silently re-link the account.
  const signInMarker = `${session.user.id}:${session.user.last_sign_in_at ?? ""}`;

  if (localStorage.getItem(LOGIN_LINK_KEY) === signInMarker) {
    return false;
  }

  try {
    await request("/github/link-from-login", {
      method: "POST",
      body: { provider_token: providerToken },
    });
  } catch (err) {
    // 400/409 are definitive answers (bad token, already connected elsewhere);
    // retrying on every reload would only repeat the same error.
    if (err.status === 400 || err.status === 409) {
      localStorage.setItem(LOGIN_LINK_KEY, signInMarker);
    }

    throw err;
  }

  localStorage.setItem(LOGIN_LINK_KEY, signInMarker);

  return true;
}


/* ------------------------------------------------------------------ */
/* Repositories (Week 3)                                               */
/* ------------------------------------------------------------------ */

// GET /repositories → list[Repository]
export function fetchRepositories() {
  return request("/repositories");
}

// POST /repositories/import → { job_id, status, imported }
export function importRepositories() {
  return request("/repositories/import", { method: "POST" });
}

// POST /repositories/{id}/sync → { job_id, status, duration_ms, counts }
export function syncRepository(repositoryId) {
  return request(`/repositories/${repositoryId}/sync`, { method: "POST" });
}

// GET /sync-jobs?limit=20[&repository_id=...]
export function fetchSyncJobs(limit = 20, repositoryId = null) {
  const query = new URLSearchParams({ limit: String(limit) });

  if (repositoryId) {
    query.set("repository_id", repositoryId);
  }

  return request(`/sync-jobs?${query.toString()}`);
}

/* ------------------------------------------------------------------ */
/* Profile (used by pages that need the avatar without the full load)  */
/* ------------------------------------------------------------------ */

// POST /profile/sync is idempotent: it returns the profile, creating it first
// if this is the user's first visit.
export function fetchProfile() {
  return request("/profile/sync", { method: "POST" });
}