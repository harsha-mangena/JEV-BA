import type { Db } from '@qa/db';
import type { EffectReceipt } from '@qa/oracles';
import { FenceLost, IllegalTransition, INTENT_TRANSITIONS, UNRESOLVED, type IntentRecord, type IntentState, type IntentStore } from '@qa/worker';

export interface IntentScope {
  tenant_id: string;
  run_id: string;
  run_attempt: number;
  shard: number;
  job_id: string;
  fence: number;
}

/** Holds only while the job is still leased under this exact fence and the lease has not expired. */
const FENCED = `exists (select 1 from jobs where id = $FENCE_JOB and fence = $FENCE and state = 'leased' and lease_expires_at > now())`;
const fenced = (sql: string, jobParam: number, fenceParam: number) => sql.replace('$FENCE_JOB', `$${jobParam}`).replace('$FENCE', `$${fenceParam}`);

interface Row {
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

  async prepare(r: Omit<IntentRecord, 'state' | 'detail' | 'receipts'>): Promise<void> {
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

  async unresolved(): Promise<IntentRecord[]> {
    const s = this.scope;
    const rows = (await this.db.query<Row>(`select * from action_intents where run_id=$1 and run_attempt=$2 and shard=$3 and fence < $4 and state = any($5) order by created_at`, [s.run_id, s.run_attempt, s.shard, s.fence, UNRESOLVED])).rows;
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
    };
  }
}
