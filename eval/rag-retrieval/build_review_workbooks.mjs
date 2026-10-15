#!/usr/bin/env node

/**
 * Merge the frozen A-D pool with a completed iterative E run, then create
 * randomized, method-blinded review workbooks using the Codex artifact tool.
 * The corpus remains read-only; no labels or qrels are generated here.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseDataRoot = path.join(repoRoot, "services/health-engine/data/local-rag-hc-rag-002");
const v1Dir = path.join(baseDataRoot, "sparse-eval/h2-pilot-v1");
const outDir = path.join(baseDataRoot, "sparse-eval/h2-pilot-v2");
const reviewersDir = path.join(outDir, "reviewers");
const manifestPath = path.join(baseDataRoot, "qwen3-corpus-manifest.json");
const runEPath = path.join(v1Dir, "run-iterative-20261015.json");
const python = process.env.H2_PYTHON || path.join(repoRoot, "services/health-engine/.venv/Scripts/python.exe");
const runtimeNodeModules = process.env.CODEX_NODE_MODULES
  || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
const runtimeRequire = createRequire(path.join(runtimeNodeModules, "__huiyi_h2_artifact_loader__.cjs"));
const { SpreadsheetFile, Workbook } = await import(pathToFileURL(runtimeRequire.resolve("@oai/artifact-tool")).href);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
const nearestRank = (values, percentile) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
};

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function enrichIterativeCandidates(runPath) {
  const pyProgram = [
    "import json, sys",
    "from collections import defaultdict",
    "from pathlib import Path",
    "repo = Path(sys.argv[1])",
    "run = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))",
    "manifest_path = repo / 'services/health-engine/data/local-rag-hc-rag-002/qwen3-corpus-manifest.json'",
    "manifest = json.loads(manifest_path.read_text(encoding='utf-8'))",
    "needed = defaultdict(lambda: defaultdict(set))",
    "for question in run['queries']:",
    "    for item in question.get('results', []):",
    "        source, doc, chunk = item['documentId'].split(':', 2)",
    "        needed[source][doc].add(int(chunk))",
    "files = {source['name']: source['chunkFiles'] for source in manifest['sources']}",
    "result = {}",
    "missing = []",
    "for source, documents in needed.items():",
    "    for doc, chunk_ids in documents.items():",
    "        exact = [entry['path'] for entry in files[source] if Path(entry['path']).stem == doc]",
    "        matches = exact or [entry['path'] for entry in files[source] if doc in Path(entry['path']).stem]",
    "        if not matches:",
    "            missing.append(source + ':' + doc)",
    "            continue",
    "        found = set()",
    "        for relative_path in matches:",
    "            file_path = repo / 'services/health-engine/data/local-rag-hc-rag-002/corpus' / relative_path",
    "            with file_path.open(encoding='utf-8') as stream:",
    "                for line_index, line in enumerate(stream):",
    "                    row = json.loads(line)",
    "                    chunk_id = line_index",
    "                    if chunk_id not in chunk_ids:",
    "                        continue",
    "                    key = source + ':' + doc + ':' + str(chunk_id)",
    "                    content = str(row.get('content', row.get('contents', '')))",
    "                    result[key] = {",
    "                        'documentId': key, 'source': source,",
    "                        'title': str(row.get('title', '')),",
    "                        'snippet': content[:2500],",
    "                        'snippetTruncated': len(content) > 2500,",
    "                        'sourceUri': row.get('sourceUri') or row.get('source_uri') or ''",
    "                    }",
    "                    found.add(chunk_id)",
    "            if found == chunk_ids:",
    "                break",
    "        if found != chunk_ids:",
    "            missing.append(source + ':' + doc + ':chunks=' + ','.join(map(str, sorted(chunk_ids - found))))",
    "if missing:",
    "    raise SystemExit('could not resolve all iterative candidate chunks: ' + '; '.join(missing[:10]))",
    "print(json.dumps(result, ensure_ascii=False))",
  ].join("\n");
  const result = spawnSync(python, ["-c", pyProgram, repoRoot, runPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (result.status !== 0) {
    throw new Error("candidate snippet lookup failed: " + (result.stderr || result.stdout || "unknown error"));
  }
  return JSON.parse(result.stdout);
}

function makeWorkbook(packetQuestions, reviewerNumber) {
  const workbook = Workbook.create();
  const instructions = workbook.worksheets.add("说明");
  const questions = workbook.worksheets.add("问题判断");
  const candidates = workbook.worksheets.add("候选标注");
  const reviewerQuestionOrder = [...packetQuestions].sort((left, right) => {
    const leftKey = sha256("h2-pilot-question-order-v2|" + reviewerNumber + "|" + left.questionId);
    const rightKey = sha256("h2-pilot-question-order-v2|" + reviewerNumber + "|" + right.questionId);
    return leftKey.localeCompare(rightKey);
  });
  const navy = "#17365D";
  const blue = "#D9EAF7";

  instructions.showGridLines = false;
  instructions.getRange("A1:B12").values = [
    ["H2 医学检索独立盲审", "Pilot · DEV · reviewer " + reviewerNumber],
    ["标注目的", "评估问题可回答性，以及候选医学片段与问题的相关性和适用性。"],
    ["盲审要求", "仅根据问题、标题和片段标注；不要猜测候选来自哪个检索方法，也不要相互讨论。"],
    ["相关性 0", "不相关，不能帮助回答该问题。"],
    ["相关性 1", "仅有词面或宽泛背景关联，不能支持问题核心。"],
    ["相关性 2", "部分支持，或是回答问题所需的一个证据环节。"],
    ["相关性 3", "直接支持问题核心事实或主张。"],
    ["适用性", "applicable=适用；partly_applicable=部分适用；not_applicable=不适用；conflicting=与其他来源存在实质冲突；not_assessed=无法判断。"],
    ["问题可回答性", "answerable=冻结语料中存在足以回答的证据；no_answer=冻结语料中没有足够证据。把不确定点写入备注并留空，协调后再判定。"],
    ["多跳问题", "分别判断每个候选是否提供必要证据环节；不要要求单个片段独自覆盖整个多跳答案。"],
    ["无答案问题", "仍需评估每个候选；若没有候选达到 2 分以上，该问题才可判 no_answer。"],
    ["数据范围", "只使用固定的五源语料候选；不输入患者身份、Encounter 或 Memory 信息。"],
  ];
  instructions.getRange("A1:A12").format = {
    fill: navy,
    font: { name: "Aptos", size: 11, bold: true, color: "#FFFFFF" },
  };
  instructions.getRange("B1:B12").format = {
    font: { name: "Aptos", size: 11, color: "#1F2937" },
    wrapText: true,
    verticalAlignment: "center",
  };
  instructions.getRange("A1:A12").format.columnWidth = 22;
  instructions.getRange("B1:B12").format.columnWidth = 110;
  instructions.getRange("A1:B12").format.rowHeight = 34;
  instructions.getRange("A1:B1").format.rowHeight = 30;
  instructions.freezePanes.freezeRows(1);

  questions.showGridLines = false;
  questions.getRange("A1:E1").values = [[
    "Blind question ID", "Query", "Language", "Answerability", "Reviewer note",
  ]];
  questions.getRange("A1:E1").format = {
    fill: navy,
    font: { name: "Aptos", size: 10, bold: true, color: "#FFFFFF" },
    wrapText: true,
  };
  questions.getRange("A2:E" + (packetQuestions.length + 1)).values = reviewerQuestionOrder.map((question) => [
    question.questionId,
    question.query,
    question.language,
    null,
    null,
  ]);
  questions.getRange("A2:E" + (packetQuestions.length + 1)).format = {
    font: { name: "Aptos", size: 10, color: "#1F2937" },
    wrapText: true,
    verticalAlignment: "top",
  };
  questions.getRange("A:A").format.columnWidth = 18;
  questions.getRange("B:B").format.columnWidth = 74;
  questions.getRange("C:C").format.columnWidth = 14;
  questions.getRange("D:D").format.columnWidth = 22;
  questions.getRange("E:E").format.columnWidth = 54;
  questions.getRange("D2:D" + (packetQuestions.length + 1)).dataValidation = {
    rule: { type: "list", values: ["answerable", "no_answer"] },
  };
  questions.getRange("A1:E" + (packetQuestions.length + 1)).format.borders = {
    preset: "inside",
    style: "thin",
    color: "#D9E2F3",
  };
  questions.freezePanes.freezeRows(1);

  const candidateRows = [];
  for (const question of reviewerQuestionOrder) {
    for (const candidate of question.candidatePool) {
      candidateRows.push({
        questionId: question.questionId,
        query: question.query,
        language: question.language,
        candidate,
      });
    }
  }
  candidateRows.sort((left, right) => {
    const questionOrder = left.questionId.localeCompare(right.questionId);
    if (questionOrder !== 0) return questionOrder;
    const leftKey = sha256("h2-pilot-pool-v2|" + reviewerNumber + "|" + left.questionId + "|" + left.candidate.candidateId);
    const rightKey = sha256("h2-pilot-pool-v2|" + reviewerNumber + "|" + right.questionId + "|" + right.candidate.candidateId);
    return leftKey.localeCompare(rightKey);
  });
  const header = [[
    "Blind question ID", "Query", "Language", "Candidate ID",
    "Corpus collection", "Title", "Evidence excerpt", "Relevance (0-3)",
    "Applicability", "Reviewer rationale",
  ]];
  candidates.showGridLines = false;
  candidates.getRange("A1:J1").values = header;
  candidates.getRange("A1:J1").format = {
    fill: navy,
    font: { name: "Aptos", size: 10, bold: true, color: "#FFFFFF" },
    wrapText: true,
    verticalAlignment: "center",
  };
  const candidateValues = candidateRows.map(({ questionId, query, language, candidate }) => [
    questionId,
    query,
    language,
    candidate.candidateId,
    candidate.source,
    candidate.title,
    candidate.snippet,
    null,
    null,
    null,
  ]);
  const lastRow = candidateValues.length + 1;
  candidates.getRange("A2:J" + lastRow).values = candidateValues;
  candidates.getRange("A2:J" + lastRow).format = {
    font: { name: "Aptos", size: 9, color: "#1F2937" },
    wrapText: true,
    verticalAlignment: "top",
  };
  candidates.getRange("A:A").format.columnWidth = 18;
  candidates.getRange("B:B").format.columnWidth = 62;
  candidates.getRange("C:C").format.columnWidth = 12;
  candidates.getRange("D:D").format.columnWidth = 18;
  candidates.getRange("E:E").format.columnWidth = 18;
  candidates.getRange("F:F").format.columnWidth = 40;
  candidates.getRange("G:G").format.columnWidth = 78;
  candidates.getRange("H:H").format.columnWidth = 18;
  candidates.getRange("I:I").format.columnWidth = 22;
  candidates.getRange("J:J").format.columnWidth = 48;
  candidates.getRange("A1:J" + lastRow).format.borders = {
    preset: "inside",
    style: "thin",
    color: "#D9E2F3",
  };
  candidates.getRange("H2:H" + lastRow).dataValidation = {
    rule: { type: "list", values: ["0", "1", "2", "3"] },
  };
  candidates.getRange("I2:I" + lastRow).dataValidation = {
    rule: {
      type: "list",
      values: ["applicable", "partly_applicable", "not_applicable", "conflicting", "not_assessed"],
    },
  };
  candidates.getRange("A2:J" + lastRow).format.rowHeight = 48;
  candidates.freezePanes.freezeRows(1);
  const table = candidates.tables.add("A1:J" + lastRow, true, "CandidateJudgments" + reviewerNumber);
  table.style = "TableStyleMedium2";

  workbook.recalculate();
  return { workbook, candidateCount: candidateRows.length };
}

async function main() {
  await fs.mkdir(reviewersDir, { recursive: true });
  const outputFiles = [
    "candidate-pool.private.json",
    "annotation-packet.blinded.json",
    "pilot-queries.pending.json",
    "pool-integrity.json",
    "reviewers/h2-pilot-v2-reviewer-1.xlsx",
    "reviewers/h2-pilot-v2-reviewer-2.xlsx",
  ];
  for (const outputFile of outputFiles) {
    try {
      await fs.access(path.join(outDir, outputFile));
      throw new Error("output exists; refusing to overwrite " + outputFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const [candidatePoolV1, packetV1, datasetV1, runE] = await Promise.all([
    readJson(path.join(v1Dir, "candidate-pool.private.json")),
    readJson(path.join(v1Dir, "annotation-packet.blinded.json")),
    readJson(path.join(v1Dir, "pilot-queries.with-pool.pending.json")),
    readJson(runEPath),
  ]);
  if (runE.method !== "dense-iterative-gpt6-luna" || runE.queries.length !== 12) {
    throw new Error("unexpected or incomplete iterative E run");
  }
  if (runE.queries.some((question) => question.status !== "ok" || question.results.length !== 20)) {
    throw new Error("E must have 12 successful queries with 20 returned candidates each");
  }
  const iterativeCandidates = enrichIterativeCandidates(runEPath);
  const oldPacketById = new Map(packetV1.questions.map((question) => [question.questionId, question]));
  const eByQuestion = new Map(runE.queries.map((question) => [question.questionId, question]));
  const mergedQuestions = [];

  for (const originalQuestion of datasetV1.questions) {
    const questionId = originalQuestion.questionId;
    const originalPacketQuestion = oldPacketById.get(questionId);
    const iterativeQuestion = eByQuestion.get(questionId);
    if (!originalPacketQuestion || !iterativeQuestion) throw new Error("question set mismatch at " + questionId);
    const metadataByDocument = new Map(
      originalPacketQuestion.candidatePool.map((candidate) => [candidate.documentId, candidate]),
    );
    const methodsByDocument = new Map();
    for (const method of ["dense", "bm25", "rrf", "rrf-reranker", "dense-iterative-gpt6-luna"]) {
      const runFile = method === "dense-iterative-gpt6-luna"
        ? runEPath
        : path.join(v1Dir, "run-" + method + ".json");
      const methodRun = method === "dense-iterative-gpt6-luna" ? runE : await readJson(runFile);
      const methodQuestion = methodRun.queries.find((item) => item.questionId === questionId);
      if (!methodQuestion || methodQuestion.status !== "ok") throw new Error("missing successful run row " + method + "/" + questionId);
      for (const result of methodQuestion.results) {
        const documentId = result.documentId;
        const methodList = methodsByDocument.get(documentId) || new Set();
        methodList.add(method);
        methodsByDocument.set(documentId, methodList);
        if (!metadataByDocument.has(documentId)) {
          const enriched = iterativeCandidates[documentId];
          if (!enriched) throw new Error("missing blinded content for new candidate " + documentId);
          metadataByDocument.set(documentId, enriched);
        }
      }
    }

    const candidatePool = [...metadataByDocument.entries()]
      .map(([documentId, metadata]) => {
        const [source, sourceDocumentId, chunkId] = documentId.split(":", 3);
        const candidateId = "C-" + sha256("h2-pilot-candidate-v2|" + datasetV1.datasetId + "|" + questionId + "|" + documentId).slice(0, 12);
        return {
          documentId,
          source: metadata.source || source,
          sourceDocumentId,
          chunkId,
          candidateMethods: [...(methodsByDocument.get(documentId) || new Set())].sort(),
          candidateId,
          title: metadata.title || "",
          snippet: metadata.snippet || "",
          snippetTruncated: Boolean(metadata.snippetTruncated),
          sourceUri: metadata.sourceUri || "",
        };
      })
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));

    const blindQuestionId = "Q-" + sha256("h2-pilot-question-v2|" + datasetV1.datasetId + "|" + questionId).slice(0, 10);
    const packetQuestion = {
      questionId: blindQuestionId,
      query: originalQuestion.query,
      language: originalQuestion.language,
      candidatePool: candidatePool.map((candidate) => ({
        candidateId: candidate.candidateId,
        source: candidate.source,
        title: candidate.title,
        snippet: candidate.snippet,
        snippetTruncated: candidate.snippetTruncated,
        sourceUri: candidate.sourceUri,
      })),
      qrels: [],
      annotations: [],
      reviewStatus: "pending",
    };
    const datasetQuestion = {
      ...originalQuestion,
      answerability: "pending",
      candidatePool: candidatePool.map(({ documentId, source, sourceDocumentId, chunkId, candidateMethods }) => ({
        documentId,
        source,
        sourceDocumentId,
        chunkId,
        candidateMethods,
      })),
      qrels: [],
      annotations: [],
      reviewStatus: "pending",
    };
    mergedQuestions.push({ packetQuestion, datasetQuestion, privatePoolQuestion: {
      questionId,
      blindQuestionId,
      candidatePool: candidatePool.map(({ documentId, source, candidateMethods, candidateId }) => ({
        documentId,
        source,
        candidateMethods,
        candidateId,
      })),
    } });
  }

  const packet = {
    schemaVersion: "huiyi-rag-annotation-packet/v1",
    poolRevision: "h2-pilot-pool-v2-inclusive-e",
    datasetId: datasetV1.datasetId,
    corpusVersion: datasetV1.corpusVersion,
    manifestSha256: runE.manifestSha256,
    instruction: "使用匿名题号；任务类别、来源方法、排序和分数均已隐藏。只按固定标注协议评问题与候选片段。",
    reviewStatus: "pending_two_independent_reviewers",
    questions: mergedQuestions.map((item) => item.packetQuestion).sort((left, right) => left.questionId.localeCompare(right.questionId)),
  };
  const privatePool = {
    schemaVersion: "huiyi-rag-candidate-pool/v1",
    poolRevision: "h2-pilot-pool-v2-inclusive-e",
    datasetSha256: runE.datasetSha256,
    manifestSha256: runE.manifestSha256,
    corpusVersion: runE.corpusVersion,
    topKPerChannel: 20,
    candidateCount: mergedQuestions.reduce((total, item) => total + item.privatePoolQuestion.candidatePool.length, 0),
    methodRuns: {
      dense: "../h2-pilot-v1/run-dense.json",
      bm25: "../h2-pilot-v1/run-bm25.json",
      rrf: "../h2-pilot-v1/run-rrf.json",
      "rrf-reranker": "../h2-pilot-v1/run-rrf-reranker.json",
      "dense-iterative-gpt6-luna": "../h2-pilot-v1/run-iterative-20261015.json",
    },
    questions: mergedQuestions.map((item) => item.privatePoolQuestion),
  };
  const reviewDataset = {
    schemaVersion: "huiyi-rag-retrieval-dataset/v1",
    datasetId: datasetV1.datasetId,
    split: datasetV1.split || "dev",
    corpusVersion: datasetV1.corpusVersion,
    annotationProtocolVersion: "h2-pilot-annotation-v1",
    questions: mergedQuestions.map((item) => item.datasetQuestion),
  };
  const packetPath = path.join(outDir, "annotation-packet.blinded.json");
  const privatePoolPath = path.join(outDir, "candidate-pool.private.json");
  const reviewDatasetPath = path.join(outDir, "pilot-queries.pending.json");
  await fs.writeFile(packetPath, jsonBytes(packet));
  await fs.writeFile(privatePoolPath, jsonBytes(privatePool));
  await fs.writeFile(reviewDatasetPath, jsonBytes(reviewDataset));

  const reviewerOutputs = [];
  for (const reviewerNumber of [1, 2]) {
    const { workbook, candidateCount } = makeWorkbook(packet.questions, reviewerNumber);
    const outputPath = path.join(reviewersDir, "h2-pilot-v2-reviewer-" + reviewerNumber + ".xlsx");
    const file = await SpreadsheetFile.exportXlsx(workbook);
    await file.save(outputPath);
    await fs.rm(outputPath + ".inspect.ndjson", { force: true });
    reviewerOutputs.push({ reviewerNumber, outputPath, candidateCount });
  }

  const queryTotal = reviewDataset.questions.length;
  const poolTotal = privatePool.candidateCount;
  const allReviewIds = reviewDataset.questions.map((question) => question.questionId + "|" + question.candidatePool.map((item) => item.documentId).join("|")).join("\n");
  const runPaths = {
    dense: path.join(v1Dir, "run-dense.json"),
    bm25: path.join(v1Dir, "run-bm25.json"),
    rrf: path.join(v1Dir, "run-rrf.json"),
    "rrf-reranker": path.join(v1Dir, "run-rrf-reranker.json"),
    iterative: runEPath,
  };
  const runs = {};
  for (const [method, runPath] of Object.entries(runPaths)) runs[method] = await readJson(runPath);
  const summarizeRun = (run) => {
    const rows = run.queries;
    const ok = rows.filter((row) => row.status === "ok");
    const latencies = ok.map((row) => Number(row.latencyMs));
    const inputTokens = ok.reduce((sum, row) => sum + Number(row.plannerInputTokens || 0), 0);
    const outputTokens = ok.reduce((sum, row) => sum + Number(row.plannerOutputTokens || 0), 0);
    return {
      success: ok.length,
      total: rows.length,
      candidateBudget: run.candidateBudget,
      resultCountPerQuery: [...new Set(ok.map((row) => row.results.length))].sort((a, b) => a - b),
      latencyMs: {
        p50NearestRank: nearestRank(latencies, 0.5),
        p95NearestRank: nearestRank(latencies, 0.95),
      },
      plannerCalls: ok.reduce((sum, row) => sum + Number(row.plannerCalls || 0), 0),
      retrievalCalls: ok.reduce((sum, row) => sum + Number(row.retrievalCalls || 0), 0),
      generatedQueries: ok.reduce((sum, row) => sum + Number(row.generatedQueries || 0), 0),
      plannerInputTokens: inputTokens,
      plannerOutputTokens: outputTokens,
      currencyCost: null,
      currencyCostNote: run.method === "dense-iterative-gpt6-luna"
        ? "local bridge reported token usage; monetary billing is not exposed"
        : "no planner call was made",
    };
  };
  const eSummary = summarizeRun(runs.iterative);
  const runHash = {};
  for (const [method, runPath] of Object.entries(runPaths)) runHash[method] = sha256(await fs.readFile(runPath));
  const v1DatasetHash = sha256(await fs.readFile(path.join(v1Dir, "pilot-queries.with-pool.pending.json")));
  const manifestHash = sha256(await fs.readFile(manifestPath));
  const sparseIndexPath = path.join(baseDataRoot, "sparse-eval/qwen3-bm25-v1.sqlite3");
  const oldRerankerPath = path.join(v1Dir, "run-rrf-reranker.json");
  const workbookHashes = {};
  for (const output of reviewerOutputs) {
    workbookHashes[path.basename(output.outputPath)] = sha256(await fs.readFile(output.outputPath));
  }
  const packetHash = sha256(await fs.readFile(packetPath));
  const privatePoolHash = sha256(await fs.readFile(privatePoolPath));
  const reviewDatasetHash = sha256(await fs.readFile(reviewDatasetPath));
  const poolIntegrity = {
    schemaVersion: "huiyi-h2-pilot-integrity/v2",
    status: "candidate_runs_complete_quality_scoring_waits_for_independent_double_review",
    poolRevision: "h2-pilot-pool-v2-inclusive-e",
    datasetId: reviewDataset.datasetId,
    split: "DEV",
    corpusVersion: reviewDataset.corpusVersion,
    encoder: {
      name: "Qwen3-Embedding-0.6B",
      queryEncoderModel: "Qwen/Qwen3-Embedding-0.6B",
      queryEncoderRevision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
      articleEncoderModel: "Qwen/Qwen3-Embedding-0.6B",
      articleEncoderRevision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    },
    manifestSha256: manifestHash,
    sourceRevision: {
      gitCommitSha: "28ba197ed3499272efdfaeda20645be7300ec796",
      ragRuntimeFilesCleanAgainstCommit: true,
      localPlannerBridgeCleanAgainstCommit: true,
      unrelatedWorktreeChangesWerePresent: true,
      methodRunnerSha256: Object.fromEntries(
        Object.entries(runs).map(([name, run]) => [name, run.runnerSha256 || null]),
      ),
      reviewPacketBuilderSha256: sha256(await fs.readFile(path.join(repoRoot, "eval/rag-retrieval/build_review_workbooks.mjs"))),
    },
    frozenQueryDatasetSha256: runE.datasetSha256,
    previousCandidatePoolDatasetSha256: v1DatasetHash,
    expandedReviewDatasetSha256: reviewDatasetHash,
    bm25IndexSha256: "181a26d6a37de335e27998cca5a5ad64d2d6b76044fa031f606973de11a93a61",
    bm25IndexBytes: 544268288,
    bm25Tokenizer: "latin-word-casefold+cjk-character-bigram-v1",
    bm25TitleWeight: 3,
    bm25BodyWeight: 1,
    rrfConstant: 60,
    reranker: {
      name: "bge-reranker-v2-m3",
      modelSha256: "d9e3e081faff1eefb84019509b2f5558fd74c1a05a2c7db22f74174fcedb5286",
      candidatePool: "RRF Top-20; no additions",
    },
    queryCount: queryTotal,
    candidatePoolUniqueCount: poolTotal,
    candidatePoolPreviousCount: candidatePoolV1.candidateCount,
    candidatePoolAddedForE: poolTotal - candidatePoolV1.candidateCount,
    blinding: {
      methodAndScoreFieldsInReviewPacket: false,
      originalQuestionIdsAndTaskCategoriesHiddenFromReviewers: true,
      patientContextIncluded: false,
      reviewersRequired: 2,
      eachReviewerReceivesSameCandidateSet: true,
      candidateOrderIndependentlyRandomizedByStableHash: true,
    },
    qualityMetrics: {
      status: "not_scored",
      reason: "expanded A-E pooled candidates await two independent reviews and adjudication",
      recall: null,
      mrr: null,
      ndcg: null,
    },
    ablation: {
      dense: summarizeRun(runs.dense),
      bm25: summarizeRun(runs.bm25),
      rrf: summarizeRun(runs.rrf),
      "rrf-reranker": summarizeRun(runs["rrf-reranker"]),
      "dense-iterative-gpt6-luna": eSummary,
    },
    iterativePlannerArm: {
      status: "complete_pending_qrels",
      method: runs.iterative.method,
      planner: runs.iterative.model.planner,
      plannerRoute: runs.iterative.model.plannerRoute,
      promptVersion: "huiyi-rag-query-plan-v1",
      maxRounds: runs.iterative.retrieverConfig.maxRounds,
      queriesPerRound: runs.iterative.retrieverConfig.maxQueriesPerRound,
      retrievalCalls: eSummary.retrievalCalls,
      maximumRawCandidateSlotsPerQuery: runs.iterative.retrieverConfig.maxRounds
        * runs.iterative.retrieverConfig.maxQueriesPerRound
        * runs.iterative.retrieverConfig.topKPerPlannedQuery,
      finalCandidateBudgetPerQuery: runs.iterative.retrieverConfig.finalCandidateBudget,
      plannerMaxTokens: runs.iterative.retrieverConfig.plannerMaxTokens,
      successfulQueries: eSummary.success + "/" + eSummary.total,
      plannerCalls: eSummary.plannerCalls,
      generatedQueries: eSummary.generatedQueries,
      plannerInputTokensReportedByLocalBridge: eSummary.plannerInputTokens,
      plannerOutputTokensReportedByLocalBridge: eSummary.plannerOutputTokens,
      monetaryCost: null,
      monetaryCostReason: "local Codex app-server bridge reports tokens but does not expose billing",
      endToEndLatencyMs: eSummary.latencyMs,
      plannerLatencyMs: {
        p50NearestRank: nearestRank(runs.iterative.queries.map((row) => row.plannerLatencyMs), 0.5),
        p95NearestRank: nearestRank(runs.iterative.queries.map((row) => row.plannerLatencyMs), 0.95),
        total: runs.iterative.queries.reduce((sum, row) => sum + row.plannerLatencyMs, 0),
      },
      retrievalLatencyMs: {
        p50NearestRank: nearestRank(runs.iterative.queries.map((row) => row.retrievalLatencyMs), 0.5),
        p95NearestRank: nearestRank(runs.iterative.queries.map((row) => row.retrievalLatencyMs), 0.95),
        total: runs.iterative.queries.reduce((sum, row) => sum + row.retrievalLatencyMs, 0),
      },
      qualityMetrics: null,
    },
    sourceMetadataAudit: "docs/rag/H2-PHASE-D-METADATA-AUDIT.md",
    trace: "../h2-pilot-v1/trace-healthengine-evidence-set.json",
    files: {
      candidatePool: "candidate-pool.private.json",
      annotationPacket: "annotation-packet.blinded.json",
      pendingReviewDataset: "pilot-queries.pending.json",
      runs: Object.fromEntries(Object.entries(runPaths).map(([name, runPath]) => [name, path.relative(outDir, runPath).replaceAll("\\", "/")])),
    },
    sha256: {
      manifest: manifestHash,
      frozenQueryDataset: runE.datasetSha256,
      candidatePool: privatePoolHash,
      annotationPacket: packetHash,
      expandedReviewDataset: reviewDatasetHash,
      bm25Index: "181a26d6a37de335e27998cca5a5ad64d2d6b76044fa031f606973de11a93a61",
      runs: runHash,
      reviewerWorkbooks: workbookHashes,
      candidateSetIds: sha256(allReviewIds),
    },
  };
  await fs.writeFile(path.join(outDir, "pool-integrity.json"), jsonBytes(poolIntegrity));

  console.log(JSON.stringify({
    status: "complete_pending_independent_qrels",
    queryCount: queryTotal,
    previousCandidateCount: candidatePoolV1.candidateCount,
    expandedCandidateCount: poolTotal,
    candidatesAddedForE: poolTotal - candidatePoolV1.candidateCount,
    eSuccess: eSummary.success + "/" + eSummary.total,
    ePlannerCalls: eSummary.plannerCalls,
    eInputTokens: eSummary.plannerInputTokens,
    eOutputTokens: eSummary.plannerOutputTokens,
    eLatencyMs: eSummary.latencyMs,
    reviewers: reviewerOutputs.map((item) => ({
      reviewerNumber: item.reviewerNumber,
      outputPath: item.outputPath,
      candidateCount: item.candidateCount,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
