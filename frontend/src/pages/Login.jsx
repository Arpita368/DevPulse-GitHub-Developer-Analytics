import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event) => {
    event.preventDefault();

    setError("");

    if (!supabase) {
      setError("Supabase is not configured yet.");
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    window.location.href = "/dashboard";
  };

  const handleGoogleLogin = async () => {
    setError("");

    if (!supabase) {
      setError("Supabase is not configured yet.");
      return;
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });

    if (error) {
      setError(error.message);
    }
  };

  const handleGithubLogin = async () => {
    setError("");

    if (!supabase) {
      setError("Supabase is not configured yet.");
      return;
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });

    if (error) {
      setError(error.message);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">

        <h1>Welcome back</h1>

        <p className="subtitle">
          Login to your DevPulse account
        </p>

        <form onSubmit={handleLogin}>

          <label>Email</label>

          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label>Password</label>

          <input
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          {error && (
            <p className="error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
          >
            {loading ? "Logging in..." : "Login"}
          </button>

        </form>

        <div className="divider">
          <span>OR</span>
        </div>

        <button
          type="button"
          className="social-button"
          onClick={handleGoogleLogin}
        >
          <span className="google-icon">G</span>
          Continue with Google
        </button>

        <button
          type="button"
          className="social-button"
          onClick={handleGithubLogin}
        >
          <span className="github-icon">●</span>
          Continue with GitHub
        </button>

        <p className="switch-auth">
          Don't have an account?{" "}
          <Link to="/register">
            Create account
          </Link>
        </p>

      </div>
    </div>
  );
}

export default Login;