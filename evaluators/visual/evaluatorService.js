// Visual evaluator orchestrator.
//
// Batch 2 (this commit): resource lifecycle is now leak-proof.
//   - V-05/V-06: every browser/context/server is released in a single `finally`,
//     even when the reference screenshot or navigation throws.
//   - V-16/V-25: all artifacts (screenshots) live in a per-job temp dir that is
//     deleted in `finally`; nothing is written into the source tree anymore
//     (the old `final_scores.json` write is gone — results are returned instead).
//
// Scoring / rubric / vision correctness is addressed in Batch 3.
import crypto from "crypto";
import { parseRubricWithSelectors } from "./rubricService.js";
import { scanStudentFolders } from "./scannerService.js";
import { runDynamicDomChecks } from "./domService.js";
import runBehaviorChecks from "./behaviourService.js";
import buildVisionPrompt from "./utils/promptBuilder.js";
import {
  computeDomScore,
  computeBehaviorScore,
  manualReviewItems,
  manualReviewDetail,
  assembleScore,
  clampScore,
  buildDomBreakdown,
  buildBehaviorBreakdown
} from "./scoring.js";
import { readSourceText, computeCodeScore } from "./codeService.js";
import fs from "fs/promises";
import os from "os";
import path from "path";
import OpenAI from "openai";
import { getBrowserPool } from "./browserPool.js";
import { startStaticServer } from "./localServerService.js";
import { assertSafeUrl } from "./utils/urlGuard.js";
import logger from "../../config/logger.js";

// V-42: lazy init so a missing OPENAI_API_KEY doesn't crash the server at boot.
let _openai;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }
  return _openai;
}

// Consistent capture geometry for student vs reference (V-23/V-26).
const VIEWPORT = { width: 1366, height: 900 };

// Reference-screenshot cache (V-29): the reference design is identical across all
// submissions of an assignment, so render it once per (assignmentId, expectedUrl)
// and reuse the PNG buffer. Stores in-flight promises to dedupe concurrent jobs.
const EXPECTED_CACHE = new Map(); // key -> Promise<Buffer>
const EXPECTED_CACHE_MAX = 20;

function setExpectedCache(key, val) {
  if (EXPECTED_CACHE.size >= EXPECTED_CACHE_MAX) {
    EXPECTED_CACHE.delete(EXPECTED_CACHE.keys().next().value); // evict oldest
  }
  EXPECTED_CACHE.set(key, val);
}

// Evaluation cache (assignmentId + sha256(sourceText)):
// Guarantees 100% deterministic score reproduction when the same code is evaluated.
const EVALUATION_CACHE = new Map();
const EVALUATION_CACHE_MAX = 50;

async function renderExpectedScreenshot(context, expectedUrl) {
  // V-03: re-validate right before navigating (defense in depth vs DNS rebinding).
  await assertSafeUrl(expectedUrl);
  const page = await context.newPage();
  try {
    await page.goto(expectedUrl, { waitUntil: "networkidle", timeout: 30000 }); // V-24
    // V-39: a shortener/redirect may land on a different host that bypassed the
    // initial guard (e.g. tinyurl -> internal IP). Re-validate the final URL.
    const finalUrl = page.url();
    if (finalUrl !== expectedUrl) await assertSafeUrl(finalUrl);
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    return await page.screenshot({ fullPage: false }); // V-26
  } finally {
    await page.close().catch(() => {});
  }
}


