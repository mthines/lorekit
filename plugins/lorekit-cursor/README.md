# LoreKit for Cursor

Cursor's hook surface is narrower than Claude Code's — there is no
`SessionStart` event and `beforeShellExecution` fires *before* a command runs
(so there is no exit code to inspect). This bundle therefore splits the work:

- **Reading lessons** is driven by a **rule** (`rules/lorekit-memory.mdc`),
  which tells the agent to query LoreKit at task start and write lessons when
  something goes wrong.
- **The retrospective nudge** is driven by the **`stop` hook**, which injects a
  `followup_message` reminding the agent to record a lesson.
- The **`beforeSubmitPrompt` hook** is best-effort and injects lessons where the
  Cursor version supports it; the rule is the reliable read path.

## Install

Copy the three files into your project (or your home `~/.cursor/`):

```bash
mkdir -p .cursor/rules
cp plugins/lorekit-cursor/hooks.json          .cursor/hooks.json
cp plugins/lorekit-cursor/rules/lorekit-memory.mdc  .cursor/rules/
cp plugins/lorekit-cursor/mcp.json            .cursor/mcp.json   # then fill in your endpoint + token
```

Hooks call `npx -y @lorekit/cli` — install it globally (`npm i -g @lorekit/cli`)
for lower latency and change the command to `lorekit` if you prefer.

Verify with `npx @lorekit/cli doctor`.
