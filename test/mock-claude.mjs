#!/usr/bin/env node
// Mock `claude` CLI for smoke tests. Behaviour is driven by a call-counter file
// so consecutive invocations walk through a scripted scenario:
//   call 1 → usage limit (retry-after: 2s)
//   call 2 → ok round
//   call 3 → ok round that ALSO appends the stop marker to the state file
// Reads stdin like the real CLI (prompt), ignores it.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const counterFile = process.env.MOCK_COUNTER_FILE;
const stateFile = process.env.MOCK_STATE_FILE;

let n = 0;
try {
  n = Number(readFileSync(counterFile, 'utf8')) || 0;
} catch {
  /* first call */
}
n += 1;
writeFileSync(counterFile, String(n));

// drain stdin so the parent's write never blocks
try {
  process.stdin.resume();
  process.stdin.on('data', () => {});
  setTimeout(() => process.stdin.pause(), 50);
} catch {
  /* ignore */
}

setTimeout(() => {
  if (n === 1) {
    // simulate a usage limit with a parsable short reset
    process.stdout.write(
      JSON.stringify({ type: 'result', is_error: true, result: 'usage limit reached — retry-after: 2' }) + '\n',
    );
    process.exit(1);
  }
  if (n === 2) {
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'round 1 done, state updated' }) + '\n');
    process.exit(0);
  }
  // n >= 3 → finish: write the marker into the shared state file like a real agent would
  appendFileSync(stateFile, '\nAUTOLOOP: COMPLETE\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'AUTOLOOP: COMPLETE' }) + '\n');
  process.exit(0);
}, 100);
