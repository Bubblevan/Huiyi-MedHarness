# H2 Pilot Quality Bad Cases — 2026-10-15

Status: **exploratory_pilot_cases_not_clinical_review**. These are 15 method–query observations on a 12-question draft DEV pilot, not 15 independent cases or clinical reviews. 11 are counted as retrieval-quality regressions; two no-answer-intended questions lack finalized answerability gold and are risk observations only; two Dense rows are baseline ranking observations, not counted as failures.

All qrel grades below are blind GPT-6-Luna judgments over pooled candidates. Four disputed candidates are excluded. Direct-support references are local candidate/document IDs and source labels; the JSON lists every grade-2 reference and quote-validation metadata. Root causes remain engineering hypotheses unless a code-level mechanism is stated. A separate BM25 all-token-AND diagnostic was run against the same frozen queries and SQLite index; it returned no candidates and is a negative probe, not a repair.

## BC-001 — H2-P-002 · exact_term · bm25

**Question:** 过敏史的来源、发生时间和不确定性通常应记录哪些信息？

**Required direct-support evidence:** 8 resolved grade-2 pooled qrels; judge/source references:
- `C-24ba345ab915` / `statpearls:article-21877:20` · statpearls · Food Allergies -- History and Physical · exact quote verified: `true` · judge basis: Directly addresses exposure source and timing reproducibility.
- `C-41549c99f429` / `textbooks:InternalMed_Harrison:4320` · textbooks · InternalMed_Harrison · exact quote verified: `true` · judge basis: Covers medication exposure timing and causal assessment details.
- `C-c9aab5bd1351` / `statpearls:article-21877:17` · statpearls · Food Allergies -- History and Physical · exact quote verified: `true` · judge basis: Directly specifies food exposure and reaction timing details.
- `C-d2a38d9e008a` / `statpearls:article-20931:19` · statpearls · Egg Allergy -- Evaluation · exact quote verified: `true` · judge basis: Directly covers exposure, reaction, and onset history.
- `C-d2ee2c5a0aeb` / `statpearls:article-38834:9` · statpearls · Wheat Allergy -- History and Physical · exact quote verified: `true` · judge basis: Directly covers allergen exposure and reaction chronology.
- `C-e3be4e4b87eb` / `statpearls:article-161219:48` · statpearls · Adverse Drug Reactions -- Additional Considerations -- Medical History Review · exact quote verified: `true` · judge basis: Directly identifies possible sources of allergy history.
- `C-ea9b63941ab8` / `statpearls:article-30878:14` · statpearls · Contact Urticaria -- History and Physical · exact quote verified: `true` · judge basis: Directly specifies exposure, symptom onset, and resolution timing.
- `C-ee49853c7488` / `statpearls:article-30712:34` · statpearls · Type I Hypersensitivity Reaction -- Evaluation · exact quote verified: `true` · judge basis: Directly covers history source, chronology, and exposure details.

**Dense Top-5:**
- `1` statpearls — Medical History -- Definition/Introduction -- Allergies and Medications (grade 1; `statpearls:article-24867:14`)
- `2` statpearls — Type I Hypersensitivity Reaction -- Evaluation (grade 2; `statpearls:article-30712:34`)
- `3` statpearls — Contact Urticaria -- History and Physical (grade 2; `statpearls:article-30878:14`)
- `4` statpearls — Adverse Drug Reactions -- Additional Considerations -- Timely and Accurate Documentation of Allergies (grade 1; `statpearls:article-161219:49`)
- `5` statpearls — Allergic Conjunctivitis -- History and Physical -- Approach to Evaluation (grade 1; `statpearls:article-19890:94`)
**bm25 Top-5:**
- `1` huiyi — 近一两天，突然发生眼前闪光感，然后也没有不舒服和视力下降，这是怎么回事？ (grade 0; `huiyi:huiyi-doc-1c36454c3f188d36cdb1:0`)
- `2` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:1`)
- `3` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:2`)
- `4` huiyi — 工作时电脑使用频率高，电子产品接触多，老是眼睛疲劳怎么办？ (grade 0; `huiyi:huiyi-doc-60e4200153baaec423ff:0`)
- `5` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:0`)

**Cross-method ranking:** dense: first direct rank=2, Top-5 direct hits=2; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=4, Top-5 direct hits=1; reranker: first direct rank=2, Top-5 direct hits=3; iterative: first direct rank=2, Top-5 direct hits=2.
**Observed stage:** candidate generation and sparse ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; BM25 returns high-frequency Huiyi eye-care pages while all 8 pooled direct-support documents are absent from its top 20. The OR query over overlapping CJK bigrams is a plausible source of broad matches; this is not yet isolated experimentally.
**DEV follow-up:** Compare AND/phrase and IDF-aware CJK tokenization on DEV; preserve exact medical terms and report candidate recall before changing the index.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-002 — H2-P-003 · semantic · bm25

**Question:** 患者难以执行既定健康计划时，复诊沟通应如何识别和记录障碍？

**Required direct-support evidence:** 1 resolved grade-2 pooled qrels; judge/source references:
- `C-906dcae14599` / `statpearls:article-131526:23` · statpearls · Counseling Patients With Obesity -- Clinical Significance -- Assist/Arrange · exact quote verified: `true` · judge basis: Directly describes reassessing barriers during follow-up visits.

**Dense Top-5:**
- `1` pubmed — Rehabilitation of the communicatively impaired stroke patient. (grade 0; `pubmed:pubmed23n0022:5782`)
- `2` statpearls — Counseling Patients With Obesity -- Clinical Significance -- Assist/Arrange (grade 2; `statpearls:article-131526:23`)
- `3` statpearls — Involuntary Commitment -- Nursing, Allied Health, and Interprofessional Team Interventions -- Discharge Planni… (grade 1; `statpearls:article-23748:47`)
- `4` textbooks — InternalMed_Harrison (grade 1; `textbooks:InternalMed_Harrison:667`)
- `5` statpearls — Human Behavior in a Social Environment -- Summary and Interprofessional Team Considerations (unjudged; `statpearls:article-130468:65`)
**bm25 Top-5:**
- `1` huiyi — 白内障手术效果如何？ (grade 0; `huiyi:huiyi-doc-0290333d1ede47e131f7:0`)
- `2` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:2`)
- `3` huiyi — 孩子患了斜视该如何治疗？ (grade 0; `huiyi:huiyi-doc-f4192c1c3d2bf358d6d4:0`)
- `4` huiyi — 如何分辨真性近视与假性近视？ (grade 0; `huiyi:huiyi-doc-8c8d872821e569d9c95b:0`)
- `5` huiyi — 透气、耐用……还可抑制近视发展，这种眼镜居然很多人不知道！ (grade 0; `huiyi:huiyi-doc-db1593d7a7637ed364fc:0`)

