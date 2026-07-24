// Adapter for Claude Code hooks.
// Contract: stdin JSON with snake_case fields; stdout injects context via
// hookSpecificOutput.additionalContext. Non-blocking (we never set decision).
export const claude = {
  name: 'claude',

  intentFor(event) {
    switch (event) {
      case 'SessionStart':
        return 'read';
      case 'PostToolUse':
      case 'PostToolUseFailure':
        return 'failure';
      case 'Stop':
        return 'retrospective';
      default:
        return 'noop';
    }
  },

  // PostToolUseFailure fires only when a tool failed — no heuristic needed.
  guaranteedFailure(event) {
    return event === 'PostToolUseFailure';
  },

  parse(input) {
    return {
      cwd: input.cwd || null,
      sessionId: input.session_id || null,
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
