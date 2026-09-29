-- Re-audit R2: the complete execution contract.
--
-- runs.suite_revision now holds the digest of the full typed execution
-- contract stored in runs.execution_snapshot (suite files and settings,
-- environment policy, oracle/adapter identity and endpoint, verification
-- settings, frozen approved baselines, rendering identities). The frozen
-- selection manifest has its own identity, checked at execution and at
-- promotion; decisions record both.

alter table runs add column selection_digest text;
alter table promotion_decisions add column selection_digest text;