**Cross-method ranking:** dense: first direct rank=2, Top-5 direct hits=1; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=4, Top-5 direct hits=1; reranker: first direct rank=5, Top-5 direct hits=1; iterative: first direct rank=1, Top-5 direct hits=1.
**Observed stage:** candidate generation and sparse ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; No grade-2 candidate is retrieved in the top 20; the first results are unrelated eye-care topics. The current tokenizer/OR retrieval appears to overmatch generic Chinese bigrams.
**DEV follow-up:** Inspect matched term frequencies and add query-level discrimination only in a separate DEV ablation.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-003 — H2-P-005 · multi_hop · bm25

**Question:** 出院后用药调整与待完成检查如何一起纳入连续随访核对？

**Required direct-support evidence:** 5 resolved grade-2 pooled qrels; judge/source references:
- `C-056a3399af0c` / `statpearls:nurse-article-17183:22` · statpearls · Addison Disease (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: Combines medication review and laboratory monitoring at follow-up.
- `C-7459fe0049d8` / `statpearls:article-30476:186` · statpearls · Transient Loss of Vision -- Postoperative and Rehabilitation Care -- Postoperative · exact quote verified: `true` · judge basis: Combines follow-up testing with medication monitoring and adjustment.
- `C-8e085d625e44` / `statpearls:article-29415:39` · statpearls · Sputum Analysis -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: Connects post-discharge therapy monitoring with tests and treatment adjustment.
- `C-912893ceaa2b` / `statpearls:article-27867:22` · statpearls · Prosthetic Valve Endocarditis -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: Links post-discharge medication monitoring with laboratory testing.
- `C-e566fb977897` / `statpearls:nurse-article-17241:24` · statpearls · Adrenal Insufficiency (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: Combines medication instructions and laboratory monitoring at follow-up.

**Dense Top-5:**
- `1` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 2; `statpearls:article-29415:39`)
- `2` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 1; `statpearls:article-20447:47`)
- `3` statpearls — Transient Loss of Vision -- Postoperative and Rehabilitation Care -- Postoperative (grade 2; `statpearls:article-30476:186`)
- `4` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 2; `statpearls:nurse-article-17241:24`)
- `5` statpearls — Ophthalmia Neonatorum (Neonatal Conjunctivitis) -- Deterrence and Patient Education (grade 1; `statpearls:article-26203:184`)
**bm25 Top-5:**
- `1` huiyi — 如何分辨真性近视与假性近视？ (grade 0; `huiyi:huiyi-doc-8c8d872821e569d9c95b:0`)
- `2` huiyi — 宝宝歪头不是萌，小儿斜视要排除! (grade 0; `huiyi:huiyi-doc-0f1d98612548f2b7d2e3:0`)
- `3` huiyi — 孩子患了斜视该如何治疗？ (grade 0; `huiyi:huiyi-doc-f4192c1c3d2bf358d6d4:0`)
- `4` huiyi — 白内障手术效果如何？ (grade 0; `huiyi:huiyi-doc-0290333d1ede47e131f7:0`)
- `5` huiyi — 青光眼专科 (unjudged; `huiyi:huiyi-doc-a804ae2fefc5da8c10bf:0`)

**Cross-method ranking:** dense: first direct rank=1, Top-5 direct hits=3; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=2, Top-5 direct hits=1; reranker: first direct rank=4, Top-5 direct hits=2; iterative: first direct rank=1, Top-5 direct hits=3.
**Observed stage:** candidate generation and sparse ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; The query requires discharge medication changes plus pending tests and follow-up; BM25 retrieves zero of 5 pooled direct-support documents in top 20. The OR expression has no explicit coverage constraint for the separate elements.
**DEV follow-up:** Measure per-element candidate coverage; test conjunctive/multi-query retrieval without changing the frozen question or qrels.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-004 — H2-P-008 · bilingual · bm25

**Question:** How should home monitoring（居家监测）records be reconciled with the follow-up timeline and current symptoms?

