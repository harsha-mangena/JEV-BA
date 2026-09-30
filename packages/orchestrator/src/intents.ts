import type { Db } from '@qa/db';
import type pg from 'pg';
import type { EffectReceipt } from '@qa/oracles';
import { FenceLost, IllegalTransition, INTENT_TRANSITIONS, UNRESOLVED, type Adjudication, type IntentRecord, type IntentState, type IntentStore, type NewIntent } from '@qa/worker';

export interface IntentScope {
  tenant_id: string;
  run_id: string;
  run_attempt: number;
  shard: number;
  job_id: string;
  fence: number;
  /** The cases this job executes: intents any earlier attempt left for them are this job's to recover. */
  cases?: Array<{ scenario_id: string; execution_profile: string }>;
}

/** The job that recorded the intent still holds its lease under the same fence (the effect may be in progress). */
const LIVE = `exists (select 1 from jobs j where j.id = ai.job_id and j.fence = ai.fence and j.state = 'leased' and j.lease_expires_at > now())`;
/** Recovery must act: unresolved lifecycle, or a mutation acknowledged but never confirmed or settled. */
const NEEDS_RECOVERY = `(ai.state = any($UNRESOLVED) or (ai.state = 'ACKNOWLEDGED' and ai.effect <> 'none'))`;
/** Holds the run: needs recovery, or waits for review with no adjudication. */
const OUTSTANDING = `(${NEEDS_RECOVERY} or (ai.state = 'NEEDS_REVIEW' and ai.adjudication is null))`;

export interface Obligation {
  intent_id: string;
  run_id: string;
  run_attempt: number;
  scenario_id: string;
  execution_profile: string;
  contract_intent: string | null;
  state: IntentState;
  detail: string | null;
  /** Recorded by a job that is still leased: the effect may still be in progress. */
  live: boolean;
}

/**
 * Every effect obligation still open for a deployment (all runs, attempts,
 * fences and shards). With `includeLive: false`, intents of jobs that still
 * hold their lease are left out — they are in progress, not abandoned — but a
 * review is never left out.
 */
export async function outstandingObligations(q: { query: pg.ClientBase['query'] } | Db, deploymentId: string, o: { includeLive: boolean }): Promise<Obligation[]> {
  const rows = (
    await (q as pg.ClientBase).query<Obligation>(
      `select ai.intent_id, ai.run_id, ai.run_attempt, ai.scenario_id, ai.execution_profile, ai.contract_intent, ai.state, ai.detail, ${LIVE} as live
       from action_intents ai where ai.run_id in (select id from runs where deployment_id = $1) and ${OUTSTANDING.replace('$UNRESOLVED', '$2')}
       order by ai.created_at`,
      [deploymentId, UNRESOLVED],
    )
  ).rows;
  return o.includeLive ? rows : rows.filter((r) => !r.live || r.state === 'NEEDS_REVIEW');
}

export const OBLIGATION_PREFIX = 'effect obligation ';
export const describeObligation = (x: Obligation) =>
  `${OBLIGATION_PREFIX}${x.intent_id} (${x.contract_intent ?? 'effect'} in ${x.scenario_id}@${x.execution_profile}, run ${x.run_id} attempt ${x.run_attempt}) is ${x.state}${x.live ? ' and still in progress' : x.state === 'NEEDS_REVIEW' ? ' with no adjudication' : ''}`;

/** Holds only while the job is still leased under this exact fence and the lease has not expired. */
const FENCED = `exists (select 1 from jobs where id = $FENCE_JOB and fence = $FENCE and state = 'leased' and lease_expires_at > now())`;
const fenced = (sql: string, jobParam: number, fenceParam: number) => sql.replace('$FENCE_JOB', `$${jobParam}`).replace('$FENCE', `$${fenceParam}`);

interface Row {
  adjudication: Adjudication | null;
  intent_id: string;
  attempt_id: string;
  scenario_id: string;
  execution_profile: string;
  owner: string | null;
  idempotency_key: string | null;
  effect: string;
  mutation: string | null;
  contract_intent: string | null;
  state: IntentState;
  detail: string | null;
  data: Record<string, unknown>;
}

/**
 * PostgreSQL intent store for one leased shard. Every write is fenced: a
 * worker whose lease was lost or re-granted cannot record intents, and so
 * cannot dispatch (PREPARED and DISPATCHING must be written before input).
 */
export class PgIntentStore implements IntentStore {
  constructor(
    private readonly db: Db,
    private readonly scope: IntentScope,
  ) {}

