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
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

      const studentImage = await fs.readFile(screenshotPath);
      const prompt = buildVisionPrompt(rubric, domResults, behaviorResults);

      // Deterministic vision call returning strict JSON (V-10/V-18).
      const aiRes = await getOpenAI().chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
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
        ]
      });

      const raw = aiRes.choices?.[0]?.message?.content ?? "{}";
      const maxVisual = rubric
        .filter(r => r.type === "visual")
        .reduce((s, r) => s + (Number(r.weight) || 0), 0);
      let visualScore = 0;
      let visionFeedback = raw;
      let visualBreakdown = [];
      try {
        const parsed = JSON.parse(raw);
        // The model is only asked to "stay within max" — nothing enforced that
        // server-side, and an obedience slip here is exactly what let totals
        // exceed 100 (e.g. 115/125) even though maxTotal was correctly 100.
        const rawVisual = Number(parsed.visualScore) || 0;
        visualScore = clampScore(rawVisual, maxVisual);
        if (rawVisual !== visualScore) {
          logger.warn(
            `Vision model returned an out-of-range visualScore (${rawVisual}, max ${maxVisual}) — clamped`,
            { jobId, studentId }
          );
        }
        visionFeedback = parsed;
        visualBreakdown = Array.isArray(parsed.breakdown) ? parsed.breakdown : [];
      } catch {
        // keep raw text as feedback; visualScore stays 0
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
          summary: summaryText,
          strengths,
          issues,
          breakdown: unifiedBreakdown
        },
        manualCorrection: needsManual.length > 0
      });
    } catch (err) {
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

  return results;
}