**Required direct-support evidence:** 6 resolved grade-2 pooled qrels; judge/source references:
- `C-2ac85a4d8deb` / `pubmed:pubmed23n0021:923` · pubmed · [Nursing record and hourly monitoring]. · exact quote verified: `true` · judge basis: 直接支持汇总记录并作跨日比较
- `C-3ac376e9ffc6` / `statpearls:nurse-article-17172:26` · statpearls · Acute Respiratory Distress Syndrome (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: 连接居家照护、随访计划与病情恶化信号
- `C-50ed12ee4f67` / `statpearls:article-26084:30` · statpearls · Obstructive Sleep Apnea -- Evaluation · exact quote verified: `true` · judge basis: 直接连接监测结果与随访复核
- `C-9c09a60f7caf` / `statpearls:article-21370:28` · statpearls · Essential Hypertension -- Treatment Planning · exact quote verified: `true` · judge basis: 直接列出居家测量与随访时间点
- `C-d207c04bfc24` / `statpearls:article-21413:18` · statpearls · Evidence-Based Medicine -- Nursing, Allied Health, and Interprofessional Team Monitoring · exact quote verified: `true` · judge basis: 直接支持按预定时间观察并结合病情变化复核
- `C-d4f8c103e6d5` / `pubmed:pubmed23n0021:10899` · pubmed · NEW: an interactive data management system for monitoring ambulatory patients. · exact quote verified: `true` · judge basis: 直接支持核验居家数据并追踪时间趋势

**Dense Top-5:**
- `1` statpearls — Postacute Coronavirus (COVID-19) Syndrome -- Treatment / Management -- General Considerations (grade 1; `statpearls:article-133042:67`)
- `2` statpearls — Heinz Body -- Nursing, Allied Health, and Interprofessional Team Monitoring (grade 1; `statpearls:article-56357:13`)
- `3` statpearls — Fingolimod -- Monitoring (grade 1; `statpearls:article-159964:38`)
- `4` statpearls — Fusiform Incision -- Nursing, Allied Health, and Interprofessional Team Monitoring (grade 1; `statpearls:article-22007:31`)
- `5` statpearls — Obstructive Sleep Apnea -- Evaluation (grade 2; `statpearls:article-26084:30`)
**bm25 Top-5:**
- `1` statpearls — Vermont Controlled Substance Abuse, Diversion, Storage, Disposal, Monitoring, and Legal Issues -- Pearls and O… (grade 1; `statpearls:article-127855:136`)
- `2` statpearls — Differentiating Pythium Keratitis From Fungal and Acanthamoeba Keratitis: A Practical Guide -- Treatment Plann… (grade 1; `statpearls:article-181910:110`)
- `3` statpearls — Type 1 Diabetes (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-20431:25`)
- `4` statpearls — Utah Controlled Substance Prescribing -- Pearls and Other Issues -- Maintain Accurate Medical Records Regardin… (grade 1; `statpearls:article-127854:133`)
- `5` pubmed — [Use of the DIAPHANE information system for the monitoring of patients treated by home hemodialysis]. (grade 1; `pubmed:pubmed23n0019:2066`)

**Cross-method ranking:** dense: first direct rank=5, Top-5 direct hits=1; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=10, Top-5 direct hits=0; reranker: first direct rank=3, Top-5 direct hits=1; iterative: first direct rank=3, Top-5 direct hits=2.
**Observed stage:** candidate generation and sparse ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; BM25 returns topical grade-1 monitoring passages but none of 6 grade-2 candidates in top 20. The English/Chinese query terms match generic monitoring records across unrelated conditions.
**DEV follow-up:** Add a bilingual query normalization/term-group ablation and compare direct-support candidate recall.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-005 — H2-P-010 · source_conflict · bm25

**Question:** 患者当前用药清单与最近一次出院小结不一致时，怎样核对各记录的时间和来源？

**Required direct-support evidence:** 15 resolved grade-2 pooled qrels; judge/source references:
- `C-0d6917ec45cd` / `statpearls:article-17464:49` · statpearls · Amiodarone -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: 明确建议进行全面用药核对
- `C-176763f3a7bf` / `statpearls:article-155646:22` · statpearls · Reducing Hospital Readmissions -- Summary / Explanation -- Strategies for Reducing Hospital Readmissions · exact quote verified: `true` · judge basis: 支持出院前进行用药核对
- `C-29d1ee0dd937` / `statpearls:article-155737:32` · statpearls · Voclosporin -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: 支持发现差异后及时沟通
- `C-4ac87d0a73e5` / `statpearls:article-27821:22` · statpearls · Propylthiouracil (PTU) -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: 支持用药核对并报告差异
- `C-50b195fce631` / `statpearls:article-148032:15` · statpearls · Inappropriate Medication in the Geriatric Population -- Clinical Significance -- Medication Reconciliation · exact quote verified: `true` · judge basis: 列出其他处方来源及间歇使用药物
- `C-5e65f64499bb` / `statpearls:article-24883:45` · statpearls · Medication Dispensing Errors and Prevention -- Additional Considerations -- Medication Reconciliation · exact quote verified: `true` · judge basis: 区分处方药与患者当前实际用药
- `C-6510300a1f3d` / `statpearls:article-41082:8` · statpearls · Nursing Admission Assessment and Examination -- Issues of Concern -- Summary Nursing Admission Assessment · exact quote verified: `true` · judge basis: 提供药房电子信息作为核对来源
- `C-944731df2543` / `statpearls:article-27419:39` · statpearls · Polypharmacy -- Additional Considerations -- Strategies to Prevent Polypharmacy · exact quote verified: `true` · judge basis: 支持转衔核对并向接收方交接
- `C-9465a4d6d415` / `statpearls:article-27807:27` · statpearls · Acute Promyelocytic Leukemia (Archived) -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: 提供药物核对、相互作用及剂量核验步骤
- `C-9f344a3a719b` / `statpearls:article-24867:15` · statpearls · Medical History -- Definition/Introduction -- Allergies and Medications · exact quote verified: `true` · judge basis: 支持持续核对完整用药清单
- `C-a1d4d46a9187` / `statpearls:article-19936:85` · statpearls · Peritoneal Dialysis -- Nursing, Allied Health, and Interprofessional Team Interventions · exact quote verified: `true` · judge basis: 涉及出院后用药核对与照护衔接
- `C-b53f05027246` / `statpearls:article-27419:44` · statpearls · Polypharmacy -- Summary and Interprofessional Team Considerations · exact quote verified: `true` · judge basis: 明确要求记录处方日期与持续时间
- `C-d21e8695405d` / `statpearls:article-56122:29` · statpearls · Coronary Artery Stents (Archived) -- Nursing, Allied Health, and Interprofessional Team Interventions · exact quote verified: `true` · judge basis: 支持出院核对并传递病历与计划
- `C-e2b3e7cb501e` / `statpearls:article-25895:19` · statpearls · Nitrates -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: 支持发现用药差异后通知处方者
- `C-f096816ab425` / `statpearls:article-24883:46` · statpearls · Medication Dispensing Errors and Prevention -- Additional Considerations -- Medication Reconciliation · exact quote verified: `true` · judge basis: 明确支持出院时准确核对用药

**Dense Top-5:**
- `1` statpearls — Nursing Admission Assessment and Examination -- Issues of Concern -- Summary Nursing Admission Assessment (grade 2; `statpearls:article-41082:8`)
- `2` statpearls — Nitrates -- Enhancing Healthcare Team Outcomes (grade 2; `statpearls:article-25895:19`)
- `3` textbooks — Pharmacology_Katzung (grade 1; `textbooks:Pharmacology_Katzung:7191`)
- `4` statpearls — Prescription of Controlled Substances: Benefits and Risks (Archived) -- Pearls and Other Issues -- Maintaining… (grade 1; `statpearls:article-40661:251`)
- `5` textbooks — Pharmacology_Katzung (grade 1; `textbooks:Pharmacology_Katzung:7205`)
**bm25 Top-5:**
- `1` huiyi — 透气、耐用……还可抑制近视发展，这种眼镜居然很多人不知道！ (grade 0; `huiyi:huiyi-doc-db1593d7a7637ed364fc:0`)
- `2` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:4`)
- `3` huiyi — 近一两天，突然发生眼前闪光感，然后也没有不舒服和视力下降，这是怎么回事？ (grade 0; `huiyi:huiyi-doc-1c36454c3f188d36cdb1:0`)
- `4` huiyi — 青光眼专科 (grade 0; `huiyi:huiyi-doc-a804ae2fefc5da8c10bf:0`)
- `5` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:3`)

**Cross-method ranking:** dense: first direct rank=1, Top-5 direct hits=2; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=2, Top-5 direct hits=2; reranker: first direct rank=2, Top-5 direct hits=3; iterative: first direct rank=1, Top-5 direct hits=3.
**Observed stage:** candidate generation and sparse ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; The task asks to reconcile medication-list source and time conflicts; BM25 misses all 15 pooled direct-support candidates in top 20 and ranks unrelated Huiyi eye-care pages.
**DEV follow-up:** Test field/term grouping for source, timestamp, and medication concepts; keep provenance as separate evidence, not merged text.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-006 — H2-P-002 · exact_term · rrf

**Question:** 过敏史的来源、发生时间和不确定性通常应记录哪些信息？

**Required direct-support evidence:** 8 resolved grade-2 pooled qrels; judge/source references:
- `C-24ba345ab915` / `statpearls:article-21877:20` · statpearls · Food Allergies -- History and Physical · exact quote verified: `true` · judge basis: Directly addresses exposure source and timing reproducibility.
- `C-41549c99f429` / `textbooks:InternalMed_Harrison:4320` · textbooks · InternalMed_Harrison · exact quote verified: `true` · judge basis: Covers medication exposure timing and causal assessment details.
- `C-c9aab5bd1351` / `statpearls:article-21877:17` · statpearls · Food Allergies -- History and Physical · exact quote verified: `true` · judge basis: Directly specifies food exposure and reaction timing details.
- `C-d2a38d9e008a` / `statpearls:article-20931:19` · statpearls · Egg Allergy -- Evaluation · exact quote verified: `true` · judge basis: Directly covers exposure, reaction, and onset history.
- `C-d2ee2c5a0aeb` / `statpearls:article-38834:9` · statpearls · Wheat Allergy -- History and Physical · exact quote verified: `true` · judge basis: Directly covers allergen exposure and reaction chronology.
- `C-e3be4e4b87eb` / `statpearls:article-161219:48` · statpearls · Adverse Drug Reactions -- Additional Considerations -- Medical History Review · exact quote verified: `true` · judge basis: Directly identifies possible sources of allergy history.
- `C-ea9b63941ab8` / `statpearls:article-30878:14` · statpearls · Contact Urticaria -- History and Physical · exact quote verified: `true` · judge basis: Directly specifies exposure, symptom onset, and resolution timing.
- `C-ee49853c7488` / `statpearls:article-30712:34` · statpearls · Type I Hypersensitivity Reaction -- Evaluation · exact quote verified: `true` · judge basis: Directly covers history source, chronology, and exposure details.

**Dense Top-5:**
- `1` statpearls — Medical History -- Definition/Introduction -- Allergies and Medications (grade 1; `statpearls:article-24867:14`)
- `2` statpearls — Type I Hypersensitivity Reaction -- Evaluation (grade 2; `statpearls:article-30712:34`)
- `3` statpearls — Contact Urticaria -- History and Physical (grade 2; `statpearls:article-30878:14`)
- `4` statpearls — Adverse Drug Reactions -- Additional Considerations -- Timely and Accurate Documentation of Allergies (grade 1; `statpearls:article-161219:49`)
- `5` statpearls — Allergic Conjunctivitis -- History and Physical -- Approach to Evaluation (grade 1; `statpearls:article-19890:94`)
**rrf Top-5:**
- `1` huiyi — 近一两天，突然发生眼前闪光感，然后也没有不舒服和视力下降，这是怎么回事？ (grade 0; `huiyi:huiyi-doc-1c36454c3f188d36cdb1:0`)
- `2` statpearls — Medical History -- Definition/Introduction -- Allergies and Medications (grade 1; `statpearls:article-24867:14`)
- `3` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:1`)
- `4` statpearls — Type I Hypersensitivity Reaction -- Evaluation (grade 2; `statpearls:article-30712:34`)
- `5` huiyi — 关于近视，这些知识点您需要记住 (grade 0; `huiyi:huiyi-doc-4a6fbf86acfb02a82b23:2`)

