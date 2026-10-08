import React from "react";
import { createRoot } from "react-dom/client";
import { DemoWorkspace } from "./workspace.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><DemoWorkspace /></React.StrictMode>,
);
