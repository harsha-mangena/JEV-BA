import type { RunReport } from '@qa/contracts';

const x = (s: unknown) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** JUnit XML. Only PASS is reported as passing; every other verdict is a failure or error. */
export function toJUnit(report: RunReport): string {
  const cases = report.cases;
  const failures = cases.filter((c) => ['FAIL', 'FLAKY', 'NEEDS_REVIEW'].includes(c.verdict)).length;
  const errors = cases.filter((c) => ['ERROR', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'].includes(c.verdict)).length;
  const seconds = (a: string, b: string) => ((Date.parse(b) - Date.parse(a)) / 1000).toFixed(3);
  const body = cases
    .map((c) => {
      const name = `${c.scenario_id} [${c.execution_profile}]`;
      const detail = [
        `verdict=${c.verdict} reason=${c.reason ?? '-'}`,
        c.message ?? '',
        ...c.assertions.filter((a) => a.status !== 'passed').map((a) => `${a.milestone_id}#${a.index} ${a.type}: ${a.status} ${a.message ?? ''}`),
      ]
        .filter(Boolean)
        .join('\n');
      let inner = '';
      if (['FAIL', 'FLAKY', 'NEEDS_REVIEW'].includes(c.verdict)) inner = `<failure type="${x(c.verdict)}" message="${x(c.message ?? c.verdict)}">${x(detail)}</failure>`;
      else if (c.verdict !== 'PASS') inner = `<error type="${x(c.verdict)}" message="${x(c.message ?? c.verdict)}">${x(detail)}</error>`;
      return `    <testcase classname="${x(c.requirement_ids.join(','))}" name="${x(name)}" time="${seconds(c.started_at, c.finished_at)}">${inner}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="autonomous-qa" tests="${cases.length}" failures="${failures}" errors="${errors}">
  <testsuite name="${x(report.run_id)}" tests="${cases.length}" failures="${failures}" errors="${errors}" timestamp="${x(report.started_at)}">
    <properties>
      <property name="base_url" value="${x(report.base_url)}"/>
      <property name="environment" value="${x(report.environment)}"/>
      <property name="commit_sha" value="${x(report.commit_sha ?? '')}"/>
      <property name="gate_eligible" value="${report.gate.eligible}"/>
    </properties>
${body}
  </testsuite>
</testsuites>
`;
}
