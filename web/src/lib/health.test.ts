import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createLivenessHandler, createReadinessHandler, serviceIdentity,
} from './health.ts';

const environment = {
  SERVICE_NAME: 'hollowmere-web-test',
  BUILD_REVISION: '036cf43',
};

describe('health handlers', () => {
  test('liveness reports only service identity and never touches dependencies', async () => {
    const response = await createLivenessHandler(environment)();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      service: 'hollowmere-web-test',
      revision: '036cf43',
    });
  });

  test('readiness returns 200 after its dependency succeeds', async () => {
    let checks = 0;
    const response = await createReadinessHandler(async () => {
      checks++;
    }, { environment, timeoutMs: 100 })();

    assert.equal(checks, 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      service: 'hollowmere-web-test',
      revision: '036cf43',
      ready: true,
    });
  });

  test('readiness returns a generic 503 when its dependency fails', async () => {
    const response = await createReadinessHandler(async () => {
      throw new Error('postgresql://secret@private-host/hollowmere');
    }, { environment, timeoutMs: 100 })();

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      service: 'hollowmere-web-test',
      revision: '036cf43',
      ready: false,
    });
  });

  test('readiness is bounded when its dependency never settles', async () => {
    const startedAt = Date.now();
    const response = await createReadinessHandler(
      () => new Promise<void>(() => {}),
      { environment, timeoutMs: 10 },
    )();

    assert.equal(response.status, 503);
    assert.ok(Date.now() - startedAt < 1_000);
  });

  test('service identity has safe local defaults and stable revision fallbacks', () => {
    assert.deepEqual(serviceIdentity({}), {
      service: 'hollowmere-web',
      revision: 'development',
    });
    assert.equal(serviceIdentity({ GITHUB_SHA: 'github-sha' }).revision, 'github-sha');
    assert.equal(
      serviceIdentity({ VERCEL_GIT_COMMIT_SHA: 'vercel-sha' }).revision,
      'vercel-sha',
    );
  });
});
