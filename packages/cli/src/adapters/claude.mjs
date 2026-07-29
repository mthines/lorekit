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
        return 'confirm';
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

  // Returns true when the PostToolUse event was a successful lorekit memory
  // write. Claude Code reports MCP tool names as
  // "mcp__<server-label>__memory_write" (underscores) — we match the suffix
  // so any server label works. A successful write response always contains
  // a string `id` field returned by the memory_write RPC.
  isLoreWrite(toolName, toolResponse) {
    if (!toolName || !String(toolName).endsWith('memory_write')) return false;
    return toolResponse != null && typeof toolResponse === 'object' && typeof toolResponse.id === 'string';
  },

  parse(input) {
    return {
      cwd: input.cwd || null,
      sessionId: input.session_id || null,
      toolName: input.tool_name || 'tool',
      toolInput: input.tool_input || null,
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
