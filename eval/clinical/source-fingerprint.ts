import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const EVALUATION_PATHS = [
  "src",
  "eval/clinical",
  "services/demo-gateway/src",
  "services/health-engine/src",
  "scripts/eval",
  "scripts/rag",
  "apps/demo-web/src",
  "tests/clinical-eval.test.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.test.json",
  "services/demo-gateway/package.json",
  "services/health-engine/pyproject.toml",
  "apps/demo-web/package.json",
] as const;

const MAX_SOURCE_FILES = 2_000;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_SINGLE_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
const SOURCE_EXTENSION = /\.(?:tsx?|jsx?|mjs|cjs|py|ps1|json|ya?ml|toml)$/i;

export interface EvaluationSourceFingerprint {
  readonly gitRevision: string;
  readonly relevantWorkingTreeDirty: boolean;
  readonly sourceSha256: string;
  readonly sourceFileCount: number;
  readonly sourceBytes: number;
}

/** Hashes only evaluator/runtime source and dependency manifests; model and corpus data are excluded. */
export async function captureEvaluationSourceFingerprint(repoRoot: string): Promise<EvaluationSourceFingerprint> {
  const root = resolve(repoRoot);
  const runGit = (args: string[]): string => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const gitRevision = runGit(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(gitRevision)) throw new Error("git returned an invalid source revision");
  const workingTree = runGit(["status", "--porcelain=v1", "--untracked-files=all", "--", ...EVALUATION_PATHS]);
  const listed = runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...EVALUATION_PATHS]);
  const paths = [...new Set(listed.split("\0").filter(Boolean))]
    .filter((path) => !path.startsWith("/") && !path.split("/").some((part) => part === ".."))
    .filter((path) => SOURCE_EXTENSION.test(path))
    .sort();
  if (paths.length > MAX_SOURCE_FILES) throw new Error(`evaluation source set exceeds ${MAX_SOURCE_FILES} files`);

  const hash = createHash("sha256");
  let sourceBytes = 0;
  let sourceFileCount = 0;
  for (const path of paths) {
    const fullPath = join(root, ...path.split("/"));
    let metadata;
    try {
      metadata = await lstat(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(path, "utf8").update("\0<deleted>\0");
      sourceFileCount += 1;
      continue;
    }
    if (metadata.isSymbolicLink()) throw new Error(`evaluation source path is a symbolic link: ${path}`);
    if (!metadata.isFile()) continue;
    if (metadata.size > MAX_SINGLE_SOURCE_FILE_BYTES) throw new Error(`evaluation source file exceeds ${MAX_SINGLE_SOURCE_FILE_BYTES} bytes: ${path}`);
    const bytes = await readFile(fullPath);
    sourceBytes += bytes.byteLength;
    if (sourceBytes > MAX_SOURCE_BYTES) throw new Error(`evaluation source set exceeds ${MAX_SOURCE_BYTES} bytes`);
    hash.update(path, "utf8").update("\0").update(bytes).update("\0");
    sourceFileCount += 1;
  }

  return {
    gitRevision,
    relevantWorkingTreeDirty: workingTree.trim().length > 0,
    sourceSha256: hash.digest("hex"),
    sourceFileCount,
    sourceBytes,
  };
}

/** Fingerprints the Python runtime loaded by Health Engine, including the pinned AMA source. */
export async function captureHealthEngineSourceFingerprint(repoRoot: string): Promise<string> {
  const root = resolve(repoRoot);
  const sourceRoots = [
    { prefix: "huiyi_health_engine", path: join(root, "services/health-engine/src/huiyi_health_engine") },
    { prefix: "AMA", path: join(root, "third_party/AMA/python/AdaptiveMemory") },
  ] as const;
  const files: Array<{ key: string; path: string }> = [];
  for (const sourceRoot of sourceRoots) {
    const pending = [sourceRoot.path];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Health Engine runtime source contains a symbolic link");
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && path.endsWith(".py")) {
          const prefixPath = relative(sourceRoot.path, path).replaceAll("\\", "/");
          files.push({ key: `${sourceRoot.prefix}/${prefixPath}`, path });
        }
      }
    }
  }

  const hash = createHash("sha256");
  for (const file of files.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)) {
    const metadata = await lstat(file.path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Health Engine runtime source changed during fingerprinting");
    hash.update(file.key, "utf8").update("\0").update(await readFile(file.path)).update("\0");
  }
  return hash.digest("hex");
}