**Cross-method ranking:** dense: first direct rank=2, Top-5 direct hits=2; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=4, Top-5 direct hits=1; reranker: first direct rank=2, Top-5 direct hits=3; iterative: first direct rank=2, Top-5 direct hits=2.
**Observed stage:** rank fusion and top-20 truncation.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; RRF's first direct-support result is rank 4, versus rank 2 for Dense; the top five contains low-relevance Huiyi results. Eight direct-support documents are pooled for this question.
**DEV follow-up:** Ablate per-channel contribution and candidate eligibility; log source ranks and measure whether noisy BM25 candidates displace Dense evidence.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-007 — H2-P-005 · multi_hop · rrf

**Question:** 出院后用药调整与待完成检查如何一起纳入连续随访核对？

**Required direct-support evidence:** 5 resolved grade-2 pooled qrels; judge/source references:
- `C-056a3399af0c` / `statpearls:nurse-article-17183:22` · statpearls · Addison Disease (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: Combines medication review and laboratory monitoring at follow-up.
- `C-7459fe0049d8` / `statpearls:article-30476:186` · statpearls · Transient Loss of Vision -- Postoperative and Rehabilitation Care -- Postoperative · exact quote verified: `true` · judge basis: Combines follow-up testing with medication monitoring and adjustment.
- `C-8e085d625e44` / `statpearls:article-29415:39` · statpearls · Sputum Analysis -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: Connects post-discharge therapy monitoring with tests and treatment adjustment.
- `C-912893ceaa2b` / `statpearls:article-27867:22` · statpearls · Prosthetic Valve Endocarditis -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: Links post-discharge medication monitoring with laboratory testing.
- `C-e566fb977897` / `statpearls:nurse-article-17241:24` · statpearls · Adrenal Insufficiency (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: Combines medication instructions and laboratory monitoring at follow-up.

**Dense Top-5:**
- `1` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 2; `statpearls:article-29415:39`)
- `2` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 1; `statpearls:article-20447:47`)
- `3` statpearls — Transient Loss of Vision -- Postoperative and Rehabilitation Care -- Postoperative (grade 2; `statpearls:article-30476:186`)
- `4` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 2; `statpearls:nurse-article-17241:24`)
- `5` statpearls — Ophthalmia Neonatorum (Neonatal Conjunctivitis) -- Deterrence and Patient Education (grade 1; `statpearls:article-26203:184`)
**rrf Top-5:**
- `1` huiyi — 如何分辨真性近视与假性近视？ (grade 0; `huiyi:huiyi-doc-8c8d872821e569d9c95b:0`)
- `2` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 2; `statpearls:article-29415:39`)
- `3` huiyi — 宝宝歪头不是萌，小儿斜视要排除! (grade 0; `huiyi:huiyi-doc-0f1d98612548f2b7d2e3:0`)
- `4` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 1; `statpearls:article-20447:47`)
- `5` huiyi — 孩子患了斜视该如何治疗？ (grade 0; `huiyi:huiyi-doc-f4192c1c3d2bf358d6d4:0`)

