export interface ServiceEnvironment {
  readonly [key: string]: string | undefined;
  SERVICE_NAME?: string;
  BUILD_REVISION?: string;
  GITHUB_SHA?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
}

export interface HealthPayload {
  service: string;
  revision: string;
}

export interface ReadinessPayload extends HealthPayload {
  ready: boolean;
}

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessOptions {
  environment?: ServiceEnvironment;
  timeoutMs?: number;
}

const DEFAULT_SERVICE = 'hollowmere-web';
const DEFAULT_REVISION = 'development';
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export function serviceIdentity(
  environment: ServiceEnvironment = process.env,
): HealthPayload {
  return {
    service: firstNonEmpty(environment.SERVICE_NAME) ?? DEFAULT_SERVICE,
    revision: firstNonEmpty(
      environment.BUILD_REVISION,
      environment.GITHUB_SHA,
      environment.VERCEL_GIT_COMMIT_SHA,
    ) ?? DEFAULT_REVISION,
  };
}

export function createLivenessHandler(
  environment: ServiceEnvironment = process.env,
): () => Promise<Response> {
  return async () => Response.json(serviceIdentity(environment), {
    headers: { 'cache-control': 'no-store' },
  });
}

export function createReadinessHandler(
  check: ReadinessCheck,
  options: ReadinessOptions = {},
): () => Promise<Response> {
  const timeoutMs = positiveTimeout(options.timeoutMs);

  return async () => {
    const identity = serviceIdentity(options.environment);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('readiness check timed out')),
            timeoutMs,
          );
        }),
      ]);
      return Response.json({ ...identity, ready: true } satisfies ReadinessPayload, {
        headers: { 'cache-control': 'no-store' },
      });
    } catch {
      return Response.json({ ...identity, ready: false } satisfies ReadinessPayload, {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

function positiveTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('readiness timeout must be a positive integer');
  }
  return value;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}
