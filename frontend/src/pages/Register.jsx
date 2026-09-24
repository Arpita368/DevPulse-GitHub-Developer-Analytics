import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { GITHUB_LOGIN_SCOPES } from "../lib/github";

function Register() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const handleRegister = async (event) => {
    event.preventDefault();

    setError("");
    setMessage("");

    if (!username.trim()) {
      setError("Please enter a username.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    if (!supabase) {
      setError("Supabase is not configured yet.");
      return;
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username: username.trim(),
        },
      },
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    if (data.user && !data.session) {
      setMessage(
        "Account created. Please check your email to verify your account."
      );
      return;
    }

    window.location.href = "/dashboard";
  };

  const handleGoogleRegister = async () => {
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

  const handleGithubRegister = async () => {
    setError("");

    if (!supabase) {
      setError("Supabase is not configured yet.");
      return;
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
        scopes: GITHUB_LOGIN_SCOPES,
      },
    });

    if (error) {
      setError(error.message);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">

        <h1>Create account</h1>

        <p className="subtitle">
          Create your DevPulse account
        </p>

        <form onSubmit={handleRegister}>

          <label>Username</label>

          <input
            type="text"
            placeholder="Choose a username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />

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
            placeholder="Create a password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          <label>Confirm Password</label>

          <input
            type="password"
            placeholder="Confirm your password"
            value={confirmPassword}
            onChange={(event) =>
              setConfirmPassword(event.target.value)
            }
            required
          />

          {error && (
            <p className="error">
              {error}
            </p>
          )}

          {message && (
            <p className="success">
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
          >
            {loading ? "Creating account..." : "Create account"}
          </button>

        </form>

        <div className="divider">
          <span>OR</span>
        </div>

        <button
          type="button"
          className="social-button"
          onClick={handleGoogleRegister}
        >
          <span className="google-icon">G</span>
          Continue with Google
        </button>

        <button
          type="button"
          className="social-button"
          onClick={handleGithubRegister}
        >
          <span className="github-icon">●</span>
          Continue with GitHub
        </button>

        <p className="switch-auth">
          Already have an account?{" "}
          <Link to="/login">
            Login
          </Link>
        </p>

      </div>
    </div>
  );
}

export default Register;