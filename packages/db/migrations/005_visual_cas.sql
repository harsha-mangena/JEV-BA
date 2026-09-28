-- Completion phase 8: baseline approvals are compare-and-set; one approval per baseline version.
create unique index baseline_approvals_version on baseline_approvals(project_id, scenario_id, checkpoint, execution_profile, rendering_profile, version);
