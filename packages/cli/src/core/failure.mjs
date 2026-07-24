// Heuristic: did a completed tool call fail? Framework-agnostic.
// Conservative on purpose — a false "failed" nudges the agent needlessly.

function num(v) {
  return typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null;
}

// `response` is the tool_response object (shape varies by framework/tool).
export function isFailure(toolName, response) {
  if (!response || typeof response !== 'object') return false;

  // Explicit error flags set by the harness.
  if (response.is_error === true || response.isError === true) return true;
  if (response.interrupted === true) return false; // user abort, not a lesson

  // Exit codes from shell-style tools.
  for (const field of ['exit_code', 'exitCode', 'code', 'returnCode']) {
    const n = num(response[field]);
    if (n !== null) return n !== 0;
  }

  // Some tools report status directly.
  if (typeof response.status === 'string') {
    return /^(error|fail(ed)?)$/i.test(response.status);
  }

  return false;
}
