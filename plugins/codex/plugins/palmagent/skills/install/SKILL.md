---
name: install
description: Install Palmagent on this host for the first time, including application runtime and host-appropriate HTTPS ingress. For an existing installation use setup; for faults use doctor.
---

# Install Palmagent

The plugin orchestrates the host installation. The CLI owns application services and data;
the plugin chooses and configures the reverse proxy and TLS using the actual host environment.

1. Read [CLI bootstrap](../.shared/bootstrap.md), locate the exact compatible CLI, and reuse
   the saved channel and custom data directory. If installed, use `setup` instead.
2. Read [host ingress](../.shared/ingress.md). Inspect DNS, listeners, routing and certificate
   ownership before choosing the connection method. Ask for the public domain if missing;
   use CLI defaults for optional runtime settings unless the user has supplied others.
   The runtime requires Linux/systemd, Node, git, sudo and at least one authenticated Claude
   or Codex CLI. Resolve missing dependencies within the authorized installation; vendor
   sign-in remains interactive. nginx and Certbot are not CLI prerequisites.
3. Preview the application changes with `<cli> install --dry-run --non-interactive
   <resolved-config-flags>` and prepare the ingress plan. A preview-only request stops here.
4. For authorized installation, initialize preferences with `<cli> config init` using the
   same data directory, then run `<cli> install --non-interactive <resolved-config-flags>`.
   Use `--domain <hostname>` and preserve any requested runtime settings. Run as the agent
   owner, not root; the CLI escalates only the application service operations that require it.
5. Read `<cli> connection --data-dir <installed-data-dir>`, configure and verify ingress using
   its contract and the shared reference. The CLI's local health success is not HTTPS success.
6. Once HTTPS works, run `<cli> passkey --data-dir <installed-data-dir>` and give the user the
   single-use enrollment link. Report runtime, HTTPS, renewal, and external reachability
   separately, plus any remaining prerequisite. Do not leave setup commands for the user
   when the plugin can complete the already authorized work.