**Cross-method ranking:** dense: first direct rank=1, Top-5 direct hits=3; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=2, Top-5 direct hits=1; reranker: first direct rank=4, Top-5 direct hits=2; iterative: first direct rank=1, Top-5 direct hits=3.
**Observed stage:** rank fusion and top-20 truncation.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; RRF returns only 1 of 5 direct-support pool documents in its top five, compared with 3 for Dense; the issue is candidate retention/ranking after fusion, not a timeout.
**DEV follow-up:** Compare union-preserving fusion and per-element evidence coverage against frozen RRF; do not raise candidate budget without a separate budget arm.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-008 — H2-P-007 · bilingual · rrf

**Question:** Please explain follow-up for discharge medication changes（出院用药调整）and pending tests（待完成检查）.

**Required direct-support evidence:** 3 resolved grade-2 pooled qrels; judge/source references:
- `C-128f48fc2eb5` / `statpearls:article-20447:47` · statpearls · Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations · exact quote verified: `true` · judge basis: Directly gives follow-up timing after a discharge medication change.
- `C-1df10acb7bb4` / `statpearls:article-28095:57` · statpearls · Acute Pyelonephritis -- Treatment / Management · exact quote verified: `true` · judge basis: Links post-discharge review, pending culture results, and therapy adjustment.
- `C-a9621b854dcc` / `statpearls:article-155646:9` · statpearls · Reducing Hospital Readmissions -- Summary / Explanation -- Reasons Behind Readmissions · exact quote verified: `true` · judge basis: Directly identifies discharge-summary items needing accurate handoff.

**Dense Top-5:**
- `1` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 1; `statpearls:article-29415:39`)
- `2` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17241:24`)
- `3` statpearls — Addison Disease (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17183:22`)
- `4` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 2; `statpearls:article-20447:47`)
- `5` statpearls — Florida Controlled Substance Prescribing -- Enhancing Healthcare Team Outcomes -- Treatment (grade 1; `statpearls:article-126937:222`)
**rrf Top-5:**
- `1` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17241:24`)
- `2` statpearls — Addison Disease (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17183:22`)
- `3` statpearls — Osteoporosis(Archived) (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-26408:15`)
- `4` statpearls — Type 2 Diabetes (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-36052:16`)
- `5` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 1; `statpearls:article-29415:39`)

**Cross-method ranking:** dense: first direct rank=4, Top-5 direct hits=1; bm25: first direct rank=2, Top-5 direct hits=1; rrf: first direct rank=7, Top-5 direct hits=0; reranker: first direct rank=1, Top-5 direct hits=3; iterative: first direct rank=6, Top-5 direct hits=0.
**Observed stage:** rank fusion and top-20 truncation.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; All first five RRF results are grade 1; the direct-support documents land at ranks 7, 9, and 14. Dense's first direct-support result is rank 4 and BM25's is rank 2.
**DEV follow-up:** Inspect common high-ranked generic discharge candidates that accumulate RRF votes; test cross-lingual term handling and weighted/adaptive fusion on DEV.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-009 — H2-P-008 · bilingual · rrf

**Question:** How should home monitoring（居家监测）records be reconciled with the follow-up timeline and current symptoms?

