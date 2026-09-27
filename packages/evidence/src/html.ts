import type { CaseResult, RunReport } from '@qa/contracts';

const h = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const json = (v: unknown) => (v === undefined ? '' : h(JSON.stringify(v)));

function caseSection(c: CaseResult): string {
  const rows = c.assertions
    .map(
      (a) => `<tr class="${a.status}"><td>${h(a.milestone_id)}</td><td>${a.index}</td><td>${h(a.type)}</td><td>${h(a.status)}</td>
<td><code>${json(a.expected)}</code></td><td><code>${json(a.actual)}</code></td><td>${h(a.message)}</td></tr>`,
    )
    .join('');
  const artifacts = c.artifacts
    .map((a) => (a.kind === 'screenshot' ? `<figure><a href="${h(a.path)}"><img src="${h(a.path)}" alt="${h(a.path)}" loading="lazy"></a><figcaption>${h(a.path)}</figcaption></figure>` : `<li><a href="${h(a.path)}">${h(a.kind)}: ${h(a.path)}</a> <small>sha256 ${h(a.sha256.slice(0, 12))}…</small></li>`))
    .join('');
  return `<section class="case"><h2><span class="v ${h(c.verdict)}">${h(c.verdict)}</span> ${h(c.scenario_id)} <small>${h(c.execution_profile)}</small></h2>
<p>Requirements: ${h(c.requirement_ids.join(', '))} · attempt <code>${h(c.attempt_id)}</code>${c.critical ? ' · <strong>critical</strong>' : ''}</p>
${c.reason ? `<p class="reason">Reason: <code>${h(c.reason)}</code> — ${h(c.message)}</p>` : ''}
<p>Milestones completed: ${h(c.milestones_completed.join(' → ') || 'none')} · cleanup: ${h(c.cleanup.status)} ${h(c.cleanup.detail)}</p>
<table><thead><tr><th>Milestone</th><th>#</th><th>Assertion</th><th>Status</th><th>Expected</th><th>Actual</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
<div class="artifacts">${artifacts}</div></section>`;
}

/** Self-contained HTML report; artifact links are relative to the report directory. */
export function toHtml(report: RunReport): string {
  const counts = report.cases.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }), {});
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA run ${h(report.run_id)}</title><style>
:root{--bg:#fff;--fg:#1b1b1f;--muted:#666;--line:#ddd;--pass:#05603a;--fail:#a4001d;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#eee;--muted:#aaa;--line:#333;--pass:#5fd49a;--fail:#ff7a8a;--warn:#f0b64d}}
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1100px;background:var(--bg);color:var(--fg)}
table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
tr.failed td{color:var(--fail)}tr.not_run td{color:var(--muted)}.v{font-weight:700;padding:0 6px;border-radius:4px;border:1px solid}
.PASS{color:var(--pass)}.FAIL,.ERROR,.BLOCKED{color:var(--fail)}.FLAKY,.NEEDS_REVIEW,.SUPERSEDED,.CANCELLED{color:var(--warn)}
.case{border-top:2px solid var(--line);margin-top:24px}img{max-width:320px;border:1px solid var(--line)}figure{display:inline-block;margin:4px}
code{word-break:break-all}</style></head><body>
<h1>QA run <code>${h(report.run_id)}</code></h1>
<p>Target <code>${h(report.base_url)}</code> · environment <code>${h(report.environment)}</code> · commit <code>${h(report.commit_sha ?? 'unverified')}</code></p>
<p>Gate: <strong class="${report.gate.eligible ? 'PASS' : 'FAIL'}">${report.gate.eligible ? 'ELIGIBLE' : 'HELD'}</strong>
${report.gate.reasons.length ? `<ul>${report.gate.reasons.map((r) => `<li>${h(r)}</li>`).join('')}</ul>` : ''}</p>
<p>${Object.entries(counts).map(([k, n]) => `<span class="v ${h(k)}">${h(k)} ${n}</span>`).join(' ')}</p>
<p><small>A PASS covers only the listed requirements and assertions under the pinned contract. It says nothing about untested behaviour.</small></p>
${report.cases.map(caseSection).join('')}
</body></html>`;
}
