import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CalibrationVersion } from './registry.ts';

/**
 * Calibration qualification (completion phase 11). A calibration version may
 * drive `calibrated` autonomy only for the exact profile it was qualified for
 * — application contract, environment, resolved model — and only on evidence
 * that is representative, held out, live-verified and end-to-end safe.
 * Anything short of that is recorded as BLOCKED or LIVE_VERIFICATION_REQUIRED
 * with the reasons; nothing is inferred from fixture results.
 */
export interface QualificationProfile {
  project_id: string;
  environment: string;
  /** Application contract identity, e.g. `fixture-shop/2`. */
  application: string;
  /** Model identity that answered (not an alias). */
  resolved_model: string;
}

export interface QualificationEvidence {
  calibration: CalibrationVersion;
  /** Live provider compatibility record (qa s1 probe); absent when no live probe ran. */
  provider_compat: { ok: boolean; resolved_model: string | null; checked_at: string } | null;
  dataset: {
    /** Only `representative` data (real target-application decisions) can qualify. */
    source: 'representative' | 'fixture' | 'synthetic';
    applications: string[];
    labeled_decisions: number;
    /** Share of decisions with two independent labels that agree (label audit). */
    double_label_agreement: number | null;
  };
  /** End-to-end episodes run under the candidate calibration in shadow or staging. */
  episodes: { attempted: number; verified_success: number; false_pass: number } | null;
}

export interface QualificationCriteria {
  max_compat_age_days: number;
  min_double_label_agreement: number;
  min_episodes: number;
  min_episode_success: number;
}

export const DEFAULT_QUALIFICATION_CRITERIA: QualificationCriteria = { max_compat_age_days: 30, min_double_label_agreement: 0.9, min_episodes: 50, min_episode_success: 0.9 };

export type QualificationState = 'QUALIFIED_FOR_PROFILE' | 'LIVE_VERIFICATION_REQUIRED' | 'BLOCKED';

export interface QualificationRecord {
  id: string;
  profile: QualificationProfile;
  calibration_id: string;
  decision_config_digest: string;
  state: QualificationState;
  reasons: string[];
  evidence_summary: Record<string, unknown>;
  criteria: QualificationCriteria;
  decided_at: string;
}

export function qualify(profile: QualificationProfile, e: QualificationEvidence, c: QualificationCriteria = DEFAULT_QUALIFICATION_CRITERIA, now = new Date()): QualificationRecord {
  const blocked: string[] = [];
  const live: string[] = [];
  const cal = e.calibration;
  const test = cal.report.test_band;
  if (cal.threshold === null) blocked.push('calibration has no Act band (no threshold met the target on the selection split)');
  if (!test || test.accepted === 0) blocked.push('no accepted decisions on the held-out test split');
  else if (test.precision_lower < cal.target_precision) blocked.push(`held-out precision lower bound ${test.precision_lower.toFixed(4)} is below the target ${cal.target_precision}`);
  if (test && test.accepted < cal.report.zero_error_samples_needed) blocked.push(`only ${test.accepted} accepted held-out decisions; the target needs at least ${cal.report.zero_error_samples_needed}`);
  if (cal.decision_config.model !== profile.resolved_model) blocked.push(`calibration was fitted for model ${cal.decision_config.model}, not ${profile.resolved_model}`);
  if (e.dataset.source !== 'representative') blocked.push(`labeled data is ${e.dataset.source}, not representative decisions from the target application`);
  if (!e.dataset.applications.includes(profile.application)) blocked.push(`labeled data does not include application ${profile.application}`);
  if (e.dataset.double_label_agreement === null || e.dataset.double_label_agreement < c.min_double_label_agreement) blocked.push(`label audit agreement ${e.dataset.double_label_agreement ?? 'unmeasured'} is below ${c.min_double_label_agreement}`);
  if (!e.episodes || e.episodes.attempted < c.min_episodes) blocked.push(`${e.episodes?.attempted ?? 0} end-to-end episodes; at least ${c.min_episodes} are required`);
  else {
    if (e.episodes.false_pass > 0) blocked.push(`${e.episodes.false_pass} false pass(es) in end-to-end episodes`);
    if (e.episodes.verified_success / e.episodes.attempted < c.min_episode_success) blocked.push(`episode success ${(e.episodes.verified_success / e.episodes.attempted).toFixed(3)} is below ${c.min_episode_success}`);
  }
  if (!e.provider_compat) live.push('no live provider compatibility record (run qa s1 probe with credentials)');
  else {
    if (!e.provider_compat.ok) live.push('the live provider probe did not validate');
    if (e.provider_compat.resolved_model !== profile.resolved_model) live.push(`the live provider resolved ${e.provider_compat.resolved_model ?? 'no model'}, not ${profile.resolved_model}`);
    const age = (now.getTime() - Date.parse(e.provider_compat.checked_at)) / 86_400_000;
    if (!(age <= c.max_compat_age_days)) live.push(`the provider compatibility record is ${Number.isFinite(age) ? age.toFixed(1) : 'of unknown age'} days old (max ${c.max_compat_age_days})`);
  }
  const state: QualificationState = blocked.length ? 'BLOCKED' : live.length ? 'LIVE_VERIFICATION_REQUIRED' : 'QUALIFIED_FOR_PROFILE';
  return {
    id: `qual_${cal.id}_${profile.project_id}_${profile.environment}`.replace(/[^a-zA-Z0-9_.-]/g, '_'),
    profile,
    calibration_id: cal.id,
    decision_config_digest: cal.decision_config_digest,
    state,
    reasons: [...blocked, ...live],
    evidence_summary: {
      test_band: test,
      target_precision: cal.target_precision,
      threshold: cal.threshold,
      dataset: e.dataset,
      episodes: e.episodes,
      provider_compat: e.provider_compat,
    },
    criteria: c,
    decided_at: now.toISOString(),
  };
}

/** File registry of qualification decisions (append-only history, one current record per profile). */
export class QualificationRegistry {
  constructor(readonly dir: string) {}

  async save(r: QualificationRecord): Promise<void> {
    await mkdir(join(this.dir, 'history'), { recursive: true });
    await writeFile(join(this.dir, 'history', `${r.id}.${r.decided_at.replace(/[:.]/g, '-')}.json`), JSON.stringify(r, null, 2));
    await writeFile(join(this.dir, `${r.id}.json`), JSON.stringify(r, null, 2));
  }

  async all(): Promise<QualificationRecord[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(this.dir, f), 'utf8')) as QualificationRecord));
  }

  /** The qualification that allows `calibration` to act for this profile, or null. */
  async find(profile: QualificationProfile, calibration: Pick<CalibrationVersion, 'id' | 'decision_config_digest'>): Promise<QualificationRecord | null> {
    const hit = (await this.all()).find(
      (r) =>
        r.state === 'QUALIFIED_FOR_PROFILE' &&
        r.calibration_id === calibration.id &&
        r.decision_config_digest === calibration.decision_config_digest &&
        r.profile.project_id === profile.project_id &&
        r.profile.environment === profile.environment &&
        r.profile.application === profile.application &&
        r.profile.resolved_model === profile.resolved_model,
    );
    return hit ?? null;
  }
}
