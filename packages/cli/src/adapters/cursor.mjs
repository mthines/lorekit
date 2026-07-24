// Adapter for Cursor hooks (.cursor/hooks.json, "version": 1).
//
// Cursor's hook surface is narrower than Claude/Codex:
//   - there is no SessionStart, so the read-on-start path is handled by the
//     bundled Cursor *rule* (the agent calls the MCP); the `beforeSubmitPrompt`
//     hook is best-effort and injects via `followup_message` where supported.
//   - `beforeShellExecution` fires *before* a command runs, so there is no exit
//     code to inspect — reliable failure detection is not possible here.
//   - the confirmed injection channel is `stop` → { followup_message }.
//
// Confirmed stdin fields: `command`, `file_path`, `edits`, `generation_id`.
export const cursor = {
  name: 'cursor',

  intentFor(event) {
    switch (event) {
      case 'beforeSubmitPrompt':
        return 'read';
      case 'stop':
        return 'retrospective';
      default:
        return 'noop';
    }
  },

  parse(input) {
    return {
      cwd:
        input.cwd ||
        (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : null),
      sessionId: input.generation_id || input.conversation_id || null,
      toolName: 'command',
      toolResponse: null,
      event: input.hook_event_name || null,
    };
  },

  // Cursor injects an agent-visible message via `followup_message`.
  emit(_event, text) {
    return JSON.stringify({ followup_message: text });
  },
};