  async prepare(r: NewIntent): Promise<void> {
    const s = this.scope;
    await this.db.tx(async (c) => {
      const ins = await c.query(
        fenced(
          `insert into action_intents(intent_id, tenant_id, run_id, run_attempt, shard, job_id, fence, attempt_id, scenario_id, execution_profile, owner, idempotency_key, effect, mutation, contract_intent, state, data)
           select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PREPARED',$16 where ${FENCED}`,
          6,
          7,
        ),
        [r.intent_id, s.tenant_id, s.run_id, s.run_attempt, s.shard, s.job_id, s.fence, r.attempt_id, r.scenario_id, r.execution_profile, r.owner, r.idempotency_key, r.effect, r.mutation, r.contract_intent, JSON.stringify(r.data)],
      );
      if (ins.rowCount === 0) throw new FenceLost(`job ${s.job_id} is no longer leased under fence ${s.fence}`);
      await c.query('insert into intent_transitions(intent_id, from_state, to_state, fence) values ($1, null, $2, $3)', [r.intent_id, 'PREPARED', s.fence]);
    });
  }

  async transition(intentId: string, to: IntentState, detail: string | null = null, receipts: EffectReceipt[] = []): Promise<void> {
    const s = this.scope;
    await this.db.tx(async (c) => {
      const cur = (await c.query<{ state: IntentState }>('select state from action_intents where intent_id=$1 for update', [intentId])).rows[0];
      if (!cur) throw new IllegalTransition(`unknown intent ${intentId}`);
      if (!INTENT_TRANSITIONS[cur.state].includes(to)) throw new IllegalTransition(`${intentId}: ${cur.state} → ${to} is not a legal transition`);
      const up = await c.query(fenced(`update action_intents set state=$2, detail=$3, updated_at=now() where intent_id=$1 and ${FENCED}`, 4, 5), [intentId, to, detail, s.job_id, s.fence]);
      if (up.rowCount === 0) throw new FenceLost(`job ${s.job_id} is no longer leased under fence ${s.fence}`);
      await c.query('insert into intent_transitions(intent_id, from_state, to_state, fence, detail) values ($1,$2,$3,$4,$5)', [intentId, cur.state, to, s.fence, detail]);
      for (const r of receipts) {
        await c.query('insert into effect_receipts(intent_id, kind, entity_id, owner, idempotency_key) values ($1,$2,$3,$4,$5) on conflict do nothing', [intentId, r.kind, r.entity_id, r.owner, r.idempotency_key]);
      }
    });
  }

  /**
   * What this job must recover before it runs: intents an earlier lease of
   * this shard left behind, plus anything any earlier attempt of the run left
   * for this job's cases — never an intent whose job still holds its lease.
   */
  async unresolved(): Promise<IntentRecord[]> {
    return this.scoped(NEEDS_RECOVERY.replace('$UNRESOLVED', '$4'));
  }

  /** Obligations still open for this job's work, from any fence or attempt (reviews included). */
  async outstanding(): Promise<IntentRecord[]> {
    return this.scoped(OUTSTANDING.replace('$UNRESOLVED', '$4'));
  }

  /** This run's open obligations for one case, including this job's own attempts (not other jobs still in progress). */
  async openFor(scenarioId: string, executionProfile: string): Promise<IntentRecord[]> {
    const s = this.scope;
    const rows = (
      await this.db.query<Row>(
        `select ai.* from action_intents ai
         where ai.run_id = $1 and ai.scenario_id = $2 and ai.execution_profile = $3 and ${OUTSTANDING.replace('$UNRESOLVED', '$5')}
           and (ai.job_id = $4 or not ${LIVE})
         order by ai.created_at`,
        [s.run_id, scenarioId, executionProfile, s.job_id, UNRESOLVED],
      )
    ).rows;
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  private async scoped(condition: string): Promise<IntentRecord[]> {
    const s = this.scope;
    const rows = (
      await this.db.query<Row>(
        `select ai.* from action_intents ai
         where ai.run_id = $1 and not (ai.job_id = $2 and ai.fence = $3) and not ${LIVE} and ${condition}
           and ((ai.run_attempt = $5 and ai.shard = $6) or (ai.scenario_id, ai.execution_profile) in (select x->>'scenario_id', x->>'execution_profile' from jsonb_array_elements($7::jsonb) x))
         order by ai.created_at`,
        [s.run_id, s.job_id, s.fence, UNRESOLVED, s.run_attempt, s.shard, JSON.stringify(s.cases ?? [])],
      )
    ).rows;
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async get(intentId: string): Promise<IntentRecord | undefined> {
    const r = await this.db.one<Row>('select * from action_intents where intent_id=$1', [intentId]);
    return r ? this.hydrate(r) : undefined;
  }

  private async hydrate(r: Row): Promise<IntentRecord> {
    const receipts = (await this.db.query<EffectReceipt>('select kind, entity_id, owner, idempotency_key, null as created_at from effect_receipts where intent_id=$1 order by id', [r.intent_id])).rows;
    return {
      intent_id: r.intent_id,
      attempt_id: r.attempt_id,
      scenario_id: r.scenario_id,
      execution_profile: r.execution_profile,
      owner: r.owner,
      idempotency_key: r.idempotency_key,
      effect: r.effect,
      mutation: r.mutation,
      contract_intent: r.contract_intent,
      state: r.state,
      detail: r.detail,
      receipts,
      data: r.data,
      adjudication: r.adjudication,
    };
  }
}
