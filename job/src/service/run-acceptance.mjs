import { readFileSync } from 'node:fs';
import { evaluate } from './expectations.mjs';
import { runSharedCases } from './cases.mjs';
import roles from '../../fixtures/roles.json' with { type: 'json' };

export async function runAcceptance() {
  const manifest = JSON.parse(readFileSync(new URL('../../deploy/client-manifest.example.json', import.meta.url), 'utf8'));
  const report = await runSharedCases();
  const verdict = evaluate(report);
  const adaptHosts = Object.values(manifest.adapt).filter((value) => typeof value === 'string');
  const manifestOk = adaptHosts.every((value) => value.includes('example.invalid') || value.endsWith('_KEY') || value.endsWith('_SECRET') || value === 'v6.0');
  return {
    schema: 'ghost-continuity.acceptance.v1',
    ok: verdict.ok && manifestOk,
    roles,
    checklist: report.checklist,
    failures: [
      ...verdict.failures,
      ...(manifestOk ? [] : ['manifest adapt hosts must stay on example.invalid']),
    ],
    cases: report.cases.map((item) => ({
      id: item.id,
      required: item.required,
      native_sufficient: item.native_sufficient ?? false,
    })),
  };
}
