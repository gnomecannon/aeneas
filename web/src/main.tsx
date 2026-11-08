import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FeelLayer } from "./feel/FeelLayer";
import { initPwa } from "./pwa";
import "./styles.css";

initPwa();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <FeelLayer />
  </React.StrictMode>,
);
