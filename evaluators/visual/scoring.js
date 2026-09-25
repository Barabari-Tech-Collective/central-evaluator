// Pure scoring helpers for the visual evaluator (V-07, V-21, V-30, and the
// follow-up fixes below). No I/O, no browser — unit-testable in isolation
// (see scripts/test-scoring-logic.mjs).

/** Sum of all rubric weights = the maximum attainable score. */
export function computeMaxScore(rubric) {
  return rubric.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
}

/**
 * A self-reported model score (e.g. GPT-4o's visualScore) is only as
 * trustworthy as the model's obedience to the "stay within max" instruction
 * in the prompt — nothing enforced that server-side, which is how batches
 * ended up with totals like 115/100. Clamp any externally-reported score into
 * its valid range before it's ever added into a total.
 */
export function clampScore(value, max) {
  const n = Number(value) || 0;
  const ceiling = Math.max(Number(max) || 0, 0);
  return Math.min(Math.max(n, 0), ceiling);
}

/**
 * Proportional DOM score.
 * V-21: a DOM item with no checks can NOT be auto-graded → it earns 0 and is
 * surfaced via manualReviewItems(); it is never awarded full weight for free.
 */
export function computeDomScore(rubric, domResults) {
  let score = 0;
  for (const item of rubric) {
    if (item.type !== "dom") continue;
    if (!item.checks || item.checks.length === 0) continue; // V-21: no free credit
    let passed = 0;
    for (const check of item.checks) {
      const key = `${item.description} :: ${check.selector}`;
      if (domResults[key]) passed++;
    }
    score += (passed / item.checks.length) * (Number(item.weight) || 0);
  }
  return score;
}

/** All-or-nothing behavior score. */
export function computeBehaviorScore(rubric, behaviorResults) {
  let score = 0;
  for (const item of rubric) {
    if (item.type !== "behavior") continue;
    if (!item.checks?.length) continue;
    const passed = item.checks.every(
      check => behaviorResults[`${item.description} :: ${check.selector}`]
    );
    if (passed) score += Number(item.weight) || 0;
  }
  return score;
}

/**
 * Items that cannot be auto-graded and earn 0 automatically:
 *   - a DOM item with no checks (V-21)
 *   - a "manual" item — the rubric parser's own judgment that this criterion
 *     needs a human (source-code review, in-page state change without
 *     navigation, or a value that must be observed changing over time; see
 *     rubricService.js's classification rules)
 * Kept as a plain string[] for backward compatibility with existing callers
 * (e.g. the frontend does manualReviewItems.join(", ")). Use
 * manualReviewDetail() for the weight/reason breakdown.
 */
export function manualReviewItems(rubric) {
  return manualReviewDetail(rubric).map(item => item.description);
}

/** Same set as manualReviewItems(), with weight + reason for display. */
export function manualReviewDetail(rubric) {
  return rubric
    .filter(
      item =>
        item.type === "manual" ||
        (item.type === "dom" && (!item.checks || item.checks.length === 0))
    )
    .map(item => ({
      description: item.description,
      weight: Number(item.weight) || 0,
      reason:
        item.type === "manual"
          ? "This criterion needs a human — it requires reading source code, observing a value change over time, or an in-page interaction this tool can't verify."
          : "No auto-checkable selector was generated for this criterion."
    }));
}

/** Total points sitting in items that were never auto-graded (for display). */
export function pendingManualPoints(rubric) {
  return manualReviewDetail(rubric).reduce((sum, item) => sum + item.weight, 0);
}

/** Per-item pass/fail breakdown for DOM checks (mirrors the vision breakdown shape). */
export function buildDomBreakdown(rubric, domResults) {
  return rubric
    .filter(item => item.type === "dom" && item.checks && item.checks.length > 0)
    .map(item => {
      const checks = item.checks.map(check => ({
        selector: check.selector,
        condition: check.condition || "exists",
        passed: !!domResults[`${item.description} :: ${check.selector}`]
      }));
      const passedCount = checks.filter(c => c.passed).length;
      const max = Number(item.weight) || 0;
      const awarded = checks.length ? (passedCount / checks.length) * max : 0;
      return {
        item: item.description,
        awarded: Math.round(awarded * 100) / 100,
        max,
        checks
      };
    });
}

/** Per-item pass/fail breakdown for behavior checks. */
export function buildBehaviorBreakdown(rubric, behaviorResults) {
  return rubric
    .filter(item => item.type === "behavior" && item.checks && item.checks.length > 0)
    .map(item => {
      const checks = item.checks.map(check => ({
        selector: check.selector,
        action: check.action,
        mode: check.mode || "navigate",
        targetSelector: check.targetSelector,
        passed: !!behaviorResults[`${item.description} :: ${check.selector}`]
      }));
      const max = Number(item.weight) || 0;
      const allPassed = checks.every(c => c.passed);
      return {
        item: item.description,
        awarded: allPassed ? max : 0,
        max,
        checks
      };
    });
}

/**
 * Single source of truth for the final score (V-07): DOM + behavior + code +
 * the model's VISUAL-items subtotal — each counted exactly once. Also returns
 * the normalized 0–100 view (V-30) so scores are comparable across rubrics.
 */
export function assembleScore({ rubric, domScore, behaviorScore, visualScore, codeScore = 0 }) {
  const total = domScore + behaviorScore + visualScore + codeScore;
  const maxTotal = computeMaxScore(rubric);
  const normalized = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
  return {
    domScore,
    behaviorScore,
    visualScore,
    codeScore,
    total,
    maxTotal,
    normalized: Math.round(normalized * 100) / 100,
    pendingManualPoints: pendingManualPoints(rubric)
  };
}
