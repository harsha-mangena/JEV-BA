import { parseDefectList } from './defects.ts';
import { startFixtureApp } from './server.ts';

const token = process.env.QA_FIXTURE_TOKEN;
if (!token) {
  console.error('QA_FIXTURE_TOKEN must be set (at least 16 characters) to expose the fixture API.');
  process.exit(2);
}
const app = await startFixtureApp({
  port: Number(process.env.PORT ?? 4310),
  host: process.env.HOST ?? '127.0.0.1',
  fixtureToken: token,
  defects: parseDefectList(process.env.FIXTURE_DEFECTS),
  commitSha: process.env.FIXTURE_COMMIT_SHA,
  checkoutDelayMs: Number(process.env.FIXTURE_CHECKOUT_DELAY_MS ?? 0),
});
console.log(`fixture app listening on ${app.url} (defects: ${[...app.defects].join(', ') || 'none'})`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
