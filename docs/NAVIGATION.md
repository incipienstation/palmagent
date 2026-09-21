# Back navigation

Page history is owned by `apps/web/src/navigation.ts`. The hash router subscribes
there instead of interpreting browser events independently. An in-app Back arrow
uses the same layer dismissal as browser Back, with a Tasks fallback when a direct
link has no previous Palmagent page. Plain browser Back can still leave the site.

The installed PWA has one exit floor below Tasks. A direct task link gets a Tasks
entry first. Existing page entries survive reloads without another floor. Only
Back at that floor shows the two-second exit hint; page changes and opening a
layer disarm it. Dismissing or replacing the exit hint also disarms it immediately.
The fixed two-second deadline dismisses the hint even if hover/focus has paused
ordinary toast timers. While the hint is visible, the original history entry stays
exposed so the next system Back can leave through the browser's native behavior.
Expiry, dismissal, or continued app interaction restores the existing root entry
with Forward, without pushing a replacement from `popstate`. JavaScript Back at
the start of history is a no-op, not an app-close API; it must never lock navigation.
Backgrounding, freezing, or leaving the document cancels the exit hint without
traversing history. Returning to a visible document restores the existing root
guard, so each visit starts a fresh two-Back sequence even without a reload.
Page and layer history are retained across these lifecycle transitions.
In-app arrows never request app exit. Browser tests cover history traversal, not
the operating system's PWA window lifecycle.

Task creation replaces the form with its conversation only while that form remains
mounted. A late acknowledgement retains the chosen screen and clears only the
submitted draft values, preserving newer edits.

## Temporary surfaces

Dialog, AlertDialog, Sheet, Drawer, Popover, DropdownMenu and Select roots use
`useBackDismiss`. It retains their controlled/uncontrolled open contracts and
lets the primitives handle focus restoration, Escape, scrim and drag dismissal.
Back only requests closure; it never confirms destructive actions. A consumer may
refuse closure during an in-flight save.

One temporary history entry covers all open layers. Back closes the topmost layer
and retains the page; remaining layers receive another cover. Closing through the
UI removes the cover before a queued page navigation runs. Forward does not reopen
dismissed surfaces. Reload discards the old cover before restoring any update
checkpoint, whose open surfaces then register themselves normally.

Nested primitive surfaces inherit a higher priority through React context. Inline
terminal panels use priority 50. Settings and repository-picker subpages use 150,
between their containing surface (100) and nested overlays (200). Folder browsing
uses 160 to retrace visited directories before returning to repository search.
Registration cleanup is deferred to a microtask so StrictMode remounts and
menu-to-dialog transitions do not accumulate entries.

## Audited surfaces

| Surface | Back behavior |
| --- | --- |
| Navigation drawer, Spaces drawer | Close, retaining the underlying page |
| Settings → Spaces / Updates | Return to general settings, then close |
| Repository picker → browse / manual path | Return to search; browsing first retraces visited folders |
| Session details and pull-request sheets | Close, retaining the conversation |
| Rename dialog, image and diagram previews | Dismiss; pending saves retain their close guard |
| Cancel/archive/sign-out/terminate confirmations | Dismiss without performing the action |
| Composer configuration, attachment menus, skill and delivery popovers, queue editor | Dismiss the top surface, retaining drafts |
| Model/effort/permission/terminal selectors | Dismiss without navigating away |
| Embedded conversation terminal | Return to the conversation without terminating its shell |
| Standalone Terminals, Usage, Routines, New task, conversation | Return through page history |
| Tooltips, transcript disclosures and ordinary tabs | Remain local controls, not navigation steps |
| Native browser confirmation and file pickers | Remain browser-owned |

`back-navigation.spec.ts` covers browser and emulated standalone sequences,
nesting, direct links, reloads, Forward, ordinary dismissal cleanup and root exit.
Image-preview Back also runs in `image-rendering.spec.ts`. Native Android system
exit and iOS edge gestures still require device testing; desktop Chromium's
standalone emulation verifies application history behavior, not OS integration.
