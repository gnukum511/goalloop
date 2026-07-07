# Running goalloop through pxpipe

[pxpipe](https://github.com/teamchong/pxpipe) is a local proxy that rewrites
bulky request context into dense PNG pages before requests leave your
machine. Image token cost is fixed by pixel dimensions, so token-dense text
(code, JSON, tool output) compresses ~3x.

## Setup

```bash
npx pxpipe-proxy &        # 127.0.0.1:47821, dashboard at http://127.0.0.1:47821/
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 npx tsx src/orchestrator.ts "<goal>"
```

No code changes: the Agent SDK spawns the Claude Code CLI, which respects
`ANTHROPIC_BASE_URL`.

## What gets compressed in a goalloop run

| Lane | Model | pxpipe behavior |
|---|---|---|
| Planner / reviewer | Fable 5 | Imaged (default allowlist) — system prompt, memory digest, large file reads |
| Loop orchestrator | Sonnet 5 | Pass-through, byte-identical |
| Workers | Sonnet 5 / Opus 4.8 | Pass-through, byte-identical |
| Verifier | Haiku 4.5 | Pass-through, byte-identical |

This split is deliberate. pxpipe is lossy on byte-exact values inside imaged
content (silent misreads, not errors). goalloop keeps everything byte-exact-
critical — task-graph JSON, verify commands, contracts — in the pass-through
lanes and in recent turns, which pxpipe always leaves as text.

## Measuring your savings

pxpipe logs the billed usage AND a free `count_tokens` counterfactual for
every request to `~/.pxpipe/events.jsonl`. Compare after a few runs; don't
trust headlines (ours included).

## Knobs

- `PXPIPE_MODELS=off` — disable imaging entirely, pure pass-through.
- `PXPIPE_MODELS=claude-fable-5` — default scope (plus gpt-5.6).
- Do NOT add Opus 4.8 to the allowlist for goalloop runs: it misreads ~7% of
  renders and the escalation lane handles exactly the tasks where a silent
  misread costs the most.
