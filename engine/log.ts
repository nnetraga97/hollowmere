export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel | 'silent' {
  const value = process.env.LOG_LEVEL?.toLowerCase();
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : value === 'silent' ? 'silent' : 'info';
}

function enabled(level: LogLevel): boolean {
  const threshold = configuredLevel();
  return threshold !== 'silent' && LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[threshold];
}

function serviceName(): string {
  return process.env.SERVICE_NAME ?? 'hollowmere';
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (!enabled(level)) return;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: serviceName(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export function logEntry(entry: LogFields & { level: LogLevel; event: string }): void {
  const { level, event, ...fields } = entry;
  log(level, event, fields);
}

export function logDebug(event: string, fields?: LogFields): void {
  log('debug', event, fields);
}

export function logInfo(event: string, fields?: LogFields): void {
  log('info', event, fields);
}

export function logWarn(event: string, fields?: LogFields): void {
  log('warn', event, fields);
}

export function logError(event: string, fields?: LogFields): void {
  log('error', event, fields);
}

export function errorLogFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorMessage: String(error) };
  const extended = error as Error & {
    code?: unknown;
    status?: unknown;
    requestID?: unknown;
  };
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(typeof extended.code === 'string' ? { errorCode: extended.code } : {}),
    ...(typeof extended.status === 'number' ? { errorStatus: extended.status } : {}),
    ...(typeof extended.requestID === 'string' ? { providerRequestId: extended.requestID } : {}),
    ...(error.stack ? { errorStack: error.stack } : {}),
  };
}
