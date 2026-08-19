import { describe, expect, it } from 'vitest';
import { optionalString, ASSISTANT_TOOL_DEFINITIONS } from '../workers/mcp/assistant-tools.js';

describe('optionalString', () => {
  it('leaves a field untouched when the argument was not given at all', () => {
    expect(optionalString(undefined)).toBeUndefined();
  });

  it('clears a field to null when explicitly passed null or an empty/whitespace string', () => {
    expect(optionalString(null)).toBeNull();
    expect(optionalString('')).toBeNull();
    expect(optionalString('   ')).toBeNull();
  });

  it('trims and returns a real value', () => {
    expect(optionalString('  $49/month  ')).toBe('$49/month');
  });
});

describe('ASSISTANT_TOOL_DEFINITIONS', () => {
  // The read/write split isn't what matters for safety here — reversibility
  // is. This locks in that the three genuinely irreversible tools each say
  // so in their own description, since that description is the ONLY thing
  // telling the model to get a spoken yes first (a prompt-level rule, not a
  // technical gate — see assistant-tools.ts's own doc comment on that
  // tradeoff). A tool added later without this reminder would silently lose
  // the confirmation behavior.
  it('every irreversible tool tells the model to confirm before acting', () => {
    const irreversible = ['delete_knowledge_item', 'remove_offer'];
    for (const name of irreversible) {
      const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === name);
      expect(def, `${name} should exist`).toBeTruthy();
      expect(def!.description.toLowerCase()).toMatch(/undone|confirm|yes/);
    }
  });

  it('has no duplicate tool names', () => {
    const names = ASSISTANT_TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // The load-bearing honesty guard for email_prospect isn't just prose in
  // the description — it's structural: the schema has no address-shaped
  // field at all, additionalProperties is false, so a model literally
  // cannot pass one through even if it tried. This locks that in at the
  // schema level, not just the description text.
  it('email_prospect accepts a prospect id but never an address', () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'email_prospect');
    expect(def).toBeTruthy();
    const props = Object.keys((def!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).toContain('prospect_id');
    expect(props.some((p) => /email|address|to\b/i.test(p))).toBe(false);
    expect((def!.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it('email_prospect says this is irreversible and to confirm first', () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'email_prospect');
    expect(def!.description.toLowerCase()).toMatch(/irreversible|confirm|yes/);
  });
});
