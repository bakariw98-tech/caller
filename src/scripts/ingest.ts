/**
 * Imports a curriculum file for a creator.
 *
 *   npm run ingest -- --creator creator_abc --file ./curriculum/sourdough.md
 *   npm run ingest -- --file ./curriculum/sourdough.md --audit-only
 *
 * The audit is printed either way. A course that fails it is rejected rather
 * than stored, because a flattened curriculum produces a coach that can talk
 * about the material but cannot tell anyone which step they are on.
 */
import { readFileSync } from 'node:fs';
import { applySchema, getDb } from '../db/index.js';
import { parseCurriculumMarkdown } from '../curriculum/parse-markdown.js';
import { ingestCourse, StructureLostError } from '../curriculum/ingest.js';
import { auditStructure } from '../curriculum/schema.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const file = arg('file');
  if (!file) throw new Error('Usage: npm run ingest -- --creator <id> --file <path> [--audit-only] [--force]');

  const parsed = parseCurriculumMarkdown(readFileSync(file, 'utf8'));
  const issues = auditStructure(parsed);
  const stepCount = parsed.modules.flatMap((m) => m.lessons.flatMap((l) => l.steps)).length;

  console.log(`\n${parsed.title}`);
  console.log(`  ${parsed.modules.length} module(s), ${stepCount} step(s), ${parsed.references.length} reference(s)`);

  if (issues.length > 0) {
    console.log('\nStructure audit:');
    for (const issue of issues) {
      console.log(`  [${issue.severity}] ${issue.path}\n      ${issue.message}`);
    }
  } else {
    console.log('  Structure audit: clean');
  }

  if (process.argv.includes('--audit-only')) return;

  const creatorId = arg('creator');
  if (!creatorId) throw new Error('--creator is required unless --audit-only is set');

  applySchema(getDb());
  try {
    const result = ingestCourse(getDb(), creatorId, parsed, { force: process.argv.includes('--force') });
    console.log(`\nStored as ${result.courseId} — ${result.stepCount} steps, ${result.problemCount} documented problems.\n`);
  } catch (err) {
    if (err instanceof StructureLostError) {
      console.error(`\n${err.message}\n`);
      console.error('Fix the material, or pass --force to store it as a draft that cannot go live.\n');
      process.exit(1);
    }
    throw err;
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
