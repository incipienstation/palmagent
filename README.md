# Palmagent

> Self-hosted dispatcher that drives **Claude Code** and **Codex** headless on your own
> machine — one normalized event stream, a mobile-first PWA, push notifications, and
> cron-scheduled routines.

This repository is the **operator plugin marketplace** for Palmagent. It ships thin agent-side
skins — for **both Claude Code and Codex** — over the deterministic `palmagent` CLI. You install
the plugin into your agent, and its `install` skill stands up (or repairs, reconfigures, updates)
a self-hosted Palmagent instance for you. The CLI is the brain; these skills are thin skins that
locate it, confirm intent conversationally, run it, and — for `doctor` — add adaptive,
journal-driven diagnosis.

## Skills

Each is model-invokable by description (e.g. *"my dispatcher won't start"* → `doctor`) or
typeable directly.

| Skill     | Drives             | Use it for                                       |
|-----------|--------------------|--------------------------------------------------|
| `install` | `palmagent install`| First-run setup on a fresh host (systemd + nginx + TLS + first passkey) |
| `setup`   | `palmagent setup`  | Reconfigure an existing install (domain, port, repo roots, …) |
| `doctor`  | `palmagent doctor` | Diagnose a broken instance, correlated with systemd + journal logs |
| `update`  | `palmagent update` | Update in place, preserving in-flight agent turns |

## Install

### Claude Code

```
/plugin marketplace add incipienstation/palmagent
/plugin install palmagent@palmagent
```

### Codex

```bash
codex plugin marketplace add incipienstation/palmagent --ref main --sparse plugins/codex
codex plugin add palmagent@palmagent
# then start a NEW Codex thread to pick up the skills
```

See [`plugins/codex/README.md`](plugins/codex/README.md) for the Codex-specific details
(skill-only path, manage/refresh/remove, verified-format notes).

Once installed, just tell your agent what you want — e.g. *"install palmagent on this host"* or
*"the dispatcher is down, diagnose it"* — and the matching skill runs the CLI.

## How it works

```
L3  agent plugins (this repo)   thin skins for Claude Code + Codex — no orchestration logic
L2  palmagent CLI (npm)         deterministic install | setup | doctor | update | uninstall
L1  runtime                     the dispatcher (server + runner) the CLI installs and manages
```

The plugin depends on the CLI, never the reverse — so the CLI stays agent-agnostic and the
skins stay thin. All real work lives in L2.

## Requirements

The `install` skill preflights these and tells you exactly what is missing:

- Linux host with **systemd**; `node` / `npm` / `git` / `nginx` / `certbot`; `sudo`.
- **`claude` and/or `codex` installed and already logged in** (vendor login is interactive and
  must be done first).
- A public **domain** with a DNS A-record pointing at the host and ports **80/443** reachable
  (for certbot TLS).
- The `palmagent` CLI on `PATH` (`npm i -g palmagent`) or runnable via `npx palmagent`; the
  skills probe for it and fall back to `npx`.

## Repository layout

```
.claude-plugin/marketplace.json    ← Claude Code marketplace (repo root)
plugins/
  claude/                          ← Claude Code plugin
    .claude-plugin/plugin.json
    skills/{install,setup,doctor,update}/SKILL.md
  codex/                           ← Codex marketplace root (pass to `--sparse plugins/codex`)
    .agents/plugins/marketplace.json
    plugins/palmagent/             ← Codex plugin (folder name == plugin name)
      .codex-plugin/plugin.json
      skills/{install,setup,doctor,update}/SKILL.md + agents/openai.yaml
```

## License

[MIT](LICENSE)