async function generateVisualAIFeedback({ studentName, rubric, score, domBreakdown, behaviorBreakdown, codeBreakdown, visualBreakdown, unifiedBreakdown, sourceText }) {
  const openai = getOpenAI();
  if (!openai) return null;

  try {
    const criteriaSummary = (unifiedBreakdown || []).map((b, i) => {
      return `Criterion ${i + 1}: "${b.item}" (${b.max} marks)`;
    }).join("\n");

    const prompt = `You are an expert, objective code evaluator assessing a student's HTML/CSS/JavaScript project.
Candidate Submission
Rubric Criteria:
${criteriaSummary}

Candidate's Actual Source Code:
${(sourceText || "").slice(0, 15000)}

Your evaluation guidelines:
1. "reconciliation": Inspect the candidate's code against each criterion in the EXACT order listed above:
   - For each criterion, assign a discrete "status":
     * "perfect": The requirement is completely met with clean, functional, bug-free code. (Earns 100% of criterion marks).
     * "minor_gap": The feature works fundamentally, but has minor defects or edge-case omissions (e.g. unpadded digits in 24-hour mode like '9:05:03', toggle button label text does not update after click, minor styling issue). (Earns 85% of criterion marks).
     * "major_gap": The feature partially works, but has major logic flaws, off-by-one errors (e.g. wrong month in date), or empty placeholder elements with content outside. (Earns 60% of criterion marks).
     * "broken": Missing, non-functional, empty stubs, or completely broken. (Earns 0 marks).
     * "upward_reconciled": Automated tests gave 0 because of different element IDs/class names, but the candidate's code genuinely implemented the feature correctly. (Earns 100% if perfect, or 85% if minor defects).
   - "reason": 1-2 concise, technical sentences citing the candidate's actual code (mentioning specific variables, element IDs/classes, or functions) and explaining why this status was chosen.
2. "summary": 2-3 concise, honest, and educational sentences summarizing what the candidate achieved, citing what worked well and what specifically was missing or had gaps in their code. Include one concrete actionable tip to improve.
3. "strengths": Array of strings for criteria that passed or excelled. Each string MUST start with "[<Exact Criterion Name>] " and give a 1-2 sentence technical explanation citing what the candidate specifically implemented in their HTML, CSS, or JS (citing actual element tags, classes, functions, or APIs).
4. "issues": Array of strings for criteria that have bugs, gaps, or lost marks. Each string MUST start with "[<Exact Criterion Name>] " and explain specifically what was missing, incorrect, or incomplete in their code. If and only if the candidate has 100% flawless implementation, provide 1 subtle best-practice suggestion or leave empty.

Return STRICT JSON only matching this format:
{
  "summary": "...",
  "strengths": ["...", "..."],
  "issues": ["..."],
  "reconciliation": [
    {
      "criterionIndex": 1,
      "item": "<Exact Criterion Name>",
      "status": "perfect" | "minor_gap" | "major_gap" | "broken" | "upward_reconciled",
      "reason": "..."
    }
  ]
}`;

    const model = process.env.OPENAI_MODEL || "deepseek-v4-flash";
    const res = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }]
    });

    const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
    if (parsed.summary && Array.isArray(parsed.strengths)) {
      return parsed;
    }
  } catch (err) {
    logger.warn(`Visual AI feedback generation failed (${err.message}) — using deterministic fallback.`);
  }
  return null;
}

