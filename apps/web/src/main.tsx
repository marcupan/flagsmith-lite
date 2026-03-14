import React from "react";
import ReactDOM from "react-dom/client";
import posthog from "posthog-js";
import App from "./App";

// Initialise PostHog only when a key is provided.
// Local dev without VITE_POSTHOG_KEY works normally — no tracking.
const posthogKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const posthogHost =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://app.posthog.com";

if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    capture_pageview: false, // manual control — we track only flag events
    autocapture: false, // no auto click/input capture — privacy-friendly default
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
