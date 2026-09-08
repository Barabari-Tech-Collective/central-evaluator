/**
 * Unit test for code compression and sanitization utilities.
 */
let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
}

console.log("--- Code Sanitization Unit Tests ---\n");

function compressCode(code) {
  let compressed = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  compressed = compressed.replace(/^\s*[\r\n]/gm, "");
  compressed = compressed.replace(/[ \t]{2,}/g, " ");
  return compressed;
}

// 1. Comment stripping
{
  const raw = "const x = 1; // single line\n/* block comment */\nconst y = 2;";
  const cleaned = compressCode(raw);
  ok("Comments are stripped", !cleaned.includes("single line") && !cleaned.includes("block comment"));
}

// 2. Extra whitespace reduction
{
  const raw = "function    test(   a,   b   )  {\n\n\n  return a + b;\n}";
  const cleaned = compressCode(raw);
  ok("Consecutive whitespace reduced", !cleaned.includes("    ") && cleaned.includes("function test( a, b )"));
}

console.log("");
console.log(failures === 0 ? "All Code Sanitization assertions PASS." : `${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
