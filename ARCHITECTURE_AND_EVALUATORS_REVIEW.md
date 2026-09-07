# Central Evaluators Architecture, Workflow & Code Review Document

---

## 1. Executive Summary & Migration Overview

This document provides a comprehensive technical overview and code review guide for the **Central Evaluators** codebase (`central-evaluators`).

### Migration: E2B Sandboxes to GitHub Actions Architecture

| Aspect | Previous (E2B Sandboxes) | Current (GitHub Actions + Webhooks) |
| :--- | :--- | :--- |
| **Execution Environment** | Ephemeral VMs managed via E2B client SDK | Native GitHub Actions Runners (`async-grader` repo) |
| **Isolation & Scale** | Memory/CPU contention during batch submissions | Distributed container runners provisioned per run |
| **Resource Cost & Leaks** | Zombie sandbox sessions / idle timeout billing | Serverless execution triggered on demand |
| **Test Execution** | Direct process spawning inside sandbox | Automated Jest, Vitest, Playwright & Pytest runners |
| **Result Ingestion** | Synchronous polling / waiting on VM streams | Asynchronous Webhook (`/api/webhook/github`) + Redis Pub/Sub |

---

## 2. High-Level System Architecture

```
                           ┌──────────────────────────────────────────────┐
                           │               Client / LMS API               │
                           └──────────────────────┬───────────────────────┘
                                                  │ POST /evaluate
                                                  ▼
                           ┌──────────────────────────────────────────────┐
                           │    Central Evaluators (Express Gateway)      │
                           │  • Rate Limiting & API-Key Auth (auth.js)    │
                           │  • Payload & SSRF Validation (urlGuard.js)   │
                           └──────────────────────┬───────────────────────┘
                                                  │
                                                  ▼
                               ┌─────────────────────────────────────┐
                               │       Redis / BullMQ Queues         │
                               │ (backend, visual, js, react, etc.)  │
                               └──────────────────┬──────────────────┘
                                                  │
                        ┌─────────────────────────┴─────────────────────────┐
                        │ Worker picks up job & sets up Redis Pub/Sub Wait  │
                        └─────────────────────────┬─────────────────────────┘
                                                  │
                        ┌─────────────────────────┴─────────────────────────┐
                        │ 1. Trigger GitHub Actions Dispatch                │
                        │    (services/githubActionService.js)              │
                        │    POST /repos/:user/async-grader/dispatches      │
                        │    Payload: { repoUrl, jobId, webhookUrl, ... }   │
                        └─────────────────────────┬─────────────────────────┘
                                                  │
                                                  ▼
                        ┌───────────────────────────────────────────────────┐
                        │ 2. GitHub Actions Runner (async-grader)           │
                        │    • Clones student repository                    │
                        │    • Injects test harnesses / specs               │
                        │    • Executes tests (Jest, Vitest, Playwright)    │
                        │    • Sends POST to Webhook URL with test results  │
                        └─────────────────────────┬─────────────────────────┘
                                                  │
                                                  ▼
                        ┌───────────────────────────────────────────────────┐
                        │ 3. Webhook Controller & Redis Pub/Sub             │
                        │    (webhookController.js & webhookPubSub.js)      │
                        │    • Receives webhook at /api/webhook/github      │
                        │    • Publishes to Redis: github_webhook_<jobId>   │
                        │    • Worker receives payload and resumes job      │
                        └─────────────────────────┬─────────────────────────┘
                                                  │
                                                  ▼
                        ┌───────────────────────────────────────────────────┐
                        │ 4. Scoring Engine & AI Feedback                   │
                        │    • Primary: Deterministic Mathematical Grading  │
                        │    • Fallback: AI Code Analysis (GPT-4o-mini)     │
                        │    • Output: Unified score, breakdown, feedback   │
                        └───────────────────────────────────────────────────┘
```

---

## 3. Directory Structure & File Map

