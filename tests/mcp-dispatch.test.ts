import { describe, expect, it } from 'vitest';
import { toolDefinitionsForKind } from '../workers/routes/mcp.js';
import { TOOL_DEFINITIONS } from '../workers/mcp/tools.js';
import { QUAL_TOOL_DEFINITIONS } from '../workers/mcp/qual-tools.js';
import { ASSISTANT_TOOL_DEFINITIONS } from '../workers/mcp/assistant-tools.js';

/**
 * The exact bug the plan called out before this dispatcher existed: the
 * original code was `resolved.kind === 'coach' ? coach : qual` — an
 * if/else, not a switch — so a third session kind added without care would
 * silently fall into the else branch and be handed the QUALIFICATION tool
 * set instead of nothing. This locks the fail-closed behavior in place: an
 * unknown kind gets an EMPTY list, never someone else's tools.
 */
describe('toolDefinitionsForKind', () => {
  it('returns the right tool set per known kind', () => {
    expect(toolDefinitionsForKind('coach')).toBe(TOOL_DEFINITIONS);
    expect(toolDefinitionsForKind('qualify')).toBe(QUAL_TOOL_DEFINITIONS);
    expect(toolDefinitionsForKind('assistant')).toBe(ASSISTANT_TOOL_DEFINITIONS);
  });

  it('fails closed on an unhandled kind rather than falling through to another set', () => {
    expect(toolDefinitionsForKind('something-new')).toEqual([]);
    expect(toolDefinitionsForKind('')).toEqual([]);
  });

  it('the three known tool sets are disjoint by name', () => {
    const names = (defs: { name: string }[]) => defs.map((d) => d.name);
    const all = [...names(TOOL_DEFINITIONS), ...names(QUAL_TOOL_DEFINITIONS), ...names(ASSISTANT_TOOL_DEFINITIONS)];
    expect(new Set(all).size).toBe(all.length);
  });
});
