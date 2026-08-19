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
});
