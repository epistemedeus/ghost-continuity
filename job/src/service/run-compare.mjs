import { evaluate } from './expectations.mjs';
import { measureSources, runSharedCases } from './cases.mjs';
import roles from '../../fixtures/roles.json' with { type: 'json' };

const NOT_PROVED = [
  'customer_preference',
  'willingness_to_pay',
  'outside_adoption',
  'earned_revenue',
  'support_subscription',
];

export async function runCompare() {
  const shared = await runSharedCases();
  const verdict = evaluate(shared);
  const sources = measureSources();
  return {
    schema: 'ghost-continuity.comparison.v1',
    specimen: 'ghost-publication-to-customer-catalog',
    semantics: 'SEMANTICS.md',
    roles,
    ok: verdict.ok,
    failures: verdict.failures,
    not_proved: NOT_PROVED,
    arms: {
      direct: 'Content API poll, pagination, and the frozen effect rule. No webhook signature.',
      package: 'The same effect rule, signed webhooks for three post events, and reconcile when an event never arrives.',
      service: 'The package plus the deployment manifest, checklist, and acceptance command. The service does not replace the poll.',
    },
    native_win: {
      case_id: 'missed_webhook',
      finding: 'A content-API poll converges when no webhook is delivered. The webhook-only path stays empty until reconcile runs. The acceptance checklist therefore includes reconcile. The package does not beat the poll on this case.',
    },
    procedure_steps: shared.checklist.length,
    source_measurement: sources,
    cases: shared.cases,
  };
}
