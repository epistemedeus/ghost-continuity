#!/usr/bin/env node
import { runAcceptance } from '../src/service/run-acceptance.mjs';

const report = await runAcceptance();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
