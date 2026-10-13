import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

declare const __HUIYI_CLINICAL_EVALUATION__: boolean;
declare const __HUIYI_EDGE_GATEWAY__: boolean;
declare const __HUIYI_PRODUCTION_BUILD__: boolean;

const root = createRoot(document.getElementById("root")!);
if (__HUIYI_CLINICAL_EVALUATION__) {
  void import("./clinicalEvaluationWorkspace.js").then(({ ClinicalEvaluationWorkspace }) => {
    root.render(<React.StrictMode><ClinicalEvaluationWorkspace /></React.StrictMode>);
  });
} else if (__HUIYI_EDGE_GATEWAY__) {
  void import("./edgeWorkspace.js").then(({ EdgeWorkspace }) => {
    root.render(<React.StrictMode><EdgeWorkspace /></React.StrictMode>);
  });
} else if (__HUIYI_PRODUCTION_BUILD__) {
  void import("./productionWorkspace.js").then(({ ProductionWorkspace }) => {
    root.render(<React.StrictMode><ProductionWorkspace /></React.StrictMode>);
  });
} else {
  void import("./workspace.js").then(({ DemoWorkspace }) => {
    root.render(<React.StrictMode><DemoWorkspace /></React.StrictMode>);
  });
}
