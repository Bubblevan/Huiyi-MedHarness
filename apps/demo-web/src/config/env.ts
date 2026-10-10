export interface HuiyiRuntimeConfig {
  environmentName?: string;
  providerName?: string;
  modelName?: string;
  version?: string;
  auditUrl?: string;
  patientContextUrl?: string;
}

declare global {
  interface Window {
    HuiyiRuntimeConfig?: HuiyiRuntimeConfig;
  }
}

const configuredEnvironment = import.meta.env.VITE_APP_ENV?.trim().toLowerCase();
export const appEnvironment = configuredEnvironment || import.meta.env.MODE;
export const isProductionBuild = appEnvironment === "production";

export const runtimeConfig: HuiyiRuntimeConfig =
  typeof window !== "undefined" && window.HuiyiRuntimeConfig
    ? window.HuiyiRuntimeConfig
    : {};

export const environmentLabel = isProductionBuild
  ? runtimeConfig.environmentName?.trim() || import.meta.env.VITE_APP_ENV_LABEL?.trim() || "PROD"
  : "DEMO / LOCAL";

export const applicationVersion =
  runtimeConfig.version?.trim() || import.meta.env.VITE_APP_VERSION?.trim() || "0.1.0";