```
central-evaluators/
│
├── server.js                          # Express app entry, worker startups, health endpoints, graceful shutdown
│
├── config/
│   ├── logger.js                      # Winston logger with colorized formats and log levels
│   ├── queueManager.js                # BullMQ queue configurations (concurrency, timeouts, retries)
│   └── redis.js                       # Shared Redis client connection singleton
│
├── controller/
│   ├── evaluatorController.js         # Validates incoming POST /evaluate requests (SSRF checks, payload rules)
│   └── webhookController.js           # Handles incoming POST /api/webhook/github from GitHub Actions
│
├── router/
│   ├── evaluationRouter.js            # Routes jobs to proper BullMQ queue based on evaluator type
│   └── webhookRouter.js               # Mounts /api/webhook/github endpoint
│
├── middleware/
│   └── auth.js                        # API key authentication & sliding window rate limiter
│
├── services/
│   ├── githubActionService.js         # Dispatches repository_dispatch events with retry/backoff & 429 handling
│   └── webhookPubSub.js               # Shared Redis Pub/Sub subscriber (psubscribe) multiplexing webhook events
│
├── workers/                           # BullMQ background workers
│   ├── backendWorker.js               # Handles 'backend-evaluation' queue jobs
│   ├── fullstackWorker.js             # Handles 'fullstack-evaluation' queue jobs
│   ├── reactWorker.js                 # Handles 'react-evaluation' queue jobs
│   ├── jsWorker.js                    # Handles 'javascript-evaluation' queue jobs
│   ├── pythonWorker.js                # Handles 'python-evaluation' queue jobs
│   └── visualWorker.js                # Handles 'visual-evaluation' queue jobs
│
└── evaluators/                        # Core grading logic per domain
    ├── backend/
    │   ├── evaluatorService.js        # Orchestrates Jest grading + AI fallback for Express/Node backend
    │   ├── scoringService.js          # Mathematical calculation from Jest test results (scoring formulas)
    │   └── feedbackService.js         # Senior developer AI feedback generation via Groq/OpenAI
    │
    ├── fullstack/
    │   ├── evaluatorService.js        # Orchestrates Playwright results + Fullstack AI fallback
    │   ├── scoringService.js          # Layered scoring (frontend vs backend) from Playwright suites
    │   └── feedbackService.js         # Fullstack architectural AI feedback generation
    │
    ├── react/
    │   ├── evaluatorService.js        # Clones repo, triggers scoring, writes evaluation debug logs
    │   ├── scoringService.js          # Vitest mathematical scoring + Strict Groq/GPT-4o-mini grading
    │   ├── repoService.js             # Git clone & temporary directory lifecycle manager
    │   └── utils/                     # React AI feedback & execution timeout helpers
    │
    ├── js/
    │   └── aiFeedback.js              # JavaScript code fetcher + AI feedback prompt generator
    │
    ├── python/
    │   └── aiFeedback.js              # Python code fetcher + AI feedback prompt generator
    │
    └── visual/
        ├── evaluatorService.js        # Visual orchestrator: DOM, Playwright interactions, Vision model
        ├── scoring.js                 # Pure mathematical scoring (DOM + Behavior + Code + Clamped Vision)
        ├── domService.js              # Dynamic DOM query validation (classes, IDs, element counts)
        ├── behaviourService.js        # Dynamic interaction tester (clicks, inputs, navigations)
        ├── codeService.js             # Source code static analysis (AST / regex checks)
        ├── rubricService.js           # LLM parser translating raw rubrics into DOM/behavior selectors
        ├── browserPool.js             # Reusable Playwright Chromium browser instance pool
        ├── localServerService.js      # Ephemeral static HTTP server to serve student HTML/CSS/JS
        ├── scannerService.js          # Detects entry points (index.html, styles.css, app.js)
        └── utils/
            ├── urlGuard.js            # SSRF protection, private IP filtering, DNS rebinding guards
            └── promptBuilder.js       # Builds structured vision prompt for GPT-4o
```

---

## 4. End-to-End Execution Flow

### Step 1: Request Ingestion & Ingress Validation
1. Client sends `POST /evaluate` with `x-api-key`.
2. `middleware/auth.js` enforces authentication and IP rate limits.
3. `controller/evaluatorController.js` validates payload:
   - Verifies rubric criteria have positive numeric weights (preventing `NaN` score propagation).
   - Runs syntactic and SSRF allowlist checks on `repoUrl`.
4. `router/evaluationRouter.js` pushes the job to the domain-specific BullMQ queue (`backend`, `fullstack`, `react`, `javascript`, `python`, or `visual`).

