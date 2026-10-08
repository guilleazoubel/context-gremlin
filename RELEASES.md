# cgremlin releases

Every change to the engine or extension that gets installed is recorded here, newest first.
Each release has a **git tag**, and the **built extension (.vsix) is saved** in `~/cgremlin-releases/`, so you
can always go back exactly one version.

> The VS Code extension carries the engine. Installing a `.vsix` replaces both, and the running engine only changes
> after **Developer: Reload Window** → **cgremlin: Restart the engine**.

## Versions

| Date | Tag | Commit | Saved build (`~/cgremlin-releases/`) | What changed | Roll back to |
|---|---|---|---|---|---|
| 2026-10-08 | `cgremlin-2` | `117110a` | `cgremlin-vscode-0.0.1-2-built-2026-10-08.vsix` (1111791 bytes, SHA-256 `d21ffe23a9b4d1db140ef38042920a66dcb7a220ae15d98d9fcc7722b913843e`; `engine/engine.js` `fab34a318a5605767e5fa07feb894815c14b99c1f8a3775fe44ea3a63f483b6b`, `engine/bridge.js` `97e0d13304b3a79a3a9af86f196a1b18d684e20d6c1806ee4ac3e4a21785be7c`). **Built and saved, NOT installed. NOT pushed** (the docs commit that records this row follows the `cgremlin-2` tag). | **2:** **R90** fresh runs (`StageRunInput.fresh`, no `--resume`) with a per-round archive of BRIEF/FEEDBACK; **R91** PR detection for development sessions (`session.pr` / `pr_opened`, plus merged/closed reconciliation); **R116** `routing.<stage>` model/effort per stage (the Claude runner passes `--effort` and unsets `CLAUDE_CODE_EFFORT_LEVEL`; the Codex runner passes `-c model_reasoning_effort`); per-run records (`runs.jsonl`: stage, runner, model, effort, tokens, limit events, outcome); `feedback.jsonl` capture of dismissals and rejected verdicts (written only, no UI yet). Gates on the merged tree: core 2588 passed, vscode 1340 passed (+1 skipped). Merge commit `117110a` (parents `99ba949` and `7feac64`). | `cgremlin-pre-2` (same build as `cgremlin-1`) |
| 2026-10-08 | `cgremlin-pre-2` | `b1a096b` | `cgremlin-vscode-0.0.1-1-built-2026-10-06.vsix` | Baseline: the build that was installed before step 2 (identical to `cgremlin-1`). The installed engine pair (SHA-256): `engine/engine.js` `4461b1f7f4646d8a6b76e654d1a495c02dd8596fa8d1d338311d03569cd9b019`, `engine/bridge.js` `274de4c2da009dceb27cc013195b49cf20da5eec73f2418624e0476b5a1b086f`; all 49 files under `out/` and `engine/` of the installed extension equal the `cgremlin-1` vsix. | — |
| 2026-10-06 | `cgremlin-1b` | `bd22e09` | `cgremlin-vscode-0.0.1-1b-built-2026-10-06.vsix` (built and saved, **not installed**: 1b changes no extension/engine runtime code, so the installed extension stays the `cgremlin-1` build) | **1b:** **plugin `cgremlin` 0.1.0** (12 agents with `tools`, model/effort per §17 and output formats; reviewer on Opus; verifier verdict CONFIRMED/REFUTED/UNVERIFIABLE; the `qa-verify` skill moved to `plugin/skills/qa-verify`) from the local marketplace `cgremlin-local`, installed at user level (`/cgremlin:qa-verify` and the `cgremlin:*` agents resolve in other repos; verified from a grace-frontend session, repo untouched). `.claude/agents/*.md` are symlinks into `plugin/agents/`. The engine/extension is unchanged (the vsix was rebuilt and saved but not installed). **Bump the plugin version in `plugin.json` and `marketplace.json` on every plugin change: the version is the install cache key.** Roll the plugin back with `claude plugin marketplace remove cgremlin-local` (or install from `cgremlin-pre-1b`'s tree, which has no plugin). | `cgremlin-pre-1b` |
| 2026-10-06 | `cgremlin-pre-1b` | `b1a096b` | `cgremlin-vscode-0.0.1-1-built-2026-10-06.vsix` | Baseline: the build that was installed before 1b (identical to `cgremlin-1`). | — |
| 2026-10-06 | `cgremlin-1` | `b1a096b` | `cgremlin-vscode-0.0.1-1-built-2026-10-06.vsix` | **1:** the `development` guard now also denies `gh pr ready/edit`, `gh api` and every force-push spelling (`--force`, `-f`, `+refspec`, `--force-with-lease`); commit, push of its own branch and `gh pr create --draft` stay. `PermissionSubject` gains `stage`: a review, re-review or live-check stage in a dev worktree is denied `git commit`/`git push`. Respond, QA and review unchanged; preflight (0c) untouched. | `cgremlin-pre-1` (same build as `cgremlin-0c`) |
| 2026-10-06 | `cgremlin-pre-1` | `8374d87` | `cgremlin-vscode-0.0.1-0c-built-2026-10-05.vsix` | Baseline: the build that was installed before step 1 (identical to `cgremlin-0c`). | — |
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
7. Push with explicit refs: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-<id> refs/tags/cgremlin-<id>` (git push asks for approval).
8. **Clean up:** remove the step's worktree and delete its merged branch (`git worktree remove .claude/worktrees/<id> && git branch -d step/<id>`), then end the session (`/exit`). The next step starts in a new session.
