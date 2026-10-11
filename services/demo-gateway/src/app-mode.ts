export type HuiyiAppMode = "development" | "clinical-evaluation" | "production";

export function readAppMode(env: NodeJS.ProcessEnv = process.env): HuiyiAppMode {
  const configured = env.HUIYI_APP_ENV?.trim().toLowerCase();
  if (configured === "clinical-evaluation") {
    if (env.NODE_ENV === "production" && env.HUIYI_ENABLE_SYNTHETIC_EVALUATION_IN_PRODUCTION !== "1") {
      throw new Error("Synthetic clinical-evaluation mode in a production Node runtime requires HUIYI_ENABLE_SYNTHETIC_EVALUATION_IN_PRODUCTION=1");
    }
    return "clinical-evaluation";
  }
  if (configured === "production" || env.NODE_ENV === "production") return "production";
  if (!configured || ["development", "local", "demo"].includes(configured)) return "development";
  throw new TypeError("HUIYI_APP_ENV must be development, local, demo, clinical-evaluation, or production");
}

export const isProductionMode = (env: NodeJS.ProcessEnv = process.env): boolean => readAppMode(env) === "production";
