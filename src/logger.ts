import util from 'node:util';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined)?.toLowerCase() === 'debug'
    ? 'debug'
    : (process.env.LOG_LEVEL as LogLevel | undefined)?.toLowerCase() === 'info'
      ? 'info'
      : (process.env.LOG_LEVEL as LogLevel | undefined)?.toLowerCase() === 'warn'
        ? 'warn'
        : 'info';

const formatPayload = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
  const base = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...data,
  };

  if (process.env.LOG_FORMAT === 'pretty') {
    const { level: lvl, timestamp, ...rest } = base;
    const meta = Object.keys(rest).length ? ` ${util.inspect(rest, { depth: null, colors: true })}` : '';
    return `[${timestamp}] ${lvl.toUpperCase()} ${message}${meta}`;
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
    currentLevel = level;
  },
};

export default logger;