**Required direct-support evidence:** 6 resolved grade-2 pooled qrels; judge/source references:
- `C-2ac85a4d8deb` / `pubmed:pubmed23n0021:923` · pubmed · [Nursing record and hourly monitoring]. · exact quote verified: `true` · judge basis: 直接支持汇总记录并作跨日比较
- `C-3ac376e9ffc6` / `statpearls:nurse-article-17172:26` · statpearls · Acute Respiratory Distress Syndrome (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: 连接居家照护、随访计划与病情恶化信号
- `C-50ed12ee4f67` / `statpearls:article-26084:30` · statpearls · Obstructive Sleep Apnea -- Evaluation · exact quote verified: `true` · judge basis: 直接连接监测结果与随访复核
- `C-9c09a60f7caf` / `statpearls:article-21370:28` · statpearls · Essential Hypertension -- Treatment Planning · exact quote verified: `true` · judge basis: 直接列出居家测量与随访时间点
- `C-d207c04bfc24` / `statpearls:article-21413:18` · statpearls · Evidence-Based Medicine -- Nursing, Allied Health, and Interprofessional Team Monitoring · exact quote verified: `true` · judge basis: 直接支持按预定时间观察并结合病情变化复核
- `C-d4f8c103e6d5` / `pubmed:pubmed23n0021:10899` · pubmed · NEW: an interactive data management system for monitoring ambulatory patients. · exact quote verified: `true` · judge basis: 直接支持核验居家数据并追踪时间趋势

**Dense Top-5:**
- `1` statpearls — Postacute Coronavirus (COVID-19) Syndrome -- Treatment / Management -- General Considerations (grade 1; `statpearls:article-133042:67`)
- `2` statpearls — Heinz Body -- Nursing, Allied Health, and Interprofessional Team Monitoring (grade 1; `statpearls:article-56357:13`)
- `3` statpearls — Fingolimod -- Monitoring (grade 1; `statpearls:article-159964:38`)
- `4` statpearls — Fusiform Incision -- Nursing, Allied Health, and Interprofessional Team Monitoring (grade 1; `statpearls:article-22007:31`)
- `5` statpearls — Obstructive Sleep Apnea -- Evaluation (grade 2; `statpearls:article-26084:30`)
**rrf Top-5:**
- `1` pubmed — [Use of the DIAPHANE information system for the monitoring of patients treated by home hemodialysis]. (grade 1; `pubmed:pubmed23n0019:2066`)
- `2` statpearls — Vermont Controlled Substance Abuse, Diversion, Storage, Disposal, Monitoring, and Legal Issues -- Pearls and O… (grade 1; `statpearls:article-127855:136`)
- `3` statpearls — Postacute Coronavirus (COVID-19) Syndrome -- Treatment / Management -- General Considerations (grade 1; `statpearls:article-133042:67`)
- `4` statpearls — Differentiating Pythium Keratitis From Fungal and Acanthamoeba Keratitis: A Practical Guide -- Treatment Plann… (grade 1; `statpearls:article-181910:110`)
- `5` statpearls — Heinz Body -- Nursing, Allied Health, and Interprofessional Team Monitoring (grade 1; `statpearls:article-56357:13`)

**Cross-method ranking:** dense: first direct rank=5, Top-5 direct hits=1; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=10, Top-5 direct hits=0; reranker: first direct rank=3, Top-5 direct hits=1; iterative: first direct rank=3, Top-5 direct hits=2.
**Observed stage:** rank fusion and top-20 truncation.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; RRF puts the first direct-support result at rank 10 (then 15, 16, 20); Dense finds one at rank 5. Top five are generic monitoring context, so the first page misses direct support.
**DEV follow-up:** Check whether sparse-only generic monitoring candidates outrank Dense direct evidence; measure the fused candidate list before reranking.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-010 — H2-P-005 · multi_hop · reranker

**Question:** 出院后用药调整与待完成检查如何一起纳入连续随访核对？

**Required direct-support evidence:** 5 resolved grade-2 pooled qrels; judge/source references:
- `C-056a3399af0c` / `statpearls:nurse-article-17183:22` · statpearls · Addison Disease (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: Combines medication review and laboratory monitoring at follow-up.
- `C-7459fe0049d8` / `statpearls:article-30476:186` · statpearls · Transient Loss of Vision -- Postoperative and Rehabilitation Care -- Postoperative · exact quote verified: `true` · judge basis: Combines follow-up testing with medication monitoring and adjustment.
- `C-8e085d625e44` / `statpearls:article-29415:39` · statpearls · Sputum Analysis -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: Connects post-discharge therapy monitoring with tests and treatment adjustment.
- `C-912893ceaa2b` / `statpearls:article-27867:22` · statpearls · Prosthetic Valve Endocarditis -- Enhancing Healthcare Team Outcomes · exact quote verified: `true` · judge basis: Links post-discharge medication monitoring with laboratory testing.
- `C-e566fb977897` / `statpearls:nurse-article-17241:24` · statpearls · Adrenal Insufficiency (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: Combines medication instructions and laboratory monitoring at follow-up.

**Dense Top-5:**
- `1` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 2; `statpearls:article-29415:39`)
- `2` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 1; `statpearls:article-20447:47`)
- `3` statpearls — Transient Loss of Vision -- Postoperative and Rehabilitation Care -- Postoperative (grade 2; `statpearls:article-30476:186`)
- `4` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 2; `statpearls:nurse-article-17241:24`)
- `5` statpearls — Ophthalmia Neonatorum (Neonatal Conjunctivitis) -- Deterrence and Patient Education (grade 1; `statpearls:article-26203:184`)
**reranker Top-5:**
- `1` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 1; `statpearls:article-20447:47`)
- `2` statpearls — Coronary Artery Stents (Archived) -- Nursing, Allied Health, and Interprofessional Team Interventions (grade 1; `statpearls:article-56122:29`)
- `3` statpearls — Foville Syndrome -- Enhancing Healthcare Team Outcomes (grade 1; `statpearls:article-21942:46`)
- `4` statpearls — Prosthetic Valve Endocarditis -- Enhancing Healthcare Team Outcomes (grade 2; `statpearls:article-27867:22`)
- `5` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 2; `statpearls:article-29415:39`)

**Cross-method ranking:** dense: first direct rank=1, Top-5 direct hits=3; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=2, Top-5 direct hits=1; reranker: first direct rank=4, Top-5 direct hits=2; iterative: first direct rank=1, Top-5 direct hits=3.
**Observed stage:** reranker ordering over fixed RRF candidates.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; The reranker places the first direct-support document at rank 4 and has only 2 of 5 direct-support documents in top five; Dense and Iterative each place a direct-support result at rank 1.
**DEV follow-up:** Inspect pairwise query-document judgments and reranker scores for the top 20; test reranker against the same candidate union, preserving this run as baseline.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-011 — H2-P-007 · bilingual · iterative

**Question:** Please explain follow-up for discharge medication changes（出院用药调整）and pending tests（待完成检查）.

**Required direct-support evidence:** 3 resolved grade-2 pooled qrels; judge/source references:
- `C-128f48fc2eb5` / `statpearls:article-20447:47` · statpearls · Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations · exact quote verified: `true` · judge basis: Directly gives follow-up timing after a discharge medication change.
- `C-1df10acb7bb4` / `statpearls:article-28095:57` · statpearls · Acute Pyelonephritis -- Treatment / Management · exact quote verified: `true` · judge basis: Links post-discharge review, pending culture results, and therapy adjustment.
- `C-a9621b854dcc` / `statpearls:article-155646:9` · statpearls · Reducing Hospital Readmissions -- Summary / Explanation -- Reasons Behind Readmissions · exact quote verified: `true` · judge basis: Directly identifies discharge-summary items needing accurate handoff.

**Dense Top-5:**
- `1` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 1; `statpearls:article-29415:39`)
- `2` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17241:24`)
- `3` statpearls — Addison Disease (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17183:22`)
- `4` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 2; `statpearls:article-20447:47`)
- `5` statpearls — Florida Controlled Substance Prescribing -- Enhancing Healthcare Team Outcomes -- Treatment (grade 1; `statpearls:article-126937:222`)
**iterative Top-5:**
- `1` statpearls — Addison Disease (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17183:22`)
- `2` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17241:24`)
- `3` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 1; `statpearls:article-29415:39`)
- `4` statpearls — Substance Use in Pregnancy and Neonatal Withdrawal Syndromes -- Treatment / Management (grade 1; `statpearls:article-26972:22`)
- `5` pubmed — Simulated discharge system of prescription and long-term drug treatment in a psychiatric hospital. (grade 1; `pubmed:pubmed23n0002:1043`)

