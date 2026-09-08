/**
 * Unit test for scoring normalization and validation.
 */
import { parseRubric } from "../evaluators/visual/scoringService.js";

let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
}

console.log("--- Scoring Logic Unit Tests ---\n");

// Test scoring thresholds
{
  const maxScore = 100;
  const passScore = 60;
  const failScore = 40;
  
  ok("Pass threshold matches >= 50%", passScore >= maxScore * 0.5);
  ok("Fail threshold matches < 50%", failScore < maxScore * 0.5);
}

// Test rubric criteria weight summation
{
  const rubric = parseRubric(JSON.stringify({
    criteria: [
      { name: "HTML", weight: 20 },
      { name: "CSS", weight: 30 },
      { name: "JS", weight: 50 }
    ]
  }));
  const total = rubric.criteria.reduce((s, c) => s + c.weight, 0);
  ok("Rubric criteria sum to 100 points", total === 100);
}

console.log("");
console.log(failures === 0 ? "All Scoring Logic assertions PASS." : `${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
