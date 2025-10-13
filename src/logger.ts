import util from 'node:util';
import { config } from './config.js';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN = /(authorization|token|bearer|password|secret|api(?:_|-)?key|cookie|session|key|ssn|card)/i;
const REDACTED_VALUE = '[REDACTED]';

const parseLogLevel = (value: string | undefined): LogLevel => {
  const candidate = (value ?? 'info').toLowerCase();
  return LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : 'info';
};

let currentLevel: LogLevel = parseLogLevel(config.logLevel);

const sanitize = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  seen.set(value, '[Circular]');

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    const result = arr.map((entry): unknown => sanitize(entry, seen));
    seen.set(value, result);
    return result;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (value instanceof Map) {
    const mapped = Object.create(null) as Record<string, unknown>;
    for (const [rawKey, entry] of value.entries()) {
      const key = typeof rawKey === 'string' ? rawKey : String(rawKey);
      const sanitizedEntry = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_VALUE : sanitize(entry, seen);
      Reflect.defineProperty(mapped, key, {
        value: sanitizedEntry,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    seen.set(value, mapped);
    return mapped;
  }

  if (value instanceof Set) {
    const result = Array.from(value.values()).map((entry): unknown => sanitize(entry, seen));
    seen.set(value, result);
    return result;
  }

  if (value instanceof Error) {
    const entries: [string, unknown][] = [
      ['name', value.name],
      ['message', value.message],
    ];
    if (value.stack) {
      entries.push(['stack', value.stack]);
    }
    if ('cause' in value) {
      entries.push(['cause', (value as { cause?: unknown }).cause]);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
        continue;
      }
      entries.push([key, entry]);
    }
    const errorObject = Object.fromEntries(entries);
    seen.set(value, errorObject);
    return sanitize(errorObject, seen);
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const sanitizedValue = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED_VALUE
      : sanitize((value as Record<string, unknown>)[key], seen);
    Reflect.defineProperty(result, key, {
      value: sanitizedValue,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  seen.set(value, result);
  return result;
};

const sanitizeData = (data?: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (!data) {
    return undefined;
  }
  const sanitized = sanitize(data, new WeakMap()) as Record<string, unknown> | string | unknown[];
  if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
    return sanitized;
  }
  return { data: sanitized };
};

const formatPayload = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
  const redactedMeta = sanitizeData(data);
  const base = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...(redactedMeta ?? {}),
  };

  if (config.logFormat === 'pretty') {
    const { level: lvl, timestamp, message: msg, ...rest } = base;
    const meta = Object.keys(rest).length
      ? ` ${util.inspect(rest, { depth: 4, colors: false })}`
      : '';
    return `[${timestamp}] ${lvl.toUpperCase()} ${msg}${meta}`;
  }

  return JSON.stringify(base);
};

const write = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
  if (levelPriority[level] < levelPriority[currentLevel]) {
    return;
  }
  const formatted = formatPayload(level, message, data);
  if (level === 'error') {
    console.error(formatted);
  } else if (level === 'warn') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
};

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) => write('debug', message, data),
  info: (message: string, data?: Record<string, unknown>) => write('info', message, data),
  warn: (message: string, data?: Record<string, unknown>) => write('warn', message, data),
  error: (message: string, data?: Record<string, unknown>) => write('error', message, data),
  setLevel: (level: LogLevel) => {
    currentLevel = parseLogLevel(level);
  },
};

export default logger;