**Cross-method ranking:** dense: first direct rank=4, Top-5 direct hits=1; bm25: first direct rank=2, Top-5 direct hits=1; rrf: first direct rank=7, Top-5 direct hits=0; reranker: first direct rank=1, Top-5 direct hits=3; iterative: first direct rank=6, Top-5 direct hits=0.
**Observed stage:** planner query generation, retrieval, and final ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; The planner generates two generic discharge-follow-up paraphrases. The first direct-support result is rank 6, with only 1 of 3 pooled direct-support documents present in the final 20; reranking reaches rank 1 on this query.
**DEV follow-up:** Require the planner to retain the query's evidence elements and stop only after per-element support checks; compare at matched retrieval-call and candidate budgets.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-012 — H2-P-007 · bilingual · dense

**Question:** Please explain follow-up for discharge medication changes（出院用药调整）and pending tests（待完成检查）.

**Required direct-support evidence:** 3 resolved grade-2 pooled qrels; judge/source references:
- `C-128f48fc2eb5` / `statpearls:article-20447:47` · statpearls · Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations · exact quote verified: `true` · judge basis: Directly gives follow-up timing after a discharge medication change.
- `C-1df10acb7bb4` / `statpearls:article-28095:57` · statpearls · Acute Pyelonephritis -- Treatment / Management · exact quote verified: `true` · judge basis: Links post-discharge review, pending culture results, and therapy adjustment.
- `C-a9621b854dcc` / `statpearls:article-155646:9` · statpearls · Reducing Hospital Readmissions -- Summary / Explanation -- Reasons Behind Readmissions · exact quote verified: `true` · judge basis: Directly identifies discharge-summary items needing accurate handoff.

