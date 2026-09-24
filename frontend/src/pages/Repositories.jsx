import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AppShell from "../components/AppShell";
import { supabase } from "../lib/supabase";
import {
  fetchGithubStatus,
  fetchProfile,
  fetchRepositories,
  fetchSyncJobs,
  importRepositories,
  startGithubConnect,
  syncRepository,
} from "../lib/github";
import "./Dashboard.css";
import "./Repositories.css";

/* ------------------------------ helpers ------------------------------ */

function timeAgo(value) {
  if (!value) {
    return "Never";
  }

  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000)
  );

  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} d ago`;

  return new Date(value).toLocaleDateString();
}

function formatDuration(job) {
  if (!job.started_at || !job.completed_at) {
    return "—";
  }

  const ms = new Date(job.completed_at) - new Date(job.started_at);

  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const JOB_LABELS = {
  repo_list: "Repository import",
  repository_full: "Repository sync",
};

const SORTERS = {
  updated: (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
  name: (a, b) => a.full_name.localeCompare(b.full_name),
  synced: (a, b) =>
    (b.synced_at ? new Date(b.synced_at).getTime() : 0) -
    (a.synced_at ? new Date(a.synced_at).getTime() : 0),
};

/* -------------------------------- page -------------------------------- */

function Repositories() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [profile, setProfile] = useState(null);
  const [account, setAccount] = useState(null);
  const [repos, setRepos] = useState([]);
  const [jobs, setJobs] = useState([]);

  const [importing, setImporting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [syncAll, setSyncAll] = useState(null); // { done, total, name } | null
  const [results, setResults] = useState({}); // repoId -> { counts, duration_ms }
  const [notice, setNotice] = useState(null);

  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState("all");
  const [syncState, setSyncState] = useState("all");
  const [sortBy, setSortBy] = useState("updated");

  const cancelSyncAll = useRef(false);

  const busy = importing || syncingId !== null || syncAll !== null;

  /* ---------------------------- data loading --------------------------- */

  const loadData = useCallback(async () => {
    const [statusResult, reposResult, jobsResult] = await Promise.allSettled([
      fetchGithubStatus(),
      fetchRepositories(),
      fetchSyncJobs(30),
    ]);

    if (statusResult.status === "rejected") {
      throw statusResult.reason;
    }

    setAccount(statusResult.value.account);

    if (reposResult.status === "fulfilled") {
      setRepos(Array.isArray(reposResult.value) ? reposResult.value : []);
    } else {
      throw reposResult.reason;
    }

    // The history panel is nice-to-have; never fail the page because of it.
    setJobs(
      jobsResult.status === "fulfilled" && Array.isArray(jobsResult.value)
        ? jobsResult.value
        : []
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (!supabase) {
        setError("Supabase is not configured.");
        setLoading(false);
        return;
      }

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session) {
          window.location.href = "/login";
          return;
        }

        // Profile only feeds the avatar in the top bar; ignore failures.
        fetchProfile()
          .then((data) => !cancelled && setProfile(data))
          .catch(() => {});

        await loadData();
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Failed to load repositories.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [loadData]);

  const refresh = async () => {
    setRefreshing(true);
    setNotice(null);

    try {
      await loadData();
    } catch (err) {
      setNotice({ type: "error", text: err.message });
    } finally {
      setRefreshing(false);
    }
  };

  /* ------------------------------ actions ------------------------------ */

  const handleConnect = async () => {
    setConnecting(true);
    setNotice(null);

    try {
      await startGithubConnect(); // navigates away on success
    } catch (err) {
      setNotice({ type: "error", text: err.message });
      setConnecting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setNotice(null);

    try {
      const result = await importRepositories();

      setNotice({
        type: "success",
        text:
          result.imported === 0
            ? "GitHub returned no repositories that you own."
            : `Imported ${result.imported} ${
                result.imported === 1 ? "repository" : "repositories"
              } from GitHub.`,
      });

      await loadData();
    } catch (err) {
      setNotice({ type: "error", text: err.message || "Import failed." });
    } finally {
      setImporting(false);
    }
  };

  const handleSync = async (repo) => {
    setSyncingId(repo.id);
    setNotice(null);

    try {
      const result = await syncRepository(repo.id);

      setResults((current) => ({ ...current, [repo.id]: result }));
      setNotice({
        type: "success",
        text: `Synced ${repo.full_name} in ${(result.duration_ms / 1000).toFixed(
          1
        )} s.`,
      });

      await loadData();
    } catch (err) {
      setNotice({
        type: "error",
        text: `Could not sync ${repo.full_name}: ${err.message}`,
      });
      loadData().catch(() => {}); // the failed job still shows up in history
    } finally {
      setSyncingId(null);
    }
  };

  const handleSyncAll = async (targets) => {
    if (targets.length === 0) {
      return;
    }

    cancelSyncAll.current = false;
    setNotice(null);

    let succeeded = 0;
    let failed = 0;
    let stopReason = null;

    for (let index = 0; index < targets.length; index += 1) {
      if (cancelSyncAll.current) {
        stopReason = "Sync stopped.";
        break;
      }

      const repo = targets[index];
      setSyncAll({ done: index, total: targets.length, name: repo.full_name });

      try {
        const result = await syncRepository(repo.id);
        setResults((current) => ({ ...current, [repo.id]: result }));
        succeeded += 1;
      } catch (err) {
        failed += 1;

        // Rate limit / revoked token: every remaining repo would fail too.
        if (err.status === 429 || err.status === 409) {
          stopReason = err.message;
          break;
        }
      }
    }

    setSyncAll(null);
    setNotice({
      type: failed > 0 || stopReason ? "error" : "success",
      text:
        `Synced ${succeeded} of ${targets.length} repositories` +
        (failed ? `, ${failed} failed` : "") +
        (stopReason ? `. ${stopReason}` : "."),
    });

    loadData().catch(() => {});
  };

  /* ------------------------ derived list + stats ------------------------ */

  const visibleRepos = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return repos
      .filter((repo) => {
        if (visibility === "public" && repo.is_private) return false;
        if (visibility === "private" && !repo.is_private) return false;
        if (syncState === "synced" && !repo.synced_at) return false;
        if (syncState === "never" && repo.synced_at) return false;

        if (!needle) return true;

        return (
          repo.full_name.toLowerCase().includes(needle) ||
          (repo.description || "").toLowerCase().includes(needle)
        );
      })
      .sort(SORTERS[sortBy]);
  }, [repos, query, visibility, syncState, sortBy]);

  const stats = useMemo(() => {
    const synced = repos.filter((repo) => repo.synced_at);
    const lastSynced = synced.reduce(
      (latest, repo) =>
        !latest || new Date(repo.synced_at) > new Date(latest)
          ? repo.synced_at
          : latest,
      null
    );

    return {
      total: repos.length,
      privateCount: repos.filter((repo) => repo.is_private).length,
      synced: synced.length,
      commits: repos.reduce((sum, repo) => sum + repo.commit_count, 0),
      pullRequests: repos.reduce((sum, repo) => sum + repo.pull_request_count, 0),
      lastSynced,
    };
  }, [repos]);

  const repoNames = useMemo(
    () => Object.fromEntries(repos.map((repo) => [repo.id, repo.full_name])),
    [repos]
  );

  const initial = (
    profile?.full_name ||
    profile?.username ||
    account?.github_username ||
    "U"
  )
    .charAt(0)
    .toUpperCase();

  /* ------------------------------- render ------------------------------- */

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loader-orbit">
          <span></span>
        </div>

        <p>Loading repositories...</p>
        <span>Checking authentication & GitHub connection</span>
      </div>
    );
  }

  const filtersActive =
    query.trim() !== "" || visibility !== "all" || syncState !== "all";

  return (
    <AppShell
      crumb="Repositories"
      githubConnected={Boolean(account)}
      avatarUrl={profile?.avatar_url || ""}
      initial={initial}
    >
      <div className="dashboard-content repos-page">
        {/* HEADER */}

        <section className="repos-header">
          <div>
            <div className="eyebrow">
              <span></span>
              DATA · GITHUB SYNC
            </div>

            <h1>Repositories</h1>

            <p>
              Import the repositories you own and sync their commits, pull
              requests, issues, reviews and contributors into DevPulse.
            </p>
          </div>

          {account && (
            <div className="repos-actions">
              <button
                type="button"
                className="repo-btn"
                onClick={refresh}
                disabled={refreshing || busy}
              >
                {refreshing ? "Refreshing…" : "↻ Refresh"}
              </button>

              <button
                type="button"
                className="repo-btn"
                onClick={() => handleSyncAll(visibleRepos)}
                disabled={busy || visibleRepos.length === 0}
                title="Sync every repository currently shown, one after another"
              >
                ⟳ Sync {filtersActive ? "shown" : "all"}
              </button>

              <button
                type="button"
                className="repo-btn primary"
                onClick={handleImport}
                disabled={busy}
                title="Import your owned repositories from GitHub"
              >
                {importing ? "Importing from GitHub…" : "⭳ Import from GitHub"}
              </button>
            </div>
          )}
        </section>

        {notice && (
          <p className={`repo-banner ${notice.type}`}>{notice.text}</p>
        )}

        {error && (
          <div className="error-banner">
            <span>!</span>

            <div>
              <strong>Something went wrong</strong>
              <p>{error}</p>
            </div>
          </div>
        )}

        {syncAll && (
          <div className="repo-progress">
            <div className="repo-progress-text">
              <span>
                Syncing {syncAll.done + 1} of {syncAll.total} —{" "}
                <b>{syncAll.name}</b>
              </span>

              <button
                type="button"
                className="repo-link-button"
                onClick={() => {
                  cancelSyncAll.current = true;
                }}
              >
                Stop after this one
              </button>
            </div>

            <div className="repo-progress-bar">
              <div
                style={{
                  width: `${Math.round((syncAll.done / syncAll.total) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* NOT CONNECTED */}

        {!account ? (
          <section className="panel repo-connect">
            <div className="repo-empty-icon">◉</div>
            <h3>Connect GitHub to get started</h3>
            <p>
              DevPulse needs read access to your GitHub account before it can
              import repositories.
            </p>

            <button
              type="button"
              className="connect-button repo-connect-button"
              onClick={handleConnect}
              disabled={connecting}
            >
              <span>◉</span>
              {connecting ? "Redirecting to GitHub..." : "Connect GitHub"}
              <span className="arrow">→</span>
            </button>
          </section>
        ) : (
          <>
            {/* STATS */}

            <section className="repo-stats">
              <div className="repo-stat">
                <span>Repositories</span>
                <strong>{stats.total}</strong>
                <em>{stats.privateCount} private</em>
              </div>

              <div className="repo-stat">
                <span>Synced</span>
                <strong>
                  {stats.synced}
                  <small>/{stats.total}</small>
                </strong>
                <em>Last: {timeAgo(stats.lastSynced)}</em>
              </div>

              <div className="repo-stat">
                <span>Commits</span>
                <strong>{stats.commits.toLocaleString()}</strong>
                <em>across synced repos</em>
              </div>

              <div className="repo-stat">
                <span>Pull requests</span>
                <strong>{stats.pullRequests.toLocaleString()}</strong>
                <em>across synced repos</em>
              </div>
            </section>

            <div className="repos-layout">
              {/* LIST */}

              <section className="repos-main">
                <div className="repo-toolbar">
                  <input
                    type="search"
                    className="repo-search"
                    placeholder="Search repositories…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />

                  <select
                    value={visibility}
                    onChange={(event) => setVisibility(event.target.value)}
                    aria-label="Filter by visibility"
                  >
                    <option value="all">All visibility</option>
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>

                  <select
                    value={syncState}
                    onChange={(event) => setSyncState(event.target.value)}
                    aria-label="Filter by sync status"
                  >
                    <option value="all">Any sync status</option>
                    <option value="synced">Synced</option>
                    <option value="never">Never synced</option>
                  </select>

                  <select
                    value={sortBy}
                    onChange={(event) => setSortBy(event.target.value)}
                    aria-label="Sort repositories"
                  >
                    <option value="updated">Recently updated</option>
                    <option value="synced">Recently synced</option>
                    <option value="name">Name (A–Z)</option>
                  </select>
                </div>

                {repos.length === 0 ? (
                  <div className="panel repo-empty">
                    <div className="repo-empty-icon">◈</div>
                    <h4>No repositories imported yet</h4>
                    <p>
                      Click <strong>Import from GitHub</strong> to pull the
                      repositories you own into DevPulse.
                    </p>

                    <button
                      type="button"
                      className="repo-btn primary"
                      onClick={handleImport}
                      disabled={busy}
                    >
                      {importing ? "Importing from GitHub…" : "⭳ Import from GitHub"}
                    </button>
                  </div>
                ) : visibleRepos.length === 0 ? (
                  <div className="panel repo-empty">
                    <div className="repo-empty-icon">⌕</div>
                    <h4>No repositories match your filters</h4>
                    <button
                      type="button"
                      className="repo-btn"
                      onClick={() => {
                        setQuery("");
                        setVisibility("all");
                        setSyncState("all");
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                ) : (
                  <div className="repo-grid">
                    {visibleRepos.map((repo) => {
                      const isSyncing =
                        syncingId === repo.id ||
                        (syncAll && syncAll.name === repo.full_name);
                      const result = results[repo.id];

                      return (
                        <article className="panel repo-card" key={repo.id}>
                          <div className="repo-card-top">
                            <a
                              className="repo-name"
                              href={repo.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {repo.full_name}
                            </a>

                            <span
                              className={
                                repo.is_private
                                  ? "repo-pill private"
                                  : "repo-pill public"
                              }
                            >
                              {repo.is_private ? "Private" : "Public"}
                            </span>
                          </div>

                          <p className="repo-desc">
                            {repo.description || "No description provided."}
                          </p>

                          <div className="repo-counts">
                            <span>
                              <b>{repo.commit_count}</b> commits
                            </span>
                            <span>
                              <b>{repo.pull_request_count}</b> PRs
                            </span>
                            <span>
                              <b>{repo.issue_count}</b> issues
                            </span>
                            <span>
                              <b>{repo.contributor_count}</b> contributors
                            </span>
                          </div>

                          {result && (
                            <div className="repo-result">
                              Last run: {result.counts.commits} commits ·{" "}
                              {result.counts.pull_requests} PRs ·{" "}
                              {result.counts.issues} issues ·{" "}
                              {result.counts.reviews} reviews
                            </div>
                          )}

                          <div className="repo-card-bottom">
                            <div className="repo-meta">
                              <span
                                className={
                                  repo.synced_at
                                    ? "repo-sync-dot synced"
                                    : "repo-sync-dot"
                                }
                              />
                              {repo.synced_at
                                ? `Synced ${timeAgo(repo.synced_at)}`
                                : "Never synced"}
                              <span className="repo-branch">
                                ⎇ {repo.default_branch}
                              </span>
                            </div>

                            <button
                              type="button"
                              className="repo-btn small"
                              onClick={() => handleSync(repo)}
                              disabled={busy}
                            >
                              {isSyncing ? "Syncing…" : "Sync now"}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* HISTORY */}

              <aside className="panel repos-history">
                <div className="panel-header">
                  <div>
                    <span className="panel-kicker">SYNC HISTORY</span>
                    <h3>Recent jobs</h3>
                  </div>
                </div>

                {jobs.length === 0 ? (
                  <p className="repo-history-empty">
                    Import or sync a repository and its jobs will show up here.
                  </p>
                ) : (
                  <ul className="repo-jobs">
                    {jobs.map((job) => (
                      <li key={job.id}>
                        <div className="repo-job-top">
                          <strong>
                            {JOB_LABELS[job.job_type] || job.job_type}
                          </strong>

                          <span className={`repo-job-status ${job.status}`}>
                            {job.status}
                          </span>
                        </div>

                        <div className="repo-job-sub">
                          {job.repository_id
                            ? repoNames[job.repository_id] || "Removed repository"
                            : "All owned repositories"}
                        </div>

                        <div className="repo-job-sub">
                          {timeAgo(job.created_at)} · {formatDuration(job)}
                        </div>

                        {job.error_message && (
                          <div className="repo-job-error">
                            {job.error_message}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

export default Repositories;
