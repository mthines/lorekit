// Adapter for OpenAI Codex CLI hooks (experimental; `codex_hooks` feature flag).
// Codex mirrors Claude Code's event model and JSON shape closely, so we reuse
// the same snake_case input fields and hookSpecificOutput.additionalContext
// output. If a future Codex build diverges, only this file needs to change.
export const codex = {
  name: 'codex',

  intentFor(event) {
    switch (event) {
      case 'SessionStart':
        return 'read';
      case 'PostToolUse':
        return 'failure';
      case 'Stop':
        return 'retrospective';
      default:
        return 'noop';
    }
  },

  parse(input) {
    return {
      cwd: input.cwd || (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : null),
      sessionId: input.session_id || input.thread_id || null,
      toolName: input.tool_name || 'tool',
      toolResponse: input.tool_response || null,
      event: input.hook_event_name || null,
    };
  },

  emit(event, text) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    });
  },
};
