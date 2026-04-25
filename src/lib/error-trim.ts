// Trim CLI error messages to the agent-relevant portion.
// CLI error throwers append human-targeted suggestions (e.g.
// "Try: midnight airdrop 1") that are noise for an MCP agent — the agent
// has the structured `code` from classifyError and acts on tool calls,
// not shell commands. This helper drops those suggestion suffixes while
// preserving multi-line FACT context (e.g. "Available: 0.3 DUST, need
// ≥0.5 DUST"), which agents do need.

/**
 * Cut the first paragraph of `raw`, then drop any line within it that
 * looks like a CLI-command suggestion (`midnight ...`, `mn ...`, or
 * `Try:`/`Run:`/`See:`/`Open:` prefixes). Preserves earlier lines as
 * long as they're plain context.
 */
export function trimAgentMessage(raw: string): string {
  const firstParagraph = raw.split('\n\n')[0]!.trim();
  const lines = firstParagraph.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/(?:^|\s)(midnight|mn)\s+[a-z]/i.test(line)) break;
    if (/^(Try|Run|See|Open):\s/i.test(line.trim())) break;
    kept.push(line);
  }
  return kept.join('\n').trim() || firstParagraph;
}
