# Installation login methods

A single owner can enable passkeys, GitHub web sign-in, or both. Keep existing methods
unless the owner asks to remove one. Apply the selected data directory to every command.
Finish public HTTPS first. A fresh installation without a registered method grants no access.

Use `<cli> auth --help` to check for `github-prepare` before using the new commands.
On older releases the passkey path still works. GitHub requires a supporting release.

- For passkeys, run `<cli> passkey` and provide the one-time enrollment link to the
  owner. Wait for completed enrollment before removing another login method.
- For GitHub, read `<cli> auth status` and provide its callback URL to register in a
  dedicated GitHub OAuth App. The owner enters their client secret locally in a private
  file. Never request the value in chat, command arguments, or logs.
- Run `<cli> auth github-prepare --client-id <id> --secret-file <private-file>` and give
  the owner the returned private setup URL. After the owner verifies in the browser,
  read `auth status`. Show the verified handle and numeric ID and ask the owner to
  confirm that identity. Only then run `<cli> auth github-confirm --owner-id <id>`.
  This also handles account replacement and secret rotation. Previously active GitHub
  sessions end on replacement. An interrupted setup can be restarted.
- For both methods complete both flows. Verify a fresh web sign-in before removing
  an existing method. Use `auth remove-github` or `auth remove-passkeys` for the
  requested method. The latter deletes registered keys. Each ends that method's sessions
  and invalidates pending sign-ins and enrollment links. `auth logout-all` ends all sessions.
- On a domain change, update the OAuth App callback to the new URL for GitHub and
  enroll a passkey on the new origin for passkey users. Recovery uses host access to
  register another method or replace the GitHub account.
