#!/usr/bin/env node
import { runAcceptance } from '../src/service/run-acceptance.mjs';
import { runCompare } from '../src/service/run-compare.mjs';

const acceptance = await runAcceptance();
const comparison = await runCompare();
const lines = [
  `acceptance ${acceptance.ok ? 'pass' : 'fail'} (${acceptance.cases.length} cases, ${acceptance.checklist.length} deployment steps)`,
  `comparison ${comparison.ok ? 'pass' : 'fail'}`,
  `native win: ${comparison.native_win.case_id}`,
  `not proved: ${comparison.not_proved.join(', ')}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(acceptance.ok && comparison.ok ? 0 : 1);
