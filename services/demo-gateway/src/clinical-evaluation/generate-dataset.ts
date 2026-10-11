import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateSyntheticPatients, SYNTHETIC_DATASET_SCHEMA_VERSION } from "./dataset.js";

export interface CliOptions {
  readonly patientCount: number;
  readonly turnCount: number;
  readonly encounterCount: number;
  readonly seed: string;
  readonly output: string;
}

function parseArguments(args: readonly string[]): CliOptions {
  const defaults: CliOptions = {
    patientCount: 300,
    turnCount: 8,
    encounterCount: 3,
    seed: "huiyi-clinical-evaluation-v1",
    output: resolve(dirname(fileURLToPath(import.meta.url)), "../../data/clinical-evaluation/dataset.json"),
  };
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: clinical-evaluation:dataset [--count 300] [--turns 8] [--encounters 3] [--seed TEXT] [--out PATH]\n");
      process.exit(0);
    }
    if (!argument.startsWith("--")) throw new TypeError(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (!["count", "turns", "encounters", "seed", "out"].includes(key)) throw new TypeError(`Unknown option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${argument}`);
    if (values.has(key)) throw new TypeError(`Duplicate option: ${argument}`);
    values.set(key, value);
    index += 1;
  }
  const integer = (key: string, fallback: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new TypeError(`--${key} must be a positive integer`);
    const result = Number(raw);
    if (!Number.isSafeInteger(result)) throw new TypeError(`--${key} must be a safe integer`);
    return result;
  };
  const seed = values.get("seed") ?? defaults.seed;
  if (!seed.trim() || seed.length > 200) throw new TypeError("--seed must contain 1 to 200 characters");
  const outputArgument = values.get("out");
  return {
    patientCount: integer("count", defaults.patientCount),
    turnCount: integer("turns", defaults.turnCount),
    encounterCount: integer("encounters", defaults.encounterCount),
    seed,
    output: outputArgument ? (isAbsolute(outputArgument) ? outputArgument : resolve(process.cwd(), outputArgument)) : defaults.output,
  };
}

export async function writeSyntheticDataset(options: CliOptions): Promise<void> {
  const patients = generateSyntheticPatients(options);
  const output = {
    schemaVersion: SYNTHETIC_DATASET_SCHEMA_VERSION,
    generation: {
      patientCount: options.patientCount,
      turnCount: options.turnCount,
      encounterCount: options.encounterCount,
      seed: options.seed,
      generator: "Huiyi-MedHarness deterministic synthetic dataset generator",
    },
    patients,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`Generated ${patients.length} synthetic patients (${options.encounterCount} encounters × ${options.turnCount} turns) at ${options.output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await writeSyntheticDataset(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Dataset generation failed"}\n`);
    process.exitCode = 1;
  }
}
