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
  "HUIYI_DEMO_API_BASE",
  "HUIYI_DEMO_MODEL_BACKEND",
  "HUIYI_DEMO_CODEX_MODEL",
  "HUIYI_CODEX_BRIDGE_API_KEY",
  "DEEPSEEK_API_KEY",
  "HUIYI_LOCAL_QWEN_API_KEY",
];
const clinicalEvaluationBuild = process.argv.includes("--clinical-evaluation");
if (!clinicalEvaluationBuild) forbiddenCopy.push("模拟患者", "模拟数据");
const requiredProductionCopy = clinicalEvaluationBuild ? [
  "临床评测环境",
  "模拟患者",
  "尚未选择患者",
  "请先加载患者上下文",
  "描述本次复诊问题…",
  "请遵循机构隐私政策；输入可识别患者信息前，请确认已获得授权。",
  "当前病例",
  "仅显示脱敏执行元数据",
  "本系统输出不构成诊断或治疗建议，需由医疗专业人员结合完整病史判断。",
  "本系统仅用于辅助临床工作流，最终决策由执业医师负责。",
] : [
  "PROD",
  "尚未选择患者",
  "请先加载患者上下文",
  "描述本次复诊问题…",
  "请遵循机构隐私政策；输入可识别患者信息前，请确认已获得授权。",
  "当前病例",
  "仅显示脱敏执行元数据",
  "本系统输出不构成诊断或治疗建议，需由医疗专业人员结合完整病史判断。",
  "本系统仅用于辅助临床工作流，最终决策由执业医师负责。",
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
const missingProductionCopy = [];
let combinedContent = "";
for (const file of files) {
  const content = await readFile(file, "utf8");
  combinedContent += content;
  for (const phrase of forbiddenCopy) {
    if (content.includes(phrase)) violations.push(`${file}: ${phrase}`);
  }
}
for (const phrase of requiredProductionCopy) {
  if (!combinedContent.includes(phrase)) missingProductionCopy.push(phrase);
}

if (violations.length || missingProductionCopy.length) {
  console.error("Production build contains demo-only copy or seed identifiers:");
  for (const violation of violations) console.error(`- ${violation}`);
  if (missingProductionCopy.length) {
    console.error("Production build is missing required production copy:");
    for (const phrase of missingProductionCopy) console.error(`- ${phrase}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Production copy check passed across ${files.length} built files.`);
}
