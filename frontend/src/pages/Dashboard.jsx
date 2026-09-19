import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import "./Dashboard.css";

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

  useEffect(() => {
    const loadDashboard = async () => {
      if (!supabase) {
        setError("Supabase is not configured.");
        setLoading(false);
        return;
      }

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        setError(sessionError.message);
        setLoading(false);
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

      try {
        // 1. Verify backend authentication
        const authResponse = await fetch(`${API_BASE}/auth/me`, {
          headers,
        });

        const authData = await authResponse.json();

        if (!authResponse.ok) {
          throw new Error(authData.detail || "Backend authentication failed");
        }

        setBackendUser(authData);

        // 2. Create/sync application profile
        const profileSyncResponse = await fetch(`${API_BASE}/profile/sync`, {
          method: "POST",
          headers,
        });

        const profileSyncData = await profileSyncResponse.json();

        if (!profileSyncResponse.ok) {
          throw new Error(
            profileSyncData.detail || "Profile synchronization failed"
          );
        }

        // 3. Fetch the complete profile
        const profileResponse = await fetch(`${API_BASE}/profile`, {
          headers,
        });

        const profileData = await profileResponse.json();

        if (!profileResponse.ok) {
          throw new Error(profileData.detail || "Failed to load profile");
        }

        setProfile(profileData);

        setUsername(profileData.username || "");
        setFullName(profileData.full_name || "");
        setAvatarUrl(profileData.avatar_url || "");
      } catch (err) {
        setError(err.message);
      }

      setLoading(false);
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

      const fileExtension = file.name.split(".").pop()?.toLowerCase() || "png";
      const filePath = `${currentUser.id}/avatar.${fileExtension}`;

      const { error: uploadError } = await supabase.storage
  .from("avatars")
  .upload(filePath, file, {
    upsert: true,
    contentType: file.type,
  });

if (uploadError) {
  throw uploadError;
}

const {
  data: { publicUrl },
} = supabase.storage
  .from("avatars")
  .getPublicUrl(filePath);

setAvatarUrl(publicUrl);

setProfileMessage(
  "Avatar uploaded. Click Save changes to save your profile."
);
      
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setUploadingAvatar(false);
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

  const handleLogout = async () => {
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
    window.location.href = "/login";
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
    profile?.full_name || profile?.username || user?.email?.split("@")[0] || "Developer";

  const initial = (profile?.full_name || profile?.username || user?.email || "U")
    .charAt(0)
    .toUpperCase();

  return (
    <div className="dashboard-shell">
      {/* ================= SIDEBAR ================= */}

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">DP</div>

          <div>
            <h2>DevPulse</h2>
            <span>Developer intelligence</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">
            <span className="nav-label">WORKSPACE</span>

            <a className="nav-item active" href="/dashboard">
              <span className="nav-icon">⌂</span>
              Overview
            </a>

            <a className="nav-item disabled" href="#repositories">
              <span className="nav-icon">◈</span>
              Repositories
              <span className="coming-soon">Soon</span>
            </a>

            <a className="nav-item disabled" href="#activity">
              <span className="nav-icon">◌</span>
              Activity
              <span className="coming-soon">Soon</span>
            </a>

            <a className="nav-item disabled" href="#analytics">
              <span className="nav-icon">⌁</span>
              Analytics
              <span className="coming-soon">Soon</span>
            </a>
          </div>

          <div className="nav-section">
            <span className="nav-label">INTEGRATIONS</span>

            <a className="nav-item disabled" href="#github">
              <span className="nav-icon">◉</span>
              GitHub
              <span className="coming-soon">Soon</span>
            </a>
          </div>
        </nav>

        <div className="sidebar-bottom">
          <div className="system-status">
            <div className="status-dot"></div>

            <div>
              <strong>DevPulse Core</strong>
              <span>Systems operational</span>
            </div>
          </div>

          <button className="logout-button" onClick={handleLogout}>
            <span>↪</span>
            Logout
          </button>
        </div>
      </aside>

      {/* ================= MAIN ================= */}

      <main className="dashboard-main">
        {/* TOPBAR */}

        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <b>/</b>
            <strong>Overview</strong>
          </div>

          <div className="topbar-right">
            <div className="connection-status">
              <span className="status-dot"></span>
              Backend connected
            </div>

            <div className="avatar">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="Your avatar"
                  className="topbar-avatar-image"
                />
              ) : (
                initial
              )}
            </div>
          </div>
        </header>

        {/* CONTENT */}

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
                      showEditProfile ? handleCancelEdit() : setShowEditProfile(true)
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
                    <h2>{profile?.full_name || profile?.username || "Developer"}</h2>

                    <p>{user?.email || "Email unavailable"}</p>

                    <div className="profile-meta">
                      <span>
                        <b>ID</b>
                        {backendUser?.id ? `${backendUser.id.slice(0, 8)}...` : "Unavailable"}
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

                  {profileError && <p className="profile-error">{profileError}</p>}
                  {profileMessage && <p className="profile-success">{profileMessage}</p>}

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

            <div className="panel github-panel">
              <div className="github-decoration">◉</div>

              <div className="panel-header">
                <div>
                  <span className="panel-kicker">INTEGRATION</span>
                  <h3>GitHub workspace</h3>
                </div>

                <span className="integration-state">Not connected</span>
              </div>

              <p className="panel-description">
                Connect GitHub to start importing repositories, commits, pull
                requests, issues and contributor activity.
              </p>

              <button className="connect-button">
                <span>◉</span>
                Connect GitHub
                <span className="arrow">→</span>
              </button>
            </div>
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

                  <h4>Waiting for your GitHub signal</h4>

                  <p>
                    Connect a GitHub account and DevPulse will begin building
                    your engineering activity timeline.
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

                <div className="health-row pending">
                  <div className="health-name">
                    <span className="health-icon">○</span>
                    GitHub API
                  </div>

                  <span className="health-value">Awaiting connection</span>
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

              <div className="pipeline-line"></div>

              <div className="pipeline-step">
                <div className="step-number">03</div>

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
      </main>
    </div>
  );
}

export default Dashboard;