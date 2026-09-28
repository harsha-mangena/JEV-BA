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
  /**
   * End of the authorization (re-audit R5): the qualification is only as
   * fresh as its live provider-compatibility evidence, so it expires
   * `max_compat_age_days` after that evidence was checked. Enforced on every
   * lookup, never only at qualification time. Null when not qualified.
   */
  expires_at: string | null;
}

export interface Revocation {
  qualification_id: string;
  revoked_by: string;
  reason: string;
  revoked_at: string;
}

/** Why a stored record does not authorize calibrated dispatch right now (empty → it does). */
export function authorizationProblems(r: QualificationRecord, now: Date, revoked: boolean): string[] {
  const out: string[] = [];
  if (r.state !== 'QUALIFIED_FOR_PROFILE') out.push(`state is ${r.state}`);
  if (revoked) out.push('revoked');
  const exp = r.expires_at ? Date.parse(r.expires_at) : NaN;
  if (!Number.isFinite(exp)) out.push('no valid expiry');
  else if (now.getTime() >= exp) out.push(`expired at ${r.expires_at}`);
  return out;
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
  const expiresAt = state === 'QUALIFIED_FOR_PROFILE' ? new Date(Date.parse(e.provider_compat!.checked_at) + c.max_compat_age_days * 86_400_000).toISOString() : null;
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
    expires_at: expiresAt,
  };
}

/**
 * File registry of qualification decisions (append-only history, one current
 * record per profile) with revocations. Authorization is time-bounded:
 * `find` returns a record only while it is qualified, unexpired and not
 * revoked at the registry clock's current time; corrupt or unreadable records
 * never authorize anything.
 */
export class QualificationRegistry {
  constructor(
    readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async save(r: QualificationRecord): Promise<void> {
    await mkdir(join(this.dir, 'history'), { recursive: true });
    await writeFile(join(this.dir, 'history', `${r.id}.${r.decided_at.replace(/[:.]/g, '-')}.json`), JSON.stringify(r, null, 2));
    await writeFile(join(this.dir, `${r.id}.json`), JSON.stringify(r, null, 2));
  }

  /** Readable current records (corrupt files are skipped: they authorize nothing). */
  async all(): Promise<QualificationRecord[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
    const out: QualificationRecord[] = [];
    for (const f of files) {
      try {
        const r = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as QualificationRecord;
        if (r && typeof r === 'object' && typeof r.id === 'string' && r.profile && typeof r.calibration_id === 'string') out.push(r);
      } catch {
        /* unreadable: never authorizes */
      }
    }
    return out;
  }

  async revoke(qualificationId: string, by: string, reason: string): Promise<Revocation> {
    if (!by.trim() || !reason.trim()) throw new Error('a revocation names who revoked and why');
    const rev: Revocation = { qualification_id: qualificationId, revoked_by: by, reason, revoked_at: this.clock().toISOString() };
    await mkdir(join(this.dir, 'revocations'), { recursive: true });
    await writeFile(join(this.dir, 'revocations', `${qualificationId}.json`), JSON.stringify(rev, null, 2));
    return rev;
  }

  async isRevoked(qualificationId: string): Promise<boolean> {
    // Fail closed: a revocation file that exists but cannot be read still revokes.
    return readFile(join(this.dir, 'revocations', `${qualificationId}.json`), 'utf8').then(
      () => true,
      (e: NodeJS.ErrnoException) => e.code !== 'ENOENT',
    );
  }

  /** The qualification that allows `calibration` to act for this profile right now, or null. */
  async find(profile: QualificationProfile, calibration: Pick<CalibrationVersion, 'id' | 'decision_config_digest'>): Promise<QualificationRecord | null> {
    const now = this.clock();
    for (const r of await this.all()) {
      if (
        r.calibration_id !== calibration.id ||
        r.decision_config_digest !== calibration.decision_config_digest ||
        r.profile.project_id !== profile.project_id ||
        r.profile.environment !== profile.environment ||
        r.profile.application !== profile.application ||
        r.profile.resolved_model !== profile.resolved_model
      )
        continue;
      if (authorizationProblems(r, now, await this.isRevoked(r.id)).length === 0) return r;
    }
    return null;
  }

  /**
   * Extend a qualification with fresh live compatibility evidence. Only a
   * probe that validated against the exact qualified model renews it; the
   * renewal is a new record in history. Anything else leaves the (expiring)
   * record as it is and says why.
   */
  async renew(qualificationId: string, compat: NonNullable<QualificationEvidence['provider_compat']>): Promise<{ renewed: true; record: QualificationRecord } | { renewed: false; reason: string }> {
    const r = (await this.all()).find((x) => x.id === qualificationId);
    if (!r) return { renewed: false, reason: 'no such qualification' };
    if (r.state !== 'QUALIFIED_FOR_PROFILE') return { renewed: false, reason: `qualification is ${r.state}` };
    if (await this.isRevoked(r.id)) return { renewed: false, reason: 'qualification is revoked' };
    if (!compat.ok) return { renewed: false, reason: 'the live provider probe did not validate' };
    if (compat.resolved_model !== r.profile.resolved_model) return { renewed: false, reason: `the live provider resolved ${compat.resolved_model ?? 'no model'}, not ${r.profile.resolved_model}` };
    const now = this.clock();
    const checked = Date.parse(compat.checked_at);
    if (!Number.isFinite(checked) || checked > now.getTime() || now.getTime() - checked > r.criteria.max_compat_age_days * 86_400_000) return { renewed: false, reason: 'the compatibility evidence is not current' };
    const record: QualificationRecord = {
      ...r,
      evidence_summary: { ...r.evidence_summary, provider_compat: compat },
      decided_at: now.toISOString(),
      expires_at: new Date(checked + r.criteria.max_compat_age_days * 86_400_000).toISOString(),
    };
    await this.save(record);
    return { renewed: true, record };
  }
}
