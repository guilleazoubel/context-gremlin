# cgremlin releases

Every change to the engine or extension that gets installed is recorded here, newest first.
Each release has a **git tag**, and the **built extension (.vsix) is saved** in `~/cgremlin-releases/`, so you
can always go back exactly one version.

> The VS Code extension carries the engine. Installing a `.vsix` replaces both, and the running engine only changes
> after **Developer: Reload Window** → **cgremlin: Restart the engine**.

## Versions

| Date | Tag | Commit | Saved build (`~/cgremlin-releases/`) | What changed | Roll back to |
|---|---|---|---|---|---|
| 2026-10-05 | `cgremlin-0c` | `8374d87` | `cgremlin-vscode-0.0.1-0c-built-2026-10-05.vsix` | **0c:** a headless run now sees its Jira ticket and PR, or stops and says why. Every brief states the ticket (loaded / NOT LOADED + reason / none linked / skipped); the engine is the only Jira source and ticket text is fenced as untrusted; review, re-review, respond and QA stop with `needs-input` before launching if a linked ticket can't be loaded or `gh` fails (Run anyway skips Jira only); a Jira 404 runs but says so. | `cgremlin-pre-0c` (same build as `cgremlin-0b`) |
| 2026-10-05 | `cgremlin-pre-0c` | `7236712` | `cgremlin-vscode-0.0.1-0b-built-2026-10-05.vsix` | Baseline: the build that was installed before 0c (identical to `cgremlin-0b`). | — |
| 2026-10-05 | `cgremlin-0b` | `7236712` | `cgremlin-vscode-0.0.1-0b-built-2026-10-05.vsix` | **0b:** the respond brief keeps its instructions (incl. the injection-refusal rule) however long the threads are; reviewer text is capped and fenced in `<untrusted-pr-data>`. The re-review prompt no longer lets a review skill skip the `BRIEF.md` contract, the no-post rule or `rereview_summary`. | `cgremlin-pre-0b` (same build as `cgremlin-r110`) |
| 2026-10-05 | `cgremlin-pre-0b` | `6f84531` | `cgremlin-vscode-0.0.1-r110-built-2026-10-05.vsix` | Baseline: the build that was installed before 0b (identical to `cgremlin-r110`). | — |
| 2026-10-05 | `cgremlin-r110` | `6f84531` | `cgremlin-vscode-0.0.1-r110-built-2026-10-05.vsix` | **R110:** review and re-review never post on their own. Headless runs write `REVIEW.md` and stop; the post helpers exist only while you hold the chat, and posting happens after you ask. Respond and QA unchanged. | `cgremlin-pre-r110` |
| 2026-09-28 | `cgremlin-pre-r110` | `20b7c6d` | `cgremlin-vscode-0.0.1-pre-r110-built-2026-09-28.vsix` | Baseline: the build that was installed before R110. | — |

## Roll back one version

**Fast: just reinstall the previous build.** No code changes; a minute.
```bash
code --install-extension ~/cgremlin-releases/<previous .vsix from the table> --force
```
Then in VS Code: **Developer: Reload Window**, then **cgremlin: Restart the engine**.

**Full: also roll the code back**, so the next build starts from the old version.
```bash
cd ~/context-gremlin
git status                                   # make sure nothing uncommitted would be lost
git switch -c rollback/<tag> <previous tag>  # e.g. git switch -c rollback/pre-r110 cgremlin-pre-r110
cd cgremlin/vscode && pnpm build && pnpm package
code --install-extension cgremlin-vscode-0.0.1.vsix --force
```
Then reload and restart as above. To undo the rollback, switch back to `mission-control-pr-orchestrator` and
reinstall the newer `.vsix`.

**If the saved .vsix is missing**, rebuild it from its tag with the "Full" steps above. Tags are pushed to
`github.com/guilleazoubel/context-gremlin`.

## Cutting a release (checklist)
1. Tests, typecheck and lint pass in `cgremlin/core` and `cgremlin/vscode`.
2. `git tag -a cgremlin-pre-<name> <current installed commit>` (if not already tagged).
3. Merge, then `git tag -a cgremlin-<name> HEAD -m "<one line>"`.
4. `cd cgremlin/vscode && pnpm build && pnpm package`, then `code --install-extension cgremlin-vscode-0.0.1.vsix --force`.
5. Copy the `.vsix` to `~/cgremlin-releases/cgremlin-vscode-<version>-<name>-built-<date>.vsix`.
6. Add a row to the table above (and refresh `~/cgremlin-releases/README.md`).
7. `git push origin <branch> --tags`.
