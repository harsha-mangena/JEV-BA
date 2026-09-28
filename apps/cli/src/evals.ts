import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CalibrationRegistry, calibrate, canary, DecisionConfig, extractDecisions, LabeledDecision, qualify, QualificationRegistry, type CalibrationVersion, type QualificationEvidence } from '@qa/calibration';
import { UsageError, type ServiceArgs } from './service.ts';

async function readJsonl<T>(path: string, parse: (v: unknown) => T): Promise<T[]> {
  return (await readFile(resolve(path), 'utf8')).split('\n').filter(Boolean).map((l) => parse(JSON.parse(l)));
}

export async function evals(sub: string | undefined, a: ServiceArgs): Promise<number> {
  if (sub === 'extract') {
    const runs = (Array.isArray(a.run) ? a.run : a.run ? [a.run] : []) as string[];
    if (!runs.length || !a['decision-config'] || !a.app) throw new UsageError('usage: qa evals extract --run <dir>... --app <app id> --decision-config <file.json> [--labels <out.jsonl>]');
    const cfg = DecisionConfig.parse(JSON.parse(await readFile(resolve(a['decision-config'] as string), 'utf8')));
    const rows = (await Promise.all(runs.map((r) => extractDecisions(resolve(r), a.app as string, cfg)))).flat();
    const text = rows.map((r) => JSON.stringify({ ...r, label: { category: null }, annotations: [] })).join('\n');
    if (a.labels) await writeFile(resolve(a.labels as string), `${text}\n`);
    else console.log(text);
    console.error(`${rows.length} decision(s) extracted for labeling`);
    return 0;
  }
  if (sub === 'canary') {
    if (!a.labels) throw new UsageError('usage: qa evals canary --labels <labels.jsonl> [--registry <dir>]');
    const v = await new CalibrationRegistry(resolve(a.registry as string)).current();
    if (!v) throw new UsageError('no current calibration');
    const r = canary(v, await readJsonl(a.labels as string, (x) => LabeledDecision.parse(x)));
    console.log(JSON.stringify(r, null, 2));
    return r.drift ? 1 : 0;
  }
  throw new UsageError('usage: qa evals extract|canary');
}

export async function calibrateCmd(a: ServiceArgs): Promise<number> {
  const target = Number(a.target);
  if (!a.labels || !(target > 0 && target < 1)) throw new UsageError('usage: qa calibrate --labels <labels.jsonl> --target <precision, e.g. 0.99> [--registry <dir>]');
  const data = await readJsonl(a.labels as string, (x) => LabeledDecision.parse(x));
  if (!data.length) throw new UsageError('no labeled decisions');
  const v = calibrate(data, { target_precision: target, decision_config: data[0]!.decision_config });
  const dir = resolve(a.registry as string);
  await new CalibrationRegistry(dir).save(v);
  const t = v.report.test_band;
  console.log(`calibration ${v.id} → ${dir}`);
  console.log(`samples: ${JSON.stringify(v.report.sample_counts)}`);
  console.log(`threshold: ${v.threshold ?? 'none (advisory only)'}; held-out precision ${t ? `${t.precision.toFixed(4)} (lower ${t.precision_lower.toFixed(4)}, cluster p05 ${t.precision_cluster_p05.toFixed(4)}) at coverage ${t.coverage.toFixed(3)}` : 'n/a'}`);
  console.log(`ECE ${v.report.ece.toFixed(4)}, Brier ${v.report.brier.toFixed(4)}, observation failures ${(v.report.observation_failure_rate * 100).toFixed(1)}%`);
  console.log(`supported cohorts: ${v.supported_cohorts.join(', ') || 'none'}`);
  for (const l of v.report.limitations) console.log(`note: ${l}`);
  return 0;
}

/**
 * Decide whether a calibration may drive calibrated autonomy for one profile
 * and record the decision (`qa qualify`). Evidence file (JSON): { provider_compat,
 * dataset: { source, applications, labeled_decisions, double_label_agreement },
 * episodes: { attempted, verified_success, false_pass } }. Exit 0 only when qualified.
 */
export async function qualifyCmd(a: ServiceArgs): Promise<number> {
  const need = (k: string) => {
    const v = a[k];
    if (typeof v !== 'string' || !v) throw new UsageError(`--${k} is required`);
    return v;
  };
  const calibration = JSON.parse(await readFile(need('calibration'), 'utf8')) as CalibrationVersion;
  const ev = JSON.parse(await readFile(need('evidence'), 'utf8')) as Omit<QualificationEvidence, 'calibration'>;
  const record = qualify({ project_id: need('project'), environment: need('environment'), application: need('application'), resolved_model: calibration.decision_config.model }, { ...ev, calibration });
  await new QualificationRegistry(need('qualifications')).save(record);
  console.log(`${record.state}: ${record.id}`);
  for (const r of record.reasons) console.log(`  - ${r}`);
  return record.state === 'QUALIFIED_FOR_PROFILE' ? 0 : 1;
}
