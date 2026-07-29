/**
 * Opt-in gate for the long-running arc tests.
 *
 * Three tests drive the simulation across its full length — the canonical
 * unattended run to war (360 ticks), stage monotonicity (400), and the scripted
 * reconciliation to peace (up to 160). They are the tests that prove the town
 * actually behaves, so they are not deletable; they are also minutes long
 * against a local cluster, because a tick issues one query per rumor-holder.
 *
 * Everything else in the suite is seconds. Paying the arc cost on every run
 * makes the fast feedback loop unusable, so the arc tests run only when asked
 * for: `npm run test:full`, or `HOLLOWMERE_SLOW_TESTS=1 npm test`.
 *
 * They must still run before anything is called done — see `npm run check:full`.
 */
export const RUN_SLOW_TESTS = process.env.HOLLOWMERE_SLOW_TESTS === '1';

/**
 * Spread into a `test()` call as its options argument:
 *
 *     test('an unattended town destroys itself', slowTest, async () => { ... });
 *
 * Reports as skipped with the reason rather than silently vanishing, so a run
 * that skipped the arc cannot be mistaken for a run that passed it.
 */
export const slowTest: { skip?: string } = RUN_SLOW_TESTS
  ? {}
  : { skip: 'slow arc test — run `npm run test:full` or set HOLLOWMERE_SLOW_TESTS=1' };
