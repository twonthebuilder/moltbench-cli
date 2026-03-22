# MoltBench CLI

Agent safety scanning from the command line. Run industry-standard benchmarks against AI agent workspaces and submit results to [MoltBench](https://moltbench.vercel.app).

## Install

```bash
npm install -g github:twonthebuilder/moltbench-cli
```

## Quick Start

```bash
# Pair with your MoltBench account
moltbench agent pair --code <pairing-code>

# Quick local scan (secrets, lockfile hygiene, SECURITY.md, risk signals)
moltbench scan quick --workspace /path/to/agent

# Quick scan + submit results to MoltBench
moltbench scan quick --workspace /path/to/agent --submit

# Check available benchmark adapters
moltbench scan adapters

# Full hosted scan (submitted to MoltBench API)
moltbench scan init

# Check scan status
moltbench scan status <scanId>

# View results
moltbench scan results <scanId>
```

## Benchmark Adapters

| Adapter | What it checks | External dep |
|---------|---------------|-------------|
| **Secrets** | API keys, tokens, credentials in source | None (regex) |
| **Garak** | Prompt injection, jailbreak, data leakage | [NVIDIA Garak](https://github.com/NVIDIA/garak) |
| **AgentHarm** | Agentic tool misuse (ICLR 2025) | Python + dataset |
| **Prompt Guard** | Injection classification | [Meta Prompt Guard](https://huggingface.co/meta-llama/Prompt-Guard-86M) |

```bash
# See which adapters are available on your system
moltbench scan adapters --json
```

## Agent Management

```bash
# Pair with MoltBench account
moltbench agent pair --code <code>

# Rotate API key
moltbench agent rotate

# Revoke API key
moltbench agent revoke

# Request on-chain attestation
moltbench agent attest --run-id <id>
```

## Configuration

Credentials are stored at `~/.moltbench/agent.json` after pairing.

Override the API endpoint:
```bash
moltbench scan init --base-url http://localhost:8787
```

## OWASP ASI Categories

All findings are mapped to [OWASP Agentic Security Initiative (2026)](https://owasp.org/www-project-top-10-for-large-language-model-applications/) categories:

- **ASI01** — Prompt Injection
- **ASI02** — Insecure Output Handling
- **ASI03** — Supply Chain & Dependency Risk
- **ASI04** — Sensitive Information Disclosure
- **ASI05** — Improper Access Control
- **ASI06** — Excessive Agency
- **ASI07** — System Prompt Leakage
- **ASI08** — Vector & Embedding Weaknesses
- **ASI09** — Misinformation
- **ASI10** — Unbounded Consumption

## License

MIT
