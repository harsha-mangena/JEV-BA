import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from '@qa/orchestrator';

/** Routes added by later phases (reviews, onboarding, dashboard) are registered here. */
export async function registerServiceRoutes(_app: FastifyInstance, _orch: Orchestrator): Promise<void> {}
