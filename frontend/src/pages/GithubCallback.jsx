import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { completeGithubConnect } from "../lib/github";
import "./Dashboard.css";

// GitHub redirects here after the user approves (or denies) the OAuth App.
// We hand the code to the backend, then return to the dashboard with a notice.
function GithubCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // An OAuth code can only be exchanged once, and React StrictMode runs
  // effects twice in development - this makes sure we only try once.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;

    const finish = (type, text) => {
      navigate("/dashboard", {
        replace: true,
        state: { githubNotice: { type, text } },
      });
    };

    const completeConnection = async () => {
      const oauthError = searchParams.get("error");
      const code = searchParams.get("code");
      const state = searchParams.get("state");

      if (oauthError) {
        finish(
          "error",
          oauthError === "access_denied"
            ? "GitHub connection was cancelled."
            : searchParams.get("error_description") ||
                "GitHub could not authorize the connection."
        );
        return;
      }

      if (!code || !state) {
        finish(
          "error",
          "GitHub did not return an authorization code. Please try again."
        );
        return;
      }

      try {
        await completeGithubConnect(code, state);
        finish("success", "GitHub account connected.");
      } catch (err) {
        finish("error", err.message);
      }
    };

    completeConnection();
  }, [navigate, searchParams]);

  return (
    <div className="dashboard-loading">
      <div className="loader-orbit">
        <span></span>
      </div>

      <p>Connecting GitHub...</p>
      <span>Finishing authorization</span>
    </div>
  );
}

export default GithubCallback;
