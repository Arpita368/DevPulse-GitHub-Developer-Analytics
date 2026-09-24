import { Link, NavLink } from "react-router-dom";

import { supabase } from "../lib/supabase";

// Sidebar + top bar shared by every signed-in page, so navigation between
// tabs is client-side (no full reload) and the "active" highlight is correct.
function AppShell({
  crumb = "Overview",
  githubConnected = false,
  avatarUrl = "",
  initial = "U",
  children,
}) {
  const handleLogout = async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }

    window.location.href = "/login";
  };

  const navClass = ({ isActive }) =>
    isActive ? "nav-item active" : "nav-item";

  return (
    <div className="dashboard-shell">
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

            <NavLink to="/dashboard" end className={navClass}>
              <span className="nav-icon">⌂</span>
              Overview
            </NavLink>

            <NavLink to="/dashboard/repositories" className={navClass}>
              <span className="nav-icon">◈</span>
              Repositories
            </NavLink>

            <span className="nav-item disabled" aria-disabled="true">
              <span className="nav-icon">◌</span>
              Activity
              <span className="coming-soon">Soon</span>
            </span>

            <span className="nav-item disabled" aria-disabled="true">
              <span className="nav-icon">⌁</span>
              Analytics
              <span className="coming-soon">Soon</span>
            </span>
          </div>

          <div className="nav-section">
            <span className="nav-label">INTEGRATIONS</span>

            <Link className="nav-item" to="/dashboard#github">
              <span className="nav-icon">◉</span>
              GitHub
              {githubConnected && (
                <span className="nav-status">Connected</span>
              )}
            </Link>
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

      <main className="dashboard-main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <b>/</b>
            <strong>{crumb}</strong>
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

        {children}
      </main>
    </div>
  );
}

export default AppShell;
