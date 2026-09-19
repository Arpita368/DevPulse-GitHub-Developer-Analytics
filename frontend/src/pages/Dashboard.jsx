import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

function Dashboard() {
  const [user, setUser] = useState(null);
  const [backendUser, setBackendUser] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadUser = async () => {
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

      try {
        const response = await fetch(
          "http://127.0.0.1:8000/auth/me",
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || "Backend authentication failed");
        }

        setBackendUser(data);
      } catch (error) {
        setError(error.message);
      }

      setLoading(false);
    };

    loadUser();
  }, []);

  const handleLogout = async () => {
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  if (loading) {
    return <p>Loading...</p>;
  }

  return (
    <div>
      <h1>DevPulse Dashboard</h1>

      {user && (
        <p>
          Logged in as{" "}
          <strong>
            {user.user_metadata?.username || user.email}
          </strong>
        </p>
      )}

      {backendUser && (
        <div>
          <h2>Backend Authentication</h2>

          <p>
            Backend authenticated: <strong>Yes</strong>
          </p>

          <p>
            User ID: <strong>{backendUser.id}</strong>
          </p>

          <p>
            Email: <strong>{backendUser.email || "Not available"}</strong>
          </p>
        </div>
      )}

      {error && (
        <p>
          Backend error: <strong>{error}</strong>
        </p>
      )}

      <button onClick={handleLogout}>
        Logout
      </button>
    </div>
  );
}

export default Dashboard;