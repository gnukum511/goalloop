/**
 * goalloop — cost-tiered goal-loop orchestrator for the Claude Agent SDK.
 *
 * Topology (inverted for cost):
 *   Fable 5    → plan once, review once        (frontier $, minimal tokens)
 *   Sonnet 5   → runs the loop + default work  (cheap, high token volume)
 *   Opus 4.8   → escalation after 2 failures   (pay only for proven-hard tasks)
 *   Haiku 4.5  → independent verifier          (read-only, can't paper over failures)
 *
 * Enhancements over v1:
 *   - Plan/loop split: Fable 5 never sits in the iteration loop.
 *   - Two-strike escalation ladder per task.
 *   - Independent Haiku verifier gates every "done" claim.
 *   - State checkpoints to .goalloop/state.json (resume killed runs).
 *   - Persistent memory/ digest read at plan time, lessons appended at review.
 *   - Cache-shaped prompts: stable prefix first, volatile task last.
 *
 * pxpipe (optional, ~60-70% input-token cut on Fable calls):
 *   npx pxpipe-proxy &
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:47821 npx tsx src/orchestrator.ts "<goal>"
 *   Zero code changes — the SDK's underlying CLI respects ANTHROPIC_BASE_URL.
 *   pxpipe images Fable 5 requests only by default; Sonnet/Opus/Haiku pass
 *   through byte-identical, so goal-state JSON and contracts are never lossy.
 *
 * Run:
 *   pnpm install
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx src/orchestrator.ts "Build feature X: <goal>"
 *   npx tsx src/orchestrator.ts --resume            # continue a killed run
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------- config ----------

const MODELS = {
  planner: "claude-fable-5",
  loop: "claude-sonnet-5",
  worker: "claude-sonnet-5",
  escalation: "claude-opus-4-8",
  verifier: "claude-haiku-4-5",
} as const;

const MAX_ITERATIONS = 6;
const MAX_TURNS_PER_ITERATION = 60;
const BUDGET_USD_TOTAL = Number(process.env.GOALLOOP_BUDGET_USD ?? 20);
const ESCALATE_AFTER_FAILURES = 2;

const STATE_DIR = ".goalloop";
const STATE_FILE = join(STATE_DIR, "state.json");
const MEMORY_DIR = "memory";

// ---------- state ----------

interface Task {
  id: string;
  description: string;
  completion_criteria: string;
  verify_command: string;
  assigned_to: "worker" | "escalation";
  status: "pending" | "in_progress" | "done" | "failed" | "blocked";
  failures: number;
  depends_on: string[];
}

interface RunState {
  goal: string;
  tasks: Task[];
  iteration: number;
  total_cost_usd: number;
  blockers: string[];
  lessons: string[];
  phase: "planning" | "executing" | "review" | "complete" | "blocked";
}

function saveState(state: RunState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): RunState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as RunState;
}

// ---------- memory ----------

function readMemoryDigest(): string {
  if (!existsSync(MEMORY_DIR)) return "(no prior memory)";
  const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) return "(no prior memory)";
  return files
    .map((f) => `--- ${f} ---\n${readFileSync(join(MEMORY_DIR, f), "utf-8")}`)
    .join("\n\n")
    .slice(0, 20_000); // cap the digest — memory must not become the new bloat
}

function appendLessons(lessons: string[]) {
  if (lessons.length === 0) return;
  mkdirSync(MEMORY_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  appendFileSync(
    join(MEMORY_DIR, "lessons.md"),
    `\n## ${stamp}\n${lessons.map((l) => `- ${l}`).join("\n")}\n`
  );
}

// ---------- shared JSON extraction ----------

function extractJson<T>(text: string, fence: string): T | null {
  const m = text.match(new RegExp("```" + fence + "\\s*([\\s\\S]*?)```"));
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}

async function runQuery(
  prompt: string,
  options: Record<string, unknown>
): Promise<{ text: string; cost: number }> {
  let text = "";
  let cost = 0;
  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") text = block.text;
      }
    }
    if (message.type === "result") {
      cost = message.total_cost_usd ?? 0;
      if (message.subtype === "success") text = message.result;
    }
  }
  return { text, cost };
}

// ---------- phase 1: Fable 5 plans once ----------

async function plan(goal: string): Promise<{ tasks: Task[]; cost: number }> {
  console.log("── Phase 1: planning (Fable 5, one call) ──");
  const memory = readMemoryDigest();

  const { text, cost } = await runQuery(
    // Cache-shaped: stable instructions first, volatile goal last.
    `LESSONS FROM PRIOR RUNS:\n${memory}\n\nGOAL:\n${goal}`,
    {
      model: MODELS.planner,
      systemPrompt: `You are a planning specialist. You produce a task graph, nothing else.
Decompose the goal into 3-10 tasks. For each task define:
- a short id (kebab-case), description, explicit completion_criteria
- verify_command: a single shell command that exits 0 iff the criteria are met
- depends_on: ids of prerequisite tasks (contract/schema tasks come first)
Apply lessons from prior runs. Do not write any code.
Emit ONLY a JSON block fenced with \`\`\`task-graph ... \`\`\` shaped as:
{"tasks":[{"id":string,"description":string,"completion_criteria":string,"verify_command":string,"depends_on":string[]}]}`,
      allowedTools: ["Read", "Glob", "Grep"],
      maxTurns: 15,
    }
  );

  const parsed = extractJson<{ tasks: Omit<Task, "assigned_to" | "status" | "failures">[] }>(
    text,
    "task-graph"
  );
  if (!parsed) throw new Error(`Planner emitted no task-graph block:\n${text}`);

  const tasks: Task[] = parsed.tasks.map((t) => ({
    ...t,
    assigned_to: "worker",
    status: "pending",
    failures: 0,
    depends_on: t.depends_on ?? [],
  }));
  console.log(`Planned ${tasks.length} tasks. Cost: $${cost.toFixed(2)}`);
  return { tasks, cost };
}

// ---------- phase 2: Sonnet 5 runs the loop ----------

const agents = {
  worker: {
    description: "Default implementation lane. Use for every dispatched task unless told to escalate.",
    prompt: `You are a senior engineer executing a precisely-specified task.
Deliver complete files, never fragments. Run the given verify command yourself
before reporting. Report: files changed, command output, done|failed|blocked.
If the spec is ambiguous, report blocked with the specific question.`,
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    model: MODELS.worker,
  },
  escalation: {
    description: "Hard-task lane. Use ONLY when the dispatch prompt says the task failed twice on the worker lane.",
    prompt: `You are a principal engineer. This task failed twice on a cheaper lane —
the failure context is in your dispatch prompt. Diagnose the root cause first,
state your assumptions, then implement. Deliver complete files and run the
verify command before reporting.`,
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch"],
    model: MODELS.escalation,
  },
  verifier: {
    description: "Independent verification. MUST BE USED to confirm any task reported as done before it is marked complete.",
    prompt: `You are an independent verifier. You cannot edit anything.
Run the verify command you are given, read the relevant artifacts, and check
them against the completion criteria. Report exactly:
PASS <evidence: command exit code + one-line proof>
or FAIL <what specifically does not meet the criteria>.
Never take the worker's word for anything.`,
    tools: ["Read", "Glob", "Grep", "Bash"],
    model: MODELS.verifier,
  },
} as const;

interface LoopReport {
  task_updates: { id: string; status: Task["status"]; note: string }[];
  blockers: string[];
  lessons: string[];
}

async function runLoop(state: RunState): Promise<void> {
  while (state.iteration < MAX_ITERATIONS) {
    state.iteration++;
    console.log(`\n── Iteration ${state.iteration}/${MAX_ITERATIONS} (Sonnet 5 loop) ──`);

    const open = state.tasks.filter((t) => t.status !== "done");
    if (open.length === 0) {
      state.phase = "review";
      return;
    }

    const { text, cost } = await runQuery(
      // Stable prefix (rules live in systemPrompt) + volatile state last.
      `GOAL:\n${state.goal}\n\nTASK GRAPH STATE:\n${JSON.stringify(state.tasks, null, 2)}`,
      {
        model: MODELS.loop,
        systemPrompt: `You are the loop orchestrator. You do NOT write code.
Each turn:
1. Dispatch every pending task whose depends_on are all done — in parallel,
   via the Agent tool, to the lane named in its assigned_to field.
2. Every dispatch prompt must be self-contained: description, completion
   criteria, verify command, and (for escalations) prior failure notes.
3. When a lane reports done, dispatch the verifier agent with the verify
   command and criteria. Only a verifier PASS makes a task done.
4. A verifier FAIL increments that task's failure count in your report.
Emit at END of turn ONLY a JSON block fenced \`\`\`loop-report ... \`\`\`:
{"task_updates":[{"id":string,"status":"pending|in_progress|done|failed|blocked","note":string}],
 "blockers":string[],"lessons":string[]}
lessons = anything a future run should know (gotchas, wrong assumptions).`,
        agents: { ...agents },
        allowedTools: ["Agent", "Read", "Glob", "Grep", "TodoWrite"],
        permissionMode: "acceptEdits",
        maxTurns: MAX_TURNS_PER_ITERATION,
      }
    );

    state.total_cost_usd += cost;
    console.log(`Iteration cost: $${cost.toFixed(2)} | Total: $${state.total_cost_usd.toFixed(2)}`);

    const report = extractJson<LoopReport>(text, "loop-report");
    if (report) {
      for (const u of report.task_updates) {
        const task = state.tasks.find((t) => t.id === u.id);
        if (!task) continue;
        if (u.status === "failed") {
          task.failures++;
          task.status = "pending";
          if (task.failures >= ESCALATE_AFTER_FAILURES && task.assigned_to === "worker") {
            task.assigned_to = "escalation";
            console.log(`↗ Escalating ${task.id} to Opus 4.8 after ${task.failures} failures`);
          }
        } else {
          task.status = u.status;
        }
      }
      state.blockers = report.blockers;
      state.lessons.push(...report.lessons);
    } else {
      console.warn("Loop emitted no loop-report block; state unchanged this iteration.");
    }

    saveState(state);

    if (state.blockers.length > 0) {
      state.phase = "blocked";
      saveState(state);
      return;
    }
    if (state.total_cost_usd >= BUDGET_USD_TOTAL) {
      console.log(`💸 Budget cap $${BUDGET_USD_TOTAL} hit. State checkpointed — resume with --resume.`);
      process.exit(0);
    }
  }
  state.phase = state.tasks.every((t) => t.status === "done") ? "review" : "blocked";
}

// ---------- phase 3: Fable 5 reviews once ----------

async function review(state: RunState): Promise<void> {
  console.log("\n── Phase 3: review (Fable 5, one call) ──");
  const { text, cost } = await runQuery(
    `GOAL:\n${state.goal}\n\nCOMPLETED TASK GRAPH:\n${JSON.stringify(state.tasks, null, 2)}\n\nLESSONS COLLECTED:\n${state.lessons.join("\n")}`,
    {
      model: MODELS.planner,
      systemPrompt: `You are a principal reviewer. Audit the completed work against the goal:
architecture coherence, seams between tasks, anything the verifiers' narrow
checks would miss. Read the actual artifacts. Then emit a short review and a
\`\`\`lessons ... \`\`\` JSON block: {"lessons":string[]} — distilled, durable
lessons for future runs (not run-specific noise).`,
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
      maxTurns: 20,
    }
  );
  state.total_cost_usd += cost;
  const parsed = extractJson<{ lessons: string[] }>(text, "lessons");
  appendLessons(parsed?.lessons ?? state.lessons);
  console.log(text.split("```")[0].trim());
  console.log(`Review cost: $${cost.toFixed(2)} | Run total: $${state.total_cost_usd.toFixed(2)}`);
}

// ---------- entry ----------

async function main() {
  const args = process.argv.slice(2);
  let state: RunState;

  if (args[0] === "--resume") {
    const loaded = loadState();
    if (!loaded) {
      console.error("No checkpoint at .goalloop/state.json");
      process.exit(1);
    }
    state = loaded;
    console.log(`Resuming: iteration ${state.iteration}, $${state.total_cost_usd.toFixed(2)} spent, phase=${state.phase}`);
  } else {
    const goal = args.join(" ").trim();
    if (!goal) {
      console.error('Usage: npx tsx src/orchestrator.ts "<goal>" | --resume');
      process.exit(1);
    }
    const { tasks, cost } = await plan(goal);
    state = {
      goal,
      tasks,
      iteration: 0,
      total_cost_usd: cost,
      blockers: [],
      lessons: [],
      phase: "executing",
    };
    saveState(state);
  }

  if (state.phase === "executing") await runLoop(state);

  if (state.phase === "review") {
    await review(state);
    state.phase = "complete";
    saveState(state);
    console.log("\n✅ Goal complete.");
  } else if (state.phase === "blocked") {
    saveState(state);
    console.log("\n🛑 Blocked — human input needed:");
    state.blockers.forEach((b) => console.log(`  - ${b}`));
    console.log("Resolve, then: npx tsx src/orchestrator.ts --resume");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