### Step 2: GitHub Action Dispatch & Webhook Pub/Sub Pattern
```
Worker Process                             Redis                              GitHub Action
     │                                       │                                      │
     ├─ 1. Subscribes to channel ───────────►│                                      │
     │     github_webhook_<jobId>            │                                      │
     │                                       │                                      │
     ├─ 2. Dispatches repository_dispatch ───┼─────────────────────────────────────►│
     │     (with jobId & webhookUrl)         │                                      │
     │                                       │                                      │
     ├─ 3. Awaits Promise with timeout       │                                      │
     │                                       │                                      │
     │                                       │◄── 4. POST /api/webhook/github ──────┤
     │                                       │       (x-webhook-secret verified)    │
     │                                       │                                      │
     │◄── 5. Redis pmessage fires ───────────┤                                      │
     │    (Resolves waiting Promise)         │                                      │
     ▼                                       ▼                                      ▼
```
1. **Zero Race-Condition Setup**: The worker registers a listener on `services/webhookPubSub.js` **before** dispatching to GitHub Actions.
2. **Dispatch Execution**: `services/githubActionService.js` sends a `repository_dispatch` event to `async-grader` on GitHub. It features 5 retries with exponential backoff and honors `Retry-After` on HTTP 429 rate limits.
3. **Execution on GitHub**: The GitHub workflow clones the submission, installs dependencies, injects test harnesses, and runs the test runner.
4. **Webhook Callback**: When tests conclude, GitHub sends a POST payload to `POST /api/webhook/github`.
5. **Multiplexed Dispatch**: `controller/webhookController.js` verifies `x-webhook-secret` and publishes to Redis channel `github_webhook_<jobId>`.
6. **Shared Subscriber**: `services/webhookPubSub.js` uses a single Redis client with `psubscribe('github_webhook_*')` to handle high job concurrency with minimal Redis connection overhead.

---

## 5. Domain-by-Domain Evaluator Logic & Mathematical Scoring Formulas

---

### A. Backend Evaluator (`evaluators/backend/`)

#### 1. Deterministic Jest Scoring Formula
When Jest returns structured test assertions:
- Tests are grouped by rubric criteria via title prefix matching.
- For each criterion $c$:
  $$\text{multiplier}_c = \frac{\text{passed\_tests}_c}{\text{total\_tests}_c}$$
  $$\text{awarded\_score}_c = \text{round}(\text{multiplier}_c \times \text{weight}_c)$$
  $$\text{Total Score} = \sum_{c} \text{awarded\_score}_c$$

#### 2. Performance Criterion & Thresholds
For criteria containing keywords like "performance", "speed", or "efficiency":
$$\text{perf\_ratio} = \frac{\text{tests with duration} \le 500\text{ms}}{\text{total timed tests}}$$
$$\text{awarded\_points} = \text{round}(\text{weight} \times \text{perf\_ratio})$$

#### 3. AI Fallback (When Tests Fail/Missing)
Reads compressed source files (removing comments, empty lines, and indentation) and uses `gpt-4o-mini` with strict JSON mode to score criteria:
$$\text{Status} = \begin{cases} \text{"pass"} & \text{if Total Score} \ge 0.5 \times \text{Max Score} \\ \text{"fail"} & \text{otherwise} \end{cases}$$

---

### B. Fullstack Evaluator (`evaluators/fullstack/`)

#### 1. Playwright Suite Traversal & Layer Scoring
Playwright suites are recursively flattened into individual assertion records.
- **Backend Layer Criterion**:
  $$\text{score}_c = \text{weight}_c \times \frac{\text{passed\_backend\_checks}}{\text{total\_backend\_checks}}$$
- **Frontend Layer Criterion**:
  $$\text{score}_c = \text{weight}_c \times \frac{\text{passed\_frontend\_checks}}{\text{total\_frontend\_checks}}$$
- **General / Shared Criterion**:
  $$\text{avg\_ratio} = \frac{\text{backend\_pass\_ratio} + \text{frontend\_pass\_ratio}}{2}$$
  $$\text{score}_c = \text{round}(\text{weight}_c \times \text{avg\_ratio})$$

$$\text{Pass Percentage} = \text{round}\left(\frac{\sum \text{score}_c}{\sum \text{weight}_c} \times 100\right)$$
$$\text{Status} = \begin{cases} \text{"pass"} & \text{if Pass Percentage} \ge 70\% \\ \text{"fail"} & \text{otherwise} \end{cases}$$

---

### C. React Evaluator (`evaluators/react/`)

#### 1. Vitest Scoring (Primary)
$$\text{score}_c = \text{round}\left(\frac{\text{passed Vitest assertions}_c}{\text{total Vitest assertions}_c} \times \text{weight}_c\right)$$

