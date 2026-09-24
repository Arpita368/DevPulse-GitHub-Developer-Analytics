import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import AppShell from "../components/AppShell";
import { supabase } from "../lib/supabase";
import {
  disconnectGithub,
  fetchGithubStatus,
  linkGithubFromLogin,
  startGithubConnect,
  fetchRepositories,
  importRepositories,
} from "../lib/github";
import "./Dashboard.css";
import "./Repositories.css";

// Falls back to localhost for local dev, but can be overridden via
// VITE_API_URL so the same build works against a deployed backend.
const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

function Dashboard() {
  const [user, setUser] = useState(null);
  
  const [backendUser, setBackendUser] = useState(null);
  const [profile, setProfile] = useState(null);

  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");

  const [profileError, setProfileError] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const location = useLocation();
  const navigate = useNavigate();

  const [githubAccount, setGithubAccount] = useState(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const [repositories, setRepositories] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [importingRepos, setImportingRepos] = useState(false);
  const [repoNotice, setRepoNotice] = useState(null);

  // Outcome of the last GitHub action, e.g. when returning from GitHub.
  const [githubNotice, setGithubNotice] = useState(
    location.state?.githubNotice ?? null
  );

  useEffect(() => {
    // Show the notice once; refreshing the page shouldn't bring it back.
    if (location.state?.githubNotice) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  useEffect(() => {
    // Coming back to this page with the browser's Back button after being
    // sent to GitHub can restore it mid-redirect; re-enable the buttons.
    const handlePageShow = (event) => {
      if (event.persisted) {
        setGithubBusy(false);
      }
    };

    window.addEventListener("pageshow", handlePageShow);

    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  useEffect(() => {
    const loadDashboard = async () => {
      if (!supabase) {
        setError("Supabase is not configured.");
        setLoading(false);
        return;
      }

      // Fail the whole load after 12s so we never spin forever
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) {
          setError(sessionError.message);
          return;
        }

        if (!session) {
          window.location.href = "/login";
          return;
        }

        setUser(session.user);

        const headers = {
          Authorization: `Bearer ${session.access_token}`,
        };

        // 1. Verify backend authentication
        const authResponse = await fetch(`${API_BASE}/auth/me`, {
          headers,
          signal: controller.signal,
        });

        const authData = await authResponse.json().catch(() => ({}));

        if (!authResponse.ok) {
          throw new Error(authData.detail || "Backend authentication failed");
        }

        setBackendUser(authData);

        // 2. Create/sync application profile
        const profileSyncResponse = await fetch(`${API_BASE}/profile/sync`, {
          method: "POST",
          headers,
          signal: controller.signal,
        });

        const profileSyncData = await profileSyncResponse
          .json()
          .catch(() => ({}));

        if (!profileSyncResponse.ok) {
          throw new Error(
            profileSyncData.detail || "Profile synchronization failed"
          );
        }

        // 3. Fetch the complete profile
        const profileResponse = await fetch(`${API_BASE}/profile`, {
          headers,
          signal: controller.signal,
        });

        const profileData = await profileResponse.json().catch(() => ({}));

        if (!profileResponse.ok) {
          throw new Error(profileData.detail || "Failed to load profile");
        }

        setProfile(profileData);
        setUsername(profileData.username || "");
        setFullName(profileData.full_name || "");
        setAvatarUrl(profileData.avatar_url || "");

        // 4. GitHub (must not block the rest of the dashboard)
        let linkedFromLogin = false;

        try {
          linkedFromLogin = await linkGithubFromLogin(session);
        } catch (linkError) {
          setGithubNotice({ type: "error", text: linkError.message });
        }

        try {
          const githubStatus = await fetchGithubStatus();
          setGithubAccount(githubStatus.account);

          // Repositories only exist once GitHub is connected.
          if (githubStatus.account) {
            try {
              const repos = await fetchRepositories();
              setRepositories(Array.isArray(repos) ? repos : []);
            } catch {
              // Not fatal: the Repositories panel has its own Refresh button.
              setRepositories([]);
            }
          }

          if (linkedFromLogin) {
            setGithubNotice({
              type: "success",
              text: "GitHub connected automatically from your GitHub login.",
            });
          }
        } catch (statusError) {
          setGithubNotice(
            (current) =>
              current ?? { type: "error", text: statusError.message }
          );
        }
      } catch (err) {
        if (err.name === "AbortError") {
          setError(
            "Timed out talking to the backend. Is the FastAPI server running on http://127.0.0.1:8000?"
          );
        } else {
          setError(err.message || "Failed to load dashboard");
        }
      } finally {
        clearTimeout(timeoutId);
        setLoading(false);
      }
    };
    

    loadDashboard();
  }, []);

  const handleSaveProfile = async () => {
    setProfileError("");
    setProfileMessage("");

    if (!supabase) {
      setProfileError("Supabase is not configured.");
      return;
    }

    if (!username.trim()) {
      setProfileError("Username cannot be empty.");
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      window.location.href = "/login";
      return;
    }

    setSavingProfile(true);

    try {
      const response = await fetch(`${API_BASE}/profile`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: username.trim(),
          full_name: fullName.trim() || null,
          avatar_url: avatarUrl || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Failed to update profile");
      }

      setProfile(data);
      setUsername(data.username || "");
      setFullName(data.full_name || "");
      setAvatarUrl(data.avatar_url || "");
      setProfileMessage("Profile updated successfully.");
      setShowEditProfile(false);
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarUpload = async (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setProfileError("");
    setProfileMessage("");

    if (!supabase) {
      setProfileError("Supabase is not configured.");
      return;
    }

    if (!file.type.startsWith("image/")) {
      setProfileError("Please select an image file.");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setProfileError("Avatar must be smaller than 2 MB.");
      return;
    }

    setUploadingAvatar(true);

    try {
      const {
        data: { user: currentUser },
      } = await supabase.auth.getUser();

      if (!currentUser) {
        window.location.href = "/login";
        return;
      }

      const fileExtension =
        file.name.split(".").pop()?.toLowerCase() || "png";

      // Create a unique filename for every upload
      const fileName = `avatar-${Date.now()}.${fileExtension}`;
      const filePath = `${currentUser.id}/${fileName}`;

      // Upload the new avatar
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, {
          upsert: false,
          contentType: file.type,
        });

      if (uploadError) {
        throw uploadError;
      }

      // Get the public URL of the new avatar
      const {
        data: { publicUrl },
      } = supabase.storage.from("avatars").getPublicUrl(filePath);

      // Save the new URL in React state
      setAvatarUrl(publicUrl);
      setProfileMessage(
        "New avatar uploaded. Click Save changes to apply it."
      );
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setUploadingAvatar(false);
      // Allow selecting the same file again later
      event.target.value = "";
    }
  };

  const handleCancelEdit = () => {
    setShowEditProfile(false);
    setProfileError("");
    setProfileMessage("");
    // Reset any unsaved edits back to the last saved profile.
    setUsername(profile?.username || "");
    setFullName(profile?.full_name || "");
    setAvatarUrl(profile?.avatar_url || "");
  };

  const handleConnectGithub = async () => {
    setGithubNotice(null);
    setGithubBusy(true);

    try {
      // Sends the browser to GitHub; on success nothing below this runs.
      await startGithubConnect();
    } catch (err) {
      setGithubNotice({ type: "error", text: err.message });
      setGithubBusy(false);
    }
  };

  const handleDisconnectGithub = async () => {
    setGithubNotice(null);
    setGithubBusy(true);

    try {
      const githubStatus = await disconnectGithub();
      setGithubAccount(githubStatus.account);
      setConfirmingDisconnect(false);
      setGithubNotice({
        type: "success",
        text: "GitHub account disconnected.",
      });
    } catch (err) {
      setGithubNotice({ type: "error", text: err.message });
    } finally {
      setGithubBusy(false);
    }
  };

    const loadRepositories = async () => {
    setReposLoading(true);
    setRepoNotice(null);
    try {
      const repos = await fetchRepositories();
      setRepositories(Array.isArray(repos) ? repos : []);
    } catch (err) {
      setRepoNotice({ type: "error", text: err.message });
    } finally {
      setReposLoading(false);
    }
  };

  const handleImportRepositories = async () => {
  if (!githubAccount) {
    setRepoNotice({
      type: "error",
      text: "Connect GitHub before importing repositories.",
    });
    return;
  }

  setImportingRepos(true);
  setRepoNotice(null);

  try {
    const result = await importRepositories();
    setRepoNotice({
      type: "success",
      text: `Imported ${result.imported} repositories (job ${result.status}).`,
    });
    await loadRepositories();
  } catch (err) {
    setRepoNotice({
      type: "error",
      text: err.message || "Import failed",
    });
  } finally {
    setImportingRepos(false); // critical — never leave this true
  }
};

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loader-orbit">
          <span></span>
        </div>

        <p>Initializing DevPulse...</p>
        <span>Checking authentication & workspace</span>
      </div>
    );
  }

  const displayName =
    profile?.full_name ||
    profile?.username ||
    user?.email?.split("@")[0] ||
    "Developer";

  const initial = (
    profile?.full_name ||
    profile?.username ||
    user?.email ||
    "U"
  )
    .charAt(0)
    .toUpperCase();

  return (
    <AppShell
      crumb="Overview"
      githubConnected={Boolean(githubAccount)}
      avatarUrl={avatarUrl}
      initial={initial}
    >
        <div className="dashboard-content">
          {/* HERO */}

          <section className="hero-section">
            <div className="hero-copy">
              <div className="eyebrow">
                <span></span>
                DEVELOPER WORKSPACE
              </div>

              <h1>
                Good to see you,
                <br />
                <span>{displayName}.</span>
              </h1>

              <p>
                DevPulse turns your GitHub activity into an engineering
                intelligence workspace.
              </p>
            </div>

            <div className="hero-visual">
              <div className="pulse-ring ring-one"></div>
              <div className="pulse-ring ring-two"></div>
              <div className="pulse-core">
                <span>DP</span>
              </div>

              <div className="floating-node node-one">
                <span>⌘</span>
              </div>

              <div className="floating-node node-two">
                <span>◈</span>
              </div>

              <div className="floating-node node-three">
                <span>⌁</span>
              </div>
            </div>
          </section>

          {/* ACCOUNT / CONNECTION GRID */}

          <section className="workspace-grid">
            {/* PROFILE */}

            <div className="panel profile-panel">
              <div className="panel-header">
                <div>
                  <span className="panel-kicker">IDENTITY</span>
                  <h3>Developer profile</h3>
                </div>

                <div className="profile-header-actions">
                  <span className="verified-badge">✓ Verified</span>

                  <button
                    type="button"
                    className="edit-profile-toggle"
                    onClick={() =>
                      showEditProfile
                        ? handleCancelEdit()
                        : setShowEditProfile(true)
                    }
                  >
                    {showEditProfile ? "Cancel" : "✎ Edit"}
                  </button>
                </div>
              </div>

              {!showEditProfile ? (
                <div className="profile-body">
                  <div className="large-avatar">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt="Profile avatar"
                        className="dashboard-avatar-image"
                      />
                    ) : (
                      initial
                    )}
                  </div>

                  <div className="profile-info">
                    <h2>
                      {profile?.full_name ||
                        profile?.username ||
                        "Developer"}
                    </h2>

                    <p>{user?.email || "Email unavailable"}</p>

                    <div className="profile-meta">
                      <span>
                        <b>ID</b>
                        {backendUser?.id
                          ? `${backendUser.id.slice(0, 8)}...`
                          : "Unavailable"}
                      </span>

                      <span>
                        <b>USERNAME</b>
                        {profile?.username || "Not set"}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="profile-form">
                  <div className="avatar-section">
                    <div className="large-avatar">
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt="Profile avatar"
                          className="dashboard-avatar-image"
                        />
                      ) : (
                        initial
                      )}
                    </div>

                    <label className="avatar-upload-button">
                      {uploadingAvatar ? "Uploading..." : "Change avatar"}
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleAvatarUpload}
                        disabled={uploadingAvatar}
                        style={{ display: "none" }}
                      />
                    </label>
                  </div>

                  <div className="profile-field">
                    <label htmlFor="profile-username">Username</label>
                    <input
                      id="profile-username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. jane-dev"
                    />
                  </div>

                  <div className="profile-field">
                    <label htmlFor="profile-fullname">Full name</label>
                    <input
                      id="profile-fullname"
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="e.g. Jane Doe"
                    />
                  </div>

                  {profileError && (
                    <p className="profile-error">{profileError}</p>
                  )}
                  {profileMessage && (
                    <p className="profile-success">{profileMessage}</p>
                  )}

                  <div className="profile-form-actions">
                    <button
                      type="button"
                      className="save-profile-button"
                      onClick={handleSaveProfile}
                      disabled={savingProfile || uploadingAvatar}
                    >
                      {savingProfile ? "Saving..." : "Save changes"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* GITHUB CONNECTION */}

            <div className="panel github-panel" id="github">
              <div className="github-decoration">◉</div>

              <div className="panel-header">
                <div>
                  <span className="panel-kicker">INTEGRATION</span>
                  <h3>GitHub workspace</h3>
                </div>

                <span
                  className={
                    githubAccount
                      ? "integration-state connected"
                      : "integration-state"
                  }
                >
                  {githubAccount ? "Connected" : "Not connected"}
                </span>
              </div>

              {githubNotice && (
                <p className={`github-notice ${githubNotice.type}`}>
                  {githubNotice.text}
                </p>
              )}

              {githubAccount ? (
                <div className="github-account">
                  <div className="github-account-info">
                    <div className="github-avatar">
                      {githubAccount.avatar_url ? (
                        <img
                          src={githubAccount.avatar_url}
                          alt={`${githubAccount.github_username} on GitHub`}
                          className="dashboard-avatar-image"
                        />
                      ) : (
                        githubAccount.github_username.charAt(0).toUpperCase()
                      )}
                    </div>

                    <div>
                      <a
                        className="github-username"
                        href={githubAccount.profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        @{githubAccount.github_username}
                      </a>

                      <span className="github-connected-since">
                        Connected{" "}
                        {new Date(
                          githubAccount.created_at
                        ).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  {!confirmingDisconnect ? (
                    <button
                      type="button"
                      className="disconnect-button"
                      onClick={() => setConfirmingDisconnect(true)}
                      disabled={githubBusy}
                    >
                      Disconnect GitHub
                    </button>
                  ) : (
                    <div className="disconnect-confirm">
                      <p>
                        This removes @{githubAccount.github_username} from
                        DevPulse, along with the repositories and activity
                        imported through it. You can reconnect at any time.
                      </p>

                      <div className="disconnect-actions">
                        <button
                          type="button"
                          className="disconnect-confirm-button"
                          onClick={handleDisconnectGithub}
                          disabled={githubBusy}
                        >
                          {githubBusy ? "Disconnecting..." : "Yes, disconnect"}
                        </button>

                        <button
                          type="button"
                          className="disconnect-cancel-button"
                          onClick={() => setConfirmingDisconnect(false)}
                          disabled={githubBusy}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <p className="panel-description">
                    Connect GitHub to start importing repositories, commits,
                    pull requests, issues and contributor activity.
                  </p>

                  <button
                    type="button"
                    className="connect-button"
                    onClick={handleConnectGithub}
                    disabled={githubBusy}
                  >
                    <span>◉</span>
                    {githubBusy
                      ? "Redirecting to GitHub..."
                      : "Connect GitHub"}
                    <span className="arrow">→</span>
                  </button>
                </>
              )}
            </div>
          </section>
            
                    {/* ================= REPOSITORIES (summary) ================= */}

          <section className="panel repo-summary" id="repositories">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">DATA</span>
                <h3>Repositories</h3>
              </div>

              <div className="repo-summary-actions">
                <button
                  type="button"
                  className="repo-btn small"
                  onClick={loadRepositories}
                  disabled={!githubAccount || reposLoading || importingRepos}
                >
                  {reposLoading ? "Refreshing…" : "Refresh"}
                </button>

                <button
                  type="button"
                  className="repo-btn small primary"
                  onClick={handleImportRepositories}
                  disabled={!githubAccount || importingRepos}
                  title={
                    !githubAccount
                      ? "Connect GitHub first"
                      : "Import owned repositories from GitHub"
                  }
                >
                  {importingRepos ? "Importing from GitHub…" : "Import from GitHub"}
                </button>
              </div>
            </div>

            {repoNotice && (
              <p className={`github-notice ${repoNotice.type}`}>
                {repoNotice.text}
              </p>
            )}

            {!githubAccount ? (
              <p className="panel-description">
                Connect GitHub first, then import your repositories.
              </p>
            ) : repositories.length === 0 ? (
              <div className="repo-empty">
                <div className="repo-empty-icon">◈</div>
                <h4>No repositories imported yet</h4>
                <p>
                  Click <strong>Import from GitHub</strong> to pull your owned
                  repositories into DevPulse.
                </p>
              </div>
            ) : (
              <>
                <ul className="repo-summary-list">
                  {repositories.slice(0, 5).map((repo) => (
                    <li key={repo.id}>
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {repo.full_name}
                      </a>

                      <span>
                        {repo.is_private ? "Private" : "Public"} ·{" "}
                        {repo.synced_at
                          ? `Synced ${new Date(repo.synced_at).toLocaleDateString()}`
                          : "Never synced"}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="repo-summary-footer">
                  <Link to="/dashboard/repositories">
                    {repositories.length > 5
                      ? `View all ${repositories.length} repositories →`
                      : "Open Repositories to sync and explore →"}
                  </Link>
                </div>
              </>
            )}
          </section>

          {/* ANALYTICS PREVIEW */}

          <section className="analytics-layout">
            <div className="panel activity-panel">
              <div className="panel-header">
                <div>
                  <span className="panel-kicker">ENGINEERING ACTIVITY</span>
                  <h3>Development pulse</h3>
                </div>

                <span className="time-filter">Last 30 days</span>
              </div>

              <div className="activity-empty">
                <div className="activity-grid">
                  {[...Array(42)].map((_, index) => (
                    <span
                      key={index}
                      className={
                        index % 9 === 0
                          ? "activity-cell active"
                          : index % 5 === 0
                          ? "activity-cell medium"
                          : "activity-cell"
                      }
                    />
                  ))}
                </div>

                <div className="empty-message">
                  <div className="empty-icon">⌁</div>

                  <h4>
                    {githubAccount
                      ? `${repositories.length} ${
                          repositories.length === 1 ? "repository" : "repositories"
                        } imported`
                      : "Waiting for your GitHub signal"}
                  </h4>

                  <p>
                    {!githubAccount
                      ? "Connect a GitHub account and DevPulse will begin building your engineering activity timeline."
                      : repositories.length === 0
                      ? "Import your repositories, then sync them to start building your activity timeline."
                      : "Sync a repository from the Repositories tab. The activity timeline built from that data will appear here."}
                  </p>
                </div>
              </div>
            </div>

            {/* HEALTH */}

            <div className="panel health-panel">
              <div className="panel-header">
                <div>
                  <span className="panel-kicker">SYSTEM HEALTH</span>
                  <h3>Workspace status</h3>
                </div>

                <span className="health-indicator">● Healthy</span>
              </div>

              <div className="health-list">
                <div className="health-row">
                  <div className="health-name">
                    <span className="health-icon">◆</span>
                    Authentication
                  </div>

                  <span className="health-value">Operational</span>
                </div>

                <div className="health-row">
                  <div className="health-name">
                    <span className="health-icon">◆</span>
                    Backend API
                  </div>

                  <span className="health-value">Connected</span>
                </div>

                <div className="health-row">
                  <div className="health-name">
                    <span className="health-icon">◆</span>
                    Profile service
                  </div>

                  <span className="health-value">Synced</span>
                </div>

                <div
                  className={
                    githubAccount ? "health-row" : "health-row pending"
                  }
                >
                  <div className="health-name">
                    <span className="health-icon">
                      {githubAccount ? "◆" : "○"}
                    </span>
                    GitHub API
                  </div>

                  <span className="health-value">
                    {githubAccount ? "Connected" : "Awaiting connection"}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* ROADMAP / PIPELINE */}

          <section className="panel pipeline-panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">DEV PULSE PIPELINE</span>
                <h3>From code to engineering intelligence</h3>
              </div>

              <span className="pipeline-label">CORE BUILD</span>
            </div>

            <div className="pipeline">
              <div className="pipeline-step completed">
                <div className="step-number">✓</div>

                <div>
                  <strong>Authentication</strong>
                  <span>Supabase + FastAPI</span>
                </div>
              </div>

              <div className="pipeline-line completed-line"></div>

              <div className="pipeline-step completed">
                <div className="step-number">✓</div>

                <div>
                  <strong>Developer profile</strong>
                  <span>Profile synchronization</span>
                </div>
              </div>

              <div
                className={
                  repositories.length > 0
                    ? "pipeline-line completed-line"
                    : "pipeline-line"
                }
              ></div>

              <div
                className={
                  repositories.length > 0
                    ? "pipeline-step completed"
                    : "pipeline-step"
                }
              >
                <div className="step-number">
                  {repositories.length > 0 ? "✓" : "03"}
                </div>

                <div>
                  <strong>GitHub sync</strong>
                  <span>Repositories & activity</span>
                </div>
              </div>

              <div className="pipeline-line"></div>

              <div className="pipeline-step">
                <div className="step-number">04</div>

                <div>
                  <strong>Analytics</strong>
                  <span>Engineering metrics</span>
                </div>
              </div>
            </div>
          </section>

          {/* ERROR */}

          {error && (
            <div className="error-banner">
              <span>!</span>

              <div>
                <strong>Something went wrong</strong>
                <p>{error}</p>
              </div>
            </div>
          )}

          <footer className="dashboard-footer">
            <span>DevPulse</span>
            <span>Developer intelligence platform</span>
            <span>Core build · v0.1</span>
          </footer>
        </div>
    </AppShell>
  );
}

export default Dashboard;