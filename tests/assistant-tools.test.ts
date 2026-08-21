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

  // Same honesty guard as email_prospect, same reason: the model resolves a
  // lead by id, looked up from list_prospects/search, never types out or
  // guesses an address itself.
  it('get_prospect_transcript accepts a prospect id but never an address', () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'get_prospect_transcript');
    expect(def).toBeTruthy();
    const props = Object.keys((def!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).toContain('prospect_id');
    expect(props.some((p) => /email|address|to\b/i.test(p))).toBe(false);
    expect((def!.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it('get_prospect_transcript warns that a call_recap message is not the prospect\'s own words', () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'get_prospect_transcript');
    expect(def!.description.toLowerCase()).toMatch(/call_recap/);
  });

  // The actual bug this locks in: a creator asking a broad "what's my
  // emails" was left to the model chaining list_prospects ->
  // get_prospect_transcript per person itself, which is exactly what did
  // NOT work in practice. get_recent_transcripts needs no id — it is the
  // single-call answer to that broad question.
  it('get_recent_transcripts needs no prospect id — it covers every lead in one call', () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'get_recent_transcripts');
    expect(def).toBeTruthy();
    const schema = def!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required ?? []).not.toContain('prospect_id');
    expect(Object.keys(schema.properties)).not.toContain('prospect_id');
  });

  it('get_prospect_transcript and get_recent_transcripts each point the model at the other for the wrong case', () => {
    const specific = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'get_prospect_transcript')!;
    const broad = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'get_recent_transcripts')!;
    expect(specific.description).toMatch(/get_recent_transcripts/);
    expect(broad.description.toLowerCase()).toMatch(/get_prospect_transcript/);
  });

  it('get_recent_transcripts also warns that a call_recap message is not the prospect\'s own words', () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === 'get_recent_transcripts');
    expect(def!.description.toLowerCase()).toMatch(/call_recap/);
  });

  // MCP spec 2025-06-18 tool annotations — the only structured signal a
  // connecting client's own safety layer has to decide whether a call is
  // safe to run without extra scrutiny, beyond free-text description
  // parsing. Every tool here should set one; a read-only tool that reads
  // the creator's own real email content (the transcript tools especially)
  // is exactly the case where an absent hint is most likely to make a
  // client's classifier default to caution.
  it('every tool declares readOnlyHint', () => {
    for (const def of ASSISTANT_TOOL_DEFINITIONS) {
      expect(def.annotations?.readOnlyHint, `${def.name} should set readOnlyHint`).not.toBeUndefined();
    }
  });

  it('the read-only lookup/list/get tools are actually marked readOnlyHint: true', () => {
    const readOnly = [
      'get_overview', 'search_knowledge', 'list_offers', 'list_prospects',
      'get_prospect_transcript', 'get_recent_transcripts', 'lookup_offer_from_content',
    ];
    for (const name of readOnly) {
      const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === name);
      expect(def!.annotations!.readOnlyHint, `${name} should be readOnlyHint: true`).toBe(true);
    }
  });

  it('every irreversible tool also sets destructiveHint: true', () => {
    for (const name of ['delete_knowledge_item', 'remove_offer', 'email_prospect']) {
      const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === name);
      expect(def!.annotations!.destructiveHint, `${name} should be destructiveHint: true`).toBe(true);
    }
  });
});