#### 2. Strict AI Code Analysis Rules
- **Assignment Relevance Guard**: Irrelevant projects (e.g. submitting a counter for a Todo list assignment) receive 0 marks across all criteria.
- **Build Failure Cap**: If the build fails on GitHub Actions, criteria requiring runtime verification ("UI Structure & CSS Styling") are capped at max 5 marks, while pure state/function logic can still earn partial points from static code inspection.

---

### D. JavaScript & Python Evaluators (`evaluators/js/` & `evaluators/python/`)

#### 1. Test Scaling & Rubric Mapping
$$\text{Global Pass Ratio} = \frac{\text{Passed Test Cases}}{\text{Total Test Cases}}$$
$$\text{awarded\_score}_c = \text{round}(\text{weight}_c \times \text{Global Pass Ratio})$$
$$\text{Total Score} = \sum_{c} \text{awarded\_score}_c$$

#### 2. 100% Pass Bypass Optimization
If $\text{Total Score} == 100$, the evaluator bypasses external LLM calls and returns an immediate success response, reducing latency and API token usage.

---

### E. Visual & DOM Evaluator (`evaluators/visual/`)

Combines DOM inspection, Playwright user interactions, static source code regex/AST checks, and GPT-4o vision image comparison.

#### 1. Scoring Components
- **DOM Score (Proportional)**:
  $$\text{DOM Score} = \sum_{i \in \text{DOM}} \left( \frac{\text{passed checks}_i}{\text{total checks}_i} \times \text{weight}_i \right)$$
  *(Criteria with no auto-checkable selectors earn 0 points and are surfaced for manual review).*

- **Behavior Score (All-or-Nothing)**:
  $$\text{Behavior Score} = \sum_{j \in \text{Behavior}} \begin{cases} \text{weight}_j & \text{if all checks in } j \text{ pass} \\ 0 & \text{otherwise} \end{cases}$$

- **Static Code Score**:
  $$\text{Code Score} = \sum_{m \in \text{Code}} \begin{cases} \text{weight}_m & \text{if AST/regex passes} \\ 0 & \text{otherwise} \end{cases}$$

- **Clamped Vision Score**:
  $$\text{Clamped Visual Score} = \min\left(\max(\text{model\_visual\_score}, 0), \sum \text{weight}_{\text{visual}}\right)$$

#### 2. Score Assembly & Normalization
$$\text{Total Score} = \text{DOM Score} + \text{Behavior Score} + \text{Code Score} + \text{Clamped Visual Score}$$
$$\text{Normalized Score (0–100)} = \text{round}\left(\frac{\text{Total Score}}{\sum \text{all weights}} \times 100\right)$$

---

## 6. Standardized Feedback Schema

All evaluators produce a unified, structured feedback format:

```json
{
  "score": 85,
  "maxScore": 100,
  "status": "pass",
  "feedback": {
    "summary": "High-level summary of student's performance.",
    "strengths": [
      "[Routing & Controllers] Passed all unit tests (earned 25/25 marks)"
    ],
    "issues": [
      "[Authentication Middleware] Failed 2/5 tests. Errors: TokenExpiredError not handled (earned 15/25 marks)"
    ],
    "breakdown": [
      {
        "item": "Routing & Controllers",
        "awarded": 25,
        "max": 25,
        "reason": "Passed all 6 unit tests."
      },
      {
        "item": "Authentication Middleware",
        "awarded": 15,
        "max": 25,
        "reason": "Failed 2/5 tests. Errors: TokenExpiredError not handled"
      }
    ]
  },
  "warnings": [],
  "execution_logs": "..."
}
```

---

## 7. Security, Reliability & Resilience Matrix

| Feature | Location | Implementation |
| :--- | :--- | :--- |
| **SSRF Defense** | `evaluators/visual/utils/urlGuard.js` | DNS resolution & blocking of private/loopback IPs and cloud metadata addresses. |
| **Score Clamping** | `evaluators/visual/scoring.js` | Clamps external LLM scores between 0 and criterion max weight. |
| **Shared Redis Subscriber** | `services/webhookPubSub.js` | Single `psubscribe('github_webhook_*')` connection prevents connection leaks under load. |
| **GitHub Dispatch Retries** | `services/githubActionService.js` | 5 retries with exponential backoff and HTTP 429 `Retry-After` compliance. |
| **Leak-Proof Resource Cleanup** | `workers/visualWorker.js`, `server.js` | Guaranteed `finally` blocks releasing browser pools, temporary directories, and static servers. |
| **Graceful Shutdown** | `server.js` | Drains BullMQ workers on `SIGTERM`/`SIGINT` with a 30s fail-safe exit timer. |
