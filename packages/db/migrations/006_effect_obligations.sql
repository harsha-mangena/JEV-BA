-- Re-audit R1: uncertain effects are obligations that hold the release gate.
--
-- SETTLED: an unkeyed mutation acknowledged by the application whose owning
-- attempt finished under its live lease. Anything a dead worker left
-- ACKNOWLEDGED is reconciled on recovery instead.
--
-- adjudication: an attributed human decision on an intent in NEEDS_REVIEW
-- ({resolution, by, note, at}). Until it is recorded the intent holds every
-- gate and promotion that relies on its run's deployment.

alter table action_intents drop constraint action_intents_state_check;
alter table action_intents add constraint action_intents_state_check
  check (state in ('PREPARED','DISPATCHING','NOT_DISPATCHED','ACKNOWLEDGED','EFFECT_CONFIRMED','EFFECT_UNKNOWN','RECONCILING','RECONCILED','SETTLED','NEEDS_REVIEW'));
alter table action_intents add column adjudication jsonb;

create index action_intents_run on action_intents(run_id, state);
