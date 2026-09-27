import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { applyProfile, type Profile } from "./types";

async function boot() {
  try {
    const r = await fetch("/profile", { cache: "no-store" });
    if (r.ok) applyProfile((await r.json()) as Profile);
  } catch {
    /* engine not up yet: show the defaults, the feed reconnects on its own */
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
