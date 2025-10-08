import { z } from 'zod';

const csvToArray = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const isValidUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8787),
    SESSION_TTL_MS: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || val.trim() === '') {
          return undefined;
        }
        const parsed = Number.parseInt(val, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error('SESSION_TTL_MS must be a non-negative integer');
        }
        return parsed;
      }),
    CORS_ALLOW_ORIGINS: z
      .string()
      .optional()
      .transform((val) => csvToArray(val)),
    CANVAS_BASE_URL: z
      .string()
      .optional()
      .refine((val) => !val || isValidUrl(val), {
        message: 'CANVAS_BASE_URL must be a valid URL',
      }),
    CANVAS_TOKEN: z.string().optional(),
    DISABLE_HTTP_LISTEN: z.enum(['0', '1']).default('0'),
    DEBUG_TOKEN: z.string().optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  })
  .passthrough();

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Configuration error:', parsed.error.format());
  process.exit(1);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  sessionTtlMs: env.SESSION_TTL_MS,
  corsAllowOrigins: env.CORS_ALLOW_ORIGINS,
  canvasBaseUrl: env.CANVAS_BASE_URL,
  canvasToken: env.CANVAS_TOKEN,
  disableHttpListen: env.DISABLE_HTTP_LISTEN === '1',
  debugToken: env.DEBUG_TOKEN,
  logLevel: env.LOG_LEVEL,
  logFormat: env.LOG_FORMAT,
};

export type AppConfig = typeof config;

export function getSanitizedCanvasToken(): string | undefined {
  return (config.canvasToken ?? '').trim() || undefined;
}