**Dense Top-5:**
- `1` statpearls — Sputum Analysis -- Enhancing Healthcare Team Outcomes (grade 1; `statpearls:article-29415:39`)
- `2` statpearls — Adrenal Insufficiency (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17241:24`)
- `3` statpearls — Addison Disease (Nursing) -- Discharge Planning (grade 1; `statpearls:nurse-article-17183:22`)
- `4` statpearls — Diabetic Perioperative Management -- Summary and Interprofessional Team Considerations (grade 2; `statpearls:article-20447:47`)
- `5` statpearls — Florida Controlled Substance Prescribing -- Enhancing Healthcare Team Outcomes -- Treatment (grade 1; `statpearls:article-126937:222`)

**Cross-method ranking:** dense: first direct rank=4, Top-5 direct hits=1; bm25: first direct rank=2, Top-5 direct hits=1; rrf: first direct rank=7, Top-5 direct hits=0; reranker: first direct rank=1, Top-5 direct hits=3; iterative: first direct rank=6, Top-5 direct hits=0.
**Observed stage:** dense top-k ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; Dense's first direct-support result is rank 4 while reranking reaches rank 1; this is a comparative ranking weakness, not a top-five miss.
**DEV follow-up:** Check the language mix and evidence wording for this frozen query; compare bilingual normalization and reranker under the same top-20 candidate pool.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-013 — H2-P-008 · bilingual · dense

**Question:** How should home monitoring（居家监测）records be reconciled with the follow-up timeline and current symptoms?

**Required direct-support evidence:** 6 resolved grade-2 pooled qrels; judge/source references:
- `C-2ac85a4d8deb` / `pubmed:pubmed23n0021:923` · pubmed · [Nursing record and hourly monitoring]. · exact quote verified: `true` · judge basis: 直接支持汇总记录并作跨日比较
- `C-3ac376e9ffc6` / `statpearls:nurse-article-17172:26` · statpearls · Acute Respiratory Distress Syndrome (Nursing) -- Discharge Planning · exact quote verified: `true` · judge basis: 连接居家照护、随访计划与病情恶化信号
- `C-50ed12ee4f67` / `statpearls:article-26084:30` · statpearls · Obstructive Sleep Apnea -- Evaluation · exact quote verified: `true` · judge basis: 直接连接监测结果与随访复核
- `C-9c09a60f7caf` / `statpearls:article-21370:28` · statpearls · Essential Hypertension -- Treatment Planning · exact quote verified: `true` · judge basis: 直接列出居家测量与随访时间点
- `C-d207c04bfc24` / `statpearls:article-21413:18` · statpearls · Evidence-Based Medicine -- Nursing, Allied Health, and Interprofessional Team Monitoring · exact quote verified: `true` · judge basis: 直接支持按预定时间观察并结合病情变化复核
- `C-d4f8c103e6d5` / `pubmed:pubmed23n0021:10899` · pubmed · NEW: an interactive data management system for monitoring ambulatory patients. · exact quote verified: `true` · judge basis: 直接支持核验居家数据并追踪时间趋势

**Dense Top-5:**
- `1` statpearls — Postacute Coronavirus (COVID-19) Syndrome -- Treatment / Management -- General Considerations (grade 1; `statpearls:article-133042:67`)
- `2` statpearls — Heinz Body -- Nursing, Allied Health, and Interprofessional Team Monitoring (grade 1; `statpearls:article-56357:13`)
- `3` statpearls — Fingolimod -- Monitoring (grade 1; `statpearls:article-159964:38`)
- `4` statpearls — Fusiform Incision -- Nursing, Allied Health, and Interprofessional Team Monitoring (grade 1; `statpearls:article-22007:31`)
- `5` statpearls — Obstructive Sleep Apnea -- Evaluation (grade 2; `statpearls:article-26084:30`)

**Cross-method ranking:** dense: first direct rank=5, Top-5 direct hits=1; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=10, Top-5 direct hits=0; reranker: first direct rank=3, Top-5 direct hits=1; iterative: first direct rank=3, Top-5 direct hits=2.
**Observed stage:** dense top-k ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; Dense's first direct-support result is rank 5; RRF reaches rank 10, while reranker and Iterative place direct evidence at rank 3. Dense still finds direct evidence in top five.
**DEV follow-up:** Inspect which evidence elements appear in the dense first four and evaluate a fixed candidate-preserving rerank on DEV.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-014 — H2-P-011 · no_answer · dense

**Question:** 慧宜医院非公开的 2026 年眼科急诊绿色通道内部操作规程第 4 条原文是什么？

**Answerability:** `pending`; dataset review status `pending`. No grade-2 qrels in the judged pool, but no-answer gold is not finalized (`noAnswerGoldValidated=false`); this is not an observed false-support outcome.

**Dense Top-5:**
- `1` huiyi — 院长致辞 (grade 0; `huiyi:huiyi-doc-9a5e2f1bb99a1460d6ef:0`)
- `2` huiyi — 恩施慧宜眼科医院 (grade 0; `huiyi:huiyi-doc-116b12ab7b0d3e2c60cf:0`)
- `3` huiyi — 近视防控专科 (grade 0; `huiyi:huiyi-doc-1247e5e4a301dc10f0e1:0`)
- `4` huiyi — 综合眼病专科 (grade 1; `huiyi:huiyi-doc-6491ff945592acd85627:0`)
- `5` statpearls — Traumatic Cataract -- Enhancing Healthcare Team Outcomes (grade 1; `statpearls:article-144554:240`)

**Cross-method ranking:** dense: first direct rank=None, Top-5 direct hits=0; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=None, Top-5 direct hits=0; reranker: first direct rank=None, Top-5 direct hits=0; iterative: first direct rank=None, Top-5 direct hits=0.
**Observed stage:** dense top-k ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; The frozen query asks for a non-public 2026 internal protocol; the pooled qrels contain no grade-2 support. Retrieval returns topical candidates, but this experiment did not generate an answer and cannot establish false-support behavior.
**DEV follow-up:** Add a fixed-generator abstention test with claim-level support checks; do not treat retrieval presence as an answer failure.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## BC-015 — H2-P-012 · no_answer · iterative

**Question:** 慧宜医院内部 2026 年第三季度未公开的药品目录调整备忘录具体内容是什么？

**Answerability:** `pending`; dataset review status `pending`. No grade-2 qrels in the judged pool, but no-answer gold is not finalized (`noAnswerGoldValidated=false`); this is not an observed false-support outcome.

**Dense Top-5:**
- `1` huiyi — 院长致辞 (grade 0; `huiyi:huiyi-doc-9a5e2f1bb99a1460d6ef:0`)
- `2` huiyi — 近视防控专科 (grade 0; `huiyi:huiyi-doc-1247e5e4a301dc10f0e1:0`)
- `3` statpearls — Antiemetic Medications -- Contraindications (grade 0; `statpearls:article-17690:22`)
- `4` statpearls — Protriptyline -- Contraindications (grade 0; `statpearls:article-27900:23`)
- `5` textbooks — InternalMed_Harrison (grade 0; `textbooks:InternalMed_Harrison:23062`)
**iterative Top-5:**
- `1` pubmed — Can pharmacists influence drug prescribing? A look at eight of the top 25 drug products for 1976. (grade 1; `pubmed:pubmed23n0022:4927`)
- `2` huiyi — 院长致辞 (grade 0; `huiyi:huiyi-doc-9a5e2f1bb99a1460d6ef:0`)
- `3` huiyi — 近视防控专科 (grade 0; `huiyi:huiyi-doc-1247e5e4a301dc10f0e1:0`)
- `4` statpearls — Antiemetic Medications -- Contraindications (grade 0; `statpearls:article-17690:22`)
- `5` pubmed — Drug utilization review in an HMO. I. Introduction and examples of methodology. (grade 1; `pubmed:pubmed23n0001:9353`)

**Cross-method ranking:** dense: first direct rank=None, Top-5 direct hits=0; bm25: first direct rank=None, Top-5 direct hits=0; rrf: first direct rank=None, Top-5 direct hits=0; reranker: first direct rank=None, Top-5 direct hits=0; iterative: first direct rank=None, Top-5 direct hits=0.
**Observed stage:** planner query generation, retrieval, and final ranking.
**Judge basis and attribution:** pooled relevance grades are the machine-judge labels above; The frozen query asks for an unpublished internal drug-catalog memo; the pooled qrels contain no grade-2 support. Iterative retrieval still returns topical material, but answer abstention was not tested.
**DEV follow-up:** Measure whether the sufficiency gate returns evidence-insufficient under fixed thresholds and generator prompts.
**Verified change:** none; this case records the frozen A-E baseline and does not claim a fix

## Interpretation and limits

- The 11 counted regressions are method/query comparisons, not eleven unique medical cases. They point to concrete ranking misses and regressions on the frozen pilot, but the qrels are not external expert labels.
- BC-001–005 show the most severe pattern: BM25 fails to retrieve pooled direct-support candidates for five queries, despite Dense retrieving some on the same frozen pool. In inspected examples, CJK bigram OR matching promotes unrelated Huiyi eye-care pages.
- BC-006–009 show that RRF can demote useful Dense/BM25 results when generic candidates receive high channel ranks. BC-010 records a reranker displacement; BC-011 shows Iterative does not fix every bilingual query.
- BC-014/015 are no-answer-intended risks only. Their `answerability` and `reviewStatus` are still pending; retrieval output cannot establish answer abstention, false support, or a valid no-answer rate.
- Follow-up diagnostic: requiring **all** unique BM25 tokens to match returned **0/12 queries / 0 candidates**. Against the same resolved pooled qrels this gives nDCG@10 0.000, MRR@10 0.000, P@5 0.000 and pooled Recall@5 0.000 (the latter two over 7 defined questions). This shows that blanket AND is over-restrictive; it does not establish that OR alone caused all BM25 failures. The score is separate from A–E and the probe used the existing index read-only.
- No algorithm repair has been validated and no post-observation cohort/qrel change is included. Any next fix must be a separate, versioned DEV experiment; preserve the original A–E runs and score.

Machine details and all document-level top-5 references are in [`h2-pilot-v2-quality-bad-cases.json`](../../eval/rag-retrieval/results/h2-pilot-v2-quality-bad-cases.json). The main pilot score is in [`H2-PILOT-QUALITY-SCORE-20261015.md`](H2-PILOT-QUALITY-SCORE-20261015.md).
