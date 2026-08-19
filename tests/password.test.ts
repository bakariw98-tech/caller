import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../workers/auth/password.js';

describe('hashPassword/verifyPassword', () => {
  it('round-trips the correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('rejects an empty password against a real hash', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('uses a different salt (and thus a different stored string) each time for the same password', () => {
    const a = hashPassword('same password');
    const b = hashPassword('same password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same password', a)).toBe(true);
    expect(verifyPassword('same password', b)).toBe(true);
  });

  it('never throws on a missing or malformed stored value — treats it as no match', () => {
    expect(verifyPassword('anything', null)).toBe(false);
    expect(verifyPassword('anything', undefined)).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(verifyPassword('anything', 'pbkdf2:not-a-number:aa:bb')).toBe(false);
    expect(verifyPassword('anything', 'bcrypt:10:aa:bb')).toBe(false);
    expect(verifyPassword('anything', 'pbkdf2:1000:zz:zz')).toBe(false);
  });

  it('is case-sensitive', () => {
    const stored = hashPassword('Password123');
    expect(verifyPassword('password123', stored)).toBe(false);
  });
});
