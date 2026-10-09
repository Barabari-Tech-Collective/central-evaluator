# React Evaluator Production Review

## Scope

This review covers the React evaluation path in `central-evaluator` and its GitHub Actions execution dependency in `async-grader`.

The intended production flow is:

```text
POST /evaluate
  -> BullMQ react-evaluation job
  -> GitHub repository_dispatch
  -> async-grader workflow
  -> webhook callback
  -> Redis pub/sub
  -> deterministic test scoring or code analysis
  -> job result
```

## What async-grader does

`async-grader` is the execution runner, not the primary evaluator service. It contains GitHub Actions workflows that clone student repositories, install dependencies, build projects, run Vitest/Jest/Playwright/Python/JavaScript checks, and send results back to `central-evaluator` through `/api/webhook/github`.

`central-evaluator` owns request validation, queueing, job lifecycle, scoring, AI feedback, and result retrieval. The two repositories therefore need a versioned and explicit contract for repository roots, commit SHAs, test results, failure states, and callback attempts.

## Findings requiring resolution

### P0 — Untrusted student code executes beside grader credentials

The React workflow checks out the grader repository and then runs `npm install` in the student repository. Package lifecycle scripts can execute arbitrary code. The execution job must not expose GitHub checkout credentials, webhook secrets, API keys, or other evaluator credentials to student code.

Required direction:

- run student installation and tests inside an isolated sandbox;
- use a read-only, least-privilege token or no repository token at all;
- disable package lifecycle scripts unless explicitly required;
- restrict network access and filesystem access;
- use a one-time, attempt-scoped callback token outside the student process.

### P1 — IDE submissions are accepted but React evaluation still requires a repository URL

The React worker has an `ideFiles` path, but `evaluateReactProject()` still calls `cloneRepo(payload.repoUrl)`. IDE submissions should be materialized into a temporary project directory and passed to the same scorer without cloning.

### P1 — React grading is hardcoded to the Todo assignment

The workflow always injects `todo.spec.jsx`, and the AI prompt requires Todo-specific component names, state variables, and handlers. A general React evaluator must accept an assignment-specific test bundle and rubric rather than grading every project as a Todo application.

### P1 — Test fallback can overwrite the real failure report

The workflow runs the `src/todo.spec.jsx` command and then falls back to `todo.spec.jsx` with `||`. A test assertion failure can cause the second command to run and overwrite the original report. The workflow should detect the existing test path first and execute exactly one command.

### P1 — Accessibility fallback in the injected test is ineffective

Patterns such as `getByRole('textbox') || getByPlaceholderText(...)` do not fall back because Testing Library throws when `getByRole()` cannot find an element. Use `queryByRole()` or an explicit helper that tries multiple selectors.

### P1 — Repository root and commit are not stable

The GitHub runner clones the repository once, while `central-evaluator` clones it again for source analysis. A moving branch can produce different code in the execution and scoring phases. Normalize GitHub tree/blob URLs, resolve the project root, pin the commit SHA, and pass that immutable reference through every phase.

### P1 — Source analysis silently omits important files

The React analyzer recursively scans selected extensions but caps analysis at 15 files and 6,000 characters per file. It should produce a source manifest, prioritize entrypoints and imported modules, and report omitted files explicitly instead of presenting partial analysis as complete.

### P1 — Infrastructure failures are indistinguishable from student failures

Build, installation, missing test files, runner crashes, webhook timeouts, and test assertion failures currently converge toward a completed job or an AI fallback. The result contract should distinguish `passed`, `test_failed`, `build_failed`, `unsupported_project`, and `infrastructure_failed`.

## Acceptance criteria for a production-ready React evaluator

- Standard React project with `src/` is evaluated correctly.
- Monorepo project can specify an explicit project root.
- GitHub `/tree/...` and `/blob/...` links resolve to the intended root.
- IDE file submissions work without a repository URL.
- A moving branch cannot change the code between execution and scoring.
- Missing build scripts are reported as unsupported, not successful.
- Failed tests are preserved exactly once in the result artifact.
- Different accessible labels and valid component layouts do not create false negatives.
- Student lifecycle scripts cannot access evaluator credentials.
- Concurrent jobs do not overwrite logs or source artifacts.
- Every result contains the evaluated commit SHA, runner attempt, phase statuses, test counts, and a clear failure reason.

## Recommended delivery order

1. Isolate student execution and remove credentials from the runner process.
2. Fix IDE handling and immutable repository-root/commit propagation.
3. Replace Todo-specific logic with assignment-specific test bundles.
4. Make test result and infrastructure statuses explicit.
5. Improve source indexing and add the acceptance-test matrix above.
