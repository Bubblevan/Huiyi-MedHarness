import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const buildRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const forbiddenCopy = [
  "DEMO / LOCAL",
  "Synthetic demo patient",
  "合成演示",
  "合成案例",
  "SYNTHETIC CASE",
  "请勿输入真实患者信息",
  "所有姓名、病程与内容均为合成演示数据",
  "演示案例",
  "演示输出不构成诊断或治疗建议",
  "DSH · DeepSeek API",
  "Demo evidence fixture",
  "Local · fixture",
  "CPU-only fixture",
  "PRESENTATION CASES",
  "DEMO SCENARIOS",
  "Clinical Demo Workstation",
  "simulated multi-specialist flow",
  "simulated execution",
  "fixture 错误状态测试",
  "故障演示",
  "故障与恢复",
  "合成患者",
  "合成资料",
  "合成数据",
  "高血压复诊",
  "复杂病例",
  "张某",
  "李某",
  "patient-htn",
  "patient-complex",
  "示例降压药",
  "synthetic-demo-fixture",
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

let files;
try {
  files = await walk(buildRoot);
} catch (error) {
  console.error("Production build output is missing. Run vite build before checking it.");
  throw error;
}

const violations = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const phrase of forbiddenCopy) {
    if (content.includes(phrase)) violations.push(`${file}: ${phrase}`);
  }
}

if (violations.length) {
  console.error("Production build contains demo-only copy or seed identifiers:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Production copy check passed across ${files.length} built files.`);
}
