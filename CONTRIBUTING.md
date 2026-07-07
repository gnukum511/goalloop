# Contributing to goalloop

Thanks for helping improve goalloop. This project is MIT-licensed — fork, experiment, and send PRs.

## Quick setup

```bash
git clone https://github.com/gnukum511/goalloop.git
cd goalloop
npm install
npm run typecheck
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx src/orchestrator.ts "smoke test goal with a tiny verify command"
```

## Before you open a PR

1. Run `npm run typecheck` — must pass.
2. Keep changes focused. The orchestrator is intentionally small; prefer surgical diffs.
3. Update README or `docs/` if you change CLI flags, env vars, or the agent topology.
4. Do not commit `.env`, `.goalloop/`, or `node_modules/`.

## What we're looking for

- Clearer verify/escalation semantics
- Better checkpoint/resume edge cases
- pxpipe integration examples and guardrails
- Cost/latency benchmarks with reproducible goals
- Docs for pairing with Cursor, Claude Code, or CI

## Issues

Use [GitHub Issues](https://github.com/gnukum511/goalloop/issues) for bugs and feature ideas. Include your goal text (redacted), model IDs, and whether pxpipe was in the path.

## License

By contributing, you agree your contributions are licensed under the same MIT license as the project.
