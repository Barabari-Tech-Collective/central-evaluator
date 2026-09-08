/**
 * Unit test for rubric parsing/validation in scoringService.js.
 *
 * Tests:
 *   - Object with criteria array
 *   - JSON string serialization
 *   - Plain text bulleted/numbered criteria
 *   - Empty / malformed string fallback
 */
import { parseRubric } from "../evaluators/visual/scoringService.js";

let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
}

console.log("--- Rubric Parser Unit Tests ---\n");

// 1. Direct object format
{
  const input = { criteria: [{ name: "Layout", weight: 20, description: "Test" }] };
  const res = parseRubric(input);
  ok("Direct object with criteria parses correctly", Array.isArray(res.criteria) && res.criteria.length === 1 && res.criteria[0].weight === 20);
}

// 2. Direct array format
{
  const input = [{ name: "Structure", weight: 25 }];
  const res = parseRubric(input);
  ok("Direct array parses into criteria wrapper", Array.isArray(res.criteria) && res.criteria.length === 1 && res.criteria[0].name === "Structure");
}

// 3. JSON string format
{
  const input = JSON.stringify({ criteria: [{ name: "Time Display", weight: 20 }] });
  const res = parseRubric(input);
  ok("JSON string parses correctly", Array.isArray(res.criteria) && res.criteria[0].name === "Time Display");
}

// 4. Plain text format
{
  const input = "1. HTML & CSS Layout (20 pts)\n2. Current Time Display [20 marks]\n3. JavaScript Logic: 60 pts";
  const res = parseRubric(input);
  ok("Plain text multi-line rubric parses weights and names", Array.isArray(res.criteria) && res.criteria.length === 3 && res.criteria[0].weight === 20 && res.criteria[2].weight === 60);
}

// 5. Fallback for unparseable input
{
  const input = "   ";
  const res = parseRubric(input);
  ok("Empty string falls back to default 3 criteria", Array.isArray(res.criteria) && res.criteria.length === 3);
}

console.log("");
console.log(failures === 0 ? "All Rubric Parser assertions PASS." : `${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