export async function evaluateStudentsWithVision({
  jobId,
  assignmentId,
  studentId,
  studentName,
  repoPath,
  rubricText,
  expectedUrl,
  entryFile = null
}) {
  if (!repoPath || !rubricText || !expectedUrl) {
    throw new Error("Missing required inputs");
  }

  const rubric = await parseRubricWithSelectors(rubricText);
  const student = await scanStudentFolders(repoPath, entryFile);

  const results = [];
  const name = studentName;

  // Missing required files: bail out BEFORE spinning up a server/browser (V-06).
  if (student.flags.length > 0) {
    const summary = `Missing required files for evaluation: ${student.flags.join(", ")}`;
    results.push({
      name,
      score: 0,
      feedback: {
        summary,
        strengths: [],
        issues: [summary],
        breakdown: []
      },
      manualCorrection: true
    });
    return results;
  }

  // Source-code checks ("code" rubric items) read the actual files on disk —
  // no browser needed, so run them independently of the render pipeline below.
  const sourceText = await readSourceText(student);
  const sourceHash = crypto.createHash("sha256").update(sourceText || "").digest("hex");
  const evalCacheKey = `${assignmentId || ""}::${sourceHash}`;

  if (EVALUATION_CACHE.has(evalCacheKey)) {
    try {
      const raw = await EVALUATION_CACHE.get(evalCacheKey);
      if (raw && raw.score !== undefined && !raw.error) {
        logger.info(`Evaluation cache hit for ${name} (assignment: ${assignmentId}, hash: ${sourceHash.slice(0, 8)})`);
        const cachedResult = JSON.parse(JSON.stringify(raw));
        cachedResult.name = name;
        cachedResult.studentId = studentId;
        if (cachedResult.feedback?.summary) {
          cachedResult.feedback.summary = cachedResult.feedback.summary.replace(/\b(Candidate|Student)\b/g, name);
        }
        return [cachedResult];
      }
    } catch {
      EVALUATION_CACHE.delete(evalCacheKey);
    }
  }

  let resolveJob;
  const inFlightPromise = new Promise((resolve) => {
    resolveJob = resolve;
  });
  if (EVALUATION_CACHE.size >= EVALUATION_CACHE_MAX) {
    EVALUATION_CACHE.delete(EVALUATION_CACHE.keys().next().value);
  }
  EVALUATION_CACHE.set(evalCacheKey, inFlightPromise);

  const { score: codeScore, breakdown: codeBreakdown } = await computeCodeScore(rubric, sourceText);

  // Per-job artifact dir (V-16/V-25) — unique, outside the source tree, always cleaned up.
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `visual-${jobId || studentId || "job"}-`)
  );

  const browserPool = await getBrowserPool();
  let browser = null;
  let context = null;
  let server = null;

  try {
    const started = await startStaticServer(student.basePath);
    server = started.server;
    const localUrl = started.url;

    browser = await browserPool.borrow();
    context = await browser.newContext({ viewport: VIEWPORT }); // V-23

    // ---- Reference (expected) screenshot, cached per assignment (V-29) ----
    const cacheKey = `${assignmentId || ""}::${expectedUrl}`;
    let expectedPromise = EXPECTED_CACHE.get(cacheKey);
    if (!expectedPromise) {
      expectedPromise = renderExpectedScreenshot(context, expectedUrl);
      setExpectedCache(cacheKey, expectedPromise);
    }
    let expectedImg;
    try {
      expectedImg = await expectedPromise;
    } catch (err) {
      EXPECTED_CACHE.delete(cacheKey); // don't cache a failure
      throw err;
    }

    // student.html comes from globby, which always normalizes to forward
    // slashes; student.basePath comes from path.join, which uses backslashes
    // on Windows. Normalize basePath first or the .replace below silently
    // no-ops and relativeHtml stays a full absolute path.
    const normalizedBasePath = student.basePath.replace(/\\/g, "/");
    const relativeHtml = student.html
      .replace(/\\/g, "/")
      .replace(normalizedBasePath, "");
    const url = `${localUrl}${relativeHtml}`;

    const page = await context.newPage();
    try {
      const responsePage = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }); // V-24
      await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}); // V-24
      logger.debug(`Opening student url: ${url} status: ${responsePage?.status()}`);

      const screenshotPath = path.join(workDir, `${studentId || name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }); // V-26

      const domResults = await runDynamicDomChecks(page, rubric);
      const behaviorResults = await runBehaviorChecks(page, rubric);

      // Deterministic, single-counted scores (V-07/V-21).
      const domScore = computeDomScore(rubric, domResults);
      const behaviorScore = computeBehaviorScore(rubric, behaviorResults);

      // V-40: if the page rendered blank or errored, don't waste a vision call on
      // an empty screenshot (and don't silently score it) — flag for manual review.
      const httpStatus = responsePage?.status() ?? 0;
      const bodyText = (await page
        .evaluate(() => (document.body ? document.body.innerText : ""))
        .catch(() => "")) || "";
      const blank = bodyText.trim().length < 3;
      const badStatus = httpStatus >= 400;
      if (blank || badStatus) {
        const score = assembleScore({ rubric, domScore, behaviorScore, visualScore: 0, codeScore });
        const summary = badStatus
          ? `The page returned HTTP ${httpStatus} — it may not be a built/hosted site. Needs manual review.`
          : `The page rendered blank (no visible content). If this is an unbuilt React/Vue app, evaluate the built/hosted site instead. Needs manual review.`;
        
        const domBreakdown = buildDomBreakdown(rubric, domResults);
        const behaviorBreakdown = buildBehaviorBreakdown(rubric, behaviorResults);
        const unifiedBreakdown = [
          ...domBreakdown.map(b => ({ item: b.item, awarded: 0, max: b.max, reason: "Page failed to render or returned an error status." })),
          ...behaviorBreakdown.map(b => ({ item: b.item, awarded: 0, max: b.max, reason: "Page failed to render or returned an error status." })),
          ...(codeBreakdown || []).map(b => ({ item: b.item, awarded: b.awarded, max: b.max, reason: b.awarded === b.max ? "Code checks passed." : "Code checks failed." }))
        ];

        results.push({
          name,
          studentId,
          score: score.total,
          ...score,
          manualReviewItems: manualReviewItems(rubric),
          manualReviewDetail: manualReviewDetail(rubric),
          domBreakdown,
          behaviorBreakdown,
          codeBreakdown,
          feedback: {
            summary,
            strengths: [],
            issues: [summary],
            breakdown: unifiedBreakdown
          },
          manualCorrection: true,
          blankPage: true
        });
        return results; // finally blocks still run cleanup
      }

      const maxVisual = rubric
        .filter(r => r.type === "visual")
        .reduce((s, r) => s + (Number(r.weight) || 0), 0);
      let visualScore = 0;
      let visionFeedback = "";
      let visualBreakdown = [];

      if (maxVisual > 0) {
        try {
          const prompt = buildVisionPrompt(rubric, domResults, behaviorResults);
          const model = process.env.OPENAI_MODEL || "deepseek-v4-flash";
          const isVisionModel = !model.includes("deepseek");

          let messages;
          if (isVisionModel) {
            const studentImage = await fs.readFile(screenshotPath);
            messages = [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${studentImage.toString("base64")}`
                    }
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${expectedImg.toString("base64")}`
                    }
                  }
                ]
              }
            ];
          } else {
            messages = [
              {
                role: "user",
                content: `${prompt}\n\nSTUDENT SOURCE CODE (HTML & CSS):\n${sourceText.slice(0, 4000)}`
              }
            ];
          }

          const aiRes = await getOpenAI().chat.completions.create({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages
          });

          const raw = aiRes.choices?.[0]?.message?.content ?? "{}";
          visionFeedback = raw;
          const parsed = JSON.parse(raw);
          const rawVisual = Number(parsed.visualScore) || 0;
          visualScore = clampScore(rawVisual, maxVisual);
          visualBreakdown = Array.isArray(parsed.breakdown) ? parsed.breakdown : [];
        } catch (err) {
          logger.warn(`Visual scoring AI call failed (${err.message}) — using fallback score`);
          visualScore = Math.round(maxVisual * 0.8);
        }
      }

      const score = assembleScore({ rubric, domScore, behaviorScore, visualScore, codeScore });
      const needsManual = manualReviewItems(rubric);
 
      const domBreakdown = buildDomBreakdown(rubric, domResults);
      const behaviorBreakdown = buildBehaviorBreakdown(rubric, behaviorResults);
      
      const strengths = [];
      const issues = [];

      domBreakdown.forEach(b => {
        if (b.awarded === b.max) {
          strengths.push(`[${b.item}] Perfect DOM layout (earned ${b.max}/${b.max} marks)`);
        } else if (b.awarded > 0) {
          issues.push(`[${b.item}] Partially correct DOM structure. Some required elements are missing (earned ${b.awarded}/${b.max} marks)`);
        } else {
          issues.push(`[${b.item}] Missing/Incorrect DOM layout. Expected elements not found (earned 0/${b.max} marks)`);
        }
      });

      behaviorBreakdown.forEach(b => {
        if (b.awarded === b.max) {
          strengths.push(`[${b.item}] Perfect dynamic interactivity (earned ${b.max}/${b.max} marks)`);
        } else {
          issues.push(`[${b.item}] Dynamic interaction failed: functionality check did not pass (earned 0/${b.max} marks)`);
        }
      });

      (codeBreakdown || []).forEach(b => {
        if (b.awarded === b.max) {
          strengths.push(`[${b.item}] Proper code quality & API checks passed (earned ${b.max}/${b.max} marks)`);
        } else {
          issues.push(`[${b.item}] Code requirement failed: missing expected methods or patterns (earned 0/${b.max} marks)`);
        }
      });

      visualBreakdown.forEach(b => {
        if (b.max === 0) return; // Skip 0-weight/placeholder visual items
        if (b.awarded === b.max) {
          strengths.push(`[Visual: ${b.item}] Design looks correct and matches reference layout (earned ${b.max}/${b.max} marks)`);
        } else {
          issues.push(`[Visual: ${b.item}] Design layout mismatch: ${b.reason || "differs from expected reference"} (earned ${b.awarded}/${b.max} marks)`);
        }
      });

      const unifiedBreakdown = [
        ...domBreakdown.map(b => ({
          item: b.item,
          awarded: b.awarded,
          max: b.max,
          reason: b.awarded === b.max ? "Perfect implementation. All element checks passed." : "Incorrect element tags, classes, or missing DOM items."
        })),
        ...behaviorBreakdown.map(b => ({
          item: b.item,
          awarded: b.awarded,
          max: b.max,
          reason: b.awarded === b.max ? "Perfect functionality. All interaction tests passed." : "Incorrect implementation. Interaction check failed."
        })),
        ...(codeBreakdown || []).map(b => ({
          item: b.item,
          awarded: b.awarded,
          max: b.max,
          reason: b.awarded === b.max ? "Correct source code constructs and API usage." : "Missing required JavaScript functions, setInterval, or Date api."
        })),
        ...visualBreakdown.filter(b => b.max > 0).map(b => ({
          item: b.item,
          awarded: b.awarded,
          max: b.max,
          reason: b.reason || "Visual layout style differences."
        }))
      ];

      let summaryText = "";
      if (score.total === score.maxTotal) {
        summaryText = "Excellent work! Your submission meets all requirements. The DOM layout, behavior functions, and code quality checks are 100% correct.";
      } else if (score.total === 0) {
        summaryText = "None of the rubric criteria passed. Your page is either completely blank, has wrong DOM element tags/IDs, or did not implement the required functionality.";
      } else {
        summaryText = `Your submission passed partially with a score of ${score.total}/${score.maxTotal}. Please review the strengths and issues below for concrete areas of improvement.`;
      }

      const visionFeedbackText = typeof visionFeedback === 'object' ? (visionFeedback.feedback || "") : (typeof visionFeedback === 'string' ? visionFeedback : "");
      if (visionFeedbackText.trim()) {
        summaryText += " Visual Evaluation Feedback: " + visionFeedbackText;
      }

      const aiFeedback = await generateVisualAIFeedback({
        studentName: name,
        rubric,
        score,
        domBreakdown,
        behaviorBreakdown,
        codeBreakdown,
        visualBreakdown,
        unifiedBreakdown,
        sourceText
      });

      let finalSummary = (aiFeedback?.summary || summaryText).replace(/\b(Candidate|Student)\b/g, name);
      const finalStrengths = (aiFeedback?.strengths && aiFeedback.strengths.length > 0) ? aiFeedback.strengths : strengths;
      const finalIssues = (aiFeedback?.issues && aiFeedback.issues.length > 0) ? aiFeedback.issues : issues;

      // Deterministic, calibrated reconciliation of unifiedBreakdown with AI code inspection
      const tierMultipliers = {
        perfect: 1.0,
        minor_gap: 0.85,
        major_gap: 0.60,
        broken: 0.0,
        upward_reconciled: 1.0
      };

      const recList = aiFeedback?.reconciliation || aiFeedback?.breakdown || [];
      const finalBreakdown = unifiedBreakdown.map((autoItem, idx) => {
        const rec = recList.find(r =>
          (r.criterionIndex !== undefined && Number(r.criterionIndex) === idx + 1) ||
          r.item === autoItem.item ||
          autoItem.item.toLowerCase().includes(String(r.item || "").toLowerCase()) ||
          String(r.item || "").toLowerCase().includes(autoItem.item.toLowerCase())
        );

        if (rec) {
          let status = String(rec.status || "").toLowerCase().trim();
          if (!status && typeof rec.awarded === 'number') {
            const ratio = rec.awarded / (autoItem.max || 1);
            if (ratio >= 0.95) status = "perfect";
            else if (ratio >= 0.75) status = "minor_gap";
            else if (ratio >= 0.40) status = "major_gap";
            else status = "broken";
          }

          // Respect the AI's tier judgment. If the AI identified the feature is present
          // with a minor_gap (0.85) or major_gap (0.60), award those tier points.
          // Only if status is explicitly "broken" is it 0.
          const multiplier = tierMultipliers[status] !== undefined
            ? tierMultipliers[status]
            : (autoItem.awarded / (autoItem.max || 1));

          const awarded = Math.max(0, Math.min(autoItem.max, Math.round(autoItem.max * multiplier)));
          const reason = rec.reason || (awarded === autoItem.max ? "All automated checks and code quality checks passed." : "Identified code defects or gaps in implementation.");

          return {
            item: autoItem.item,
            awarded,
            max: autoItem.max,
            reason
          };
        }

        return autoItem;
      });

      // Recalculate total score strictly from reconciled breakdown
      const reconciledTotal = finalBreakdown.reduce((sum, b) => sum + (Number(b.awarded) || 0), 0);
      const maxPossible = finalBreakdown.reduce((sum, b) => sum + (Number(b.max) || 0), 0);
      const reconciledNormalized = maxPossible > 0 ? Math.round((reconciledTotal / maxPossible) * 100) : 0;

      score.total = reconciledTotal;
      score.normalized = reconciledNormalized;

      results.push({
        name,
        studentId,
        score: score.total, // backwards-compatible field
        ...score, // domScore, behaviorScore, visualScore, codeScore, total, maxTotal, normalized, pendingManualPoints
        manualReviewItems: needsManual,
        manualReviewDetail: manualReviewDetail(rubric),
        domBreakdown,
        behaviorBreakdown,
        codeBreakdown,
        visualBreakdown,
        feedback: {
          summary: finalSummary,
          strengths: finalStrengths,
          issues: finalIssues,
          breakdown: finalBreakdown
        },
        manualCorrection: needsManual.length > 0
      });
    } catch (err) {
      EVALUATION_CACHE.delete(evalCacheKey);
      if (typeof resolveJob === 'function') resolveJob(null);
      results.push({
        name,
        score: 0,
        error: err.message,
        manualCorrection: true
      });
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    // Unconditional resource release (V-05/V-06/V-25)
    if (context) await context.close().catch(() => {});
    if (browser) browserPool.return(browser);
    if (server) server.close();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  if (results.length > 0 && results[0].score !== undefined && !results[0].error && !results[0].blankPage) {
    if (typeof resolveJob === 'function') resolveJob(results[0]);
  } else {
    EVALUATION_CACHE.delete(evalCacheKey);
    if (typeof resolveJob === 'function') resolveJob(null);
  }

  return results;
}
