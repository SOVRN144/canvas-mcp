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

function num(env: string | undefined, def: number): number {
  const n = env ? Number(env) : NaN;
  return Number.isFinite(n) ? n : def;
}

function bool(env: string | undefined, def: boolean): boolean {
  if (env == null) return def;
  const v = env.trim().toLowerCase();
  if (['1','true','yes','y'].includes(v)) return true;
  if (['0','false','no','n'].includes(v)) return false;
  return def;
}

/** Redact tokens/secrets in logs. Keeps first/last 3 chars. */
export function redact(secret?: string | null): string {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 7) return '[redacted]';
  return `${s.slice(0,3)}…${s.slice(-3)}`;
}

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
    // OCR settings
    OCR_PROVIDER: z.enum(['none', 'webhook']).default('none'),
    OCR_WEBHOOK_URL: z.string().optional(),
    OCR_TIMEOUT_MS: z.string().optional(),
    // Download settings
    DOWNLOAD_MAX_INLINE_BYTES: z.string().optional(),
    DOWNLOAD_URL_TTL_SEC: z.string().optional(),
    ENFORCE_ACCEPT_HEADER: z.string().optional(),
  })
  .passthrough();

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Configuration error:', parsed.error.format());
  process.exit(1);
}

const env = parsed.data;

/**
 * Application configuration object parsed and validated from environment variables.
 * Provides type-safe access to all app settings with proper defaults.
 */
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
  // OCR
  ocrProvider: env.OCR_PROVIDER,
  ocrWebhookUrl: env.OCR_WEBHOOK_URL || '',
  ocrTimeoutMs: num(env.OCR_TIMEOUT_MS, 20_000),
  // Downloads
  downloadMaxInlineBytes: num(env.DOWNLOAD_MAX_INLINE_BYTES, 10 * 1024 * 1024),
  downloadUrlTtlSec: num(env.DOWNLOAD_URL_TTL_SEC, 600),
  // Protocol
  enforceAcceptHeader: bool(env.ENFORCE_ACCEPT_HEADER, true),
};

/** Type definition for the application configuration object */
export type AppConfig = typeof config;

/**
 * Returns the Canvas API token with whitespace trimmed, or undefined if empty.
 * Use this to get a clean token value for API authentication.
 * @returns Trimmed Canvas token or undefined if not set/empty
 */
export function getSanitizedCanvasToken(): string | undefined {
  return (config.canvasToken ?? '').trim() || undefined;
}

/**
 * Validates required configuration based on enabled features.
 * Throws if OCR webhook is enabled but URL is missing.
 */
export function validateConfig(cfg: AppConfig = config): void {
  const errs: string[] = [];
  if (cfg.ocrProvider === 'webhook' && !cfg.ocrWebhookUrl) {
    errs.push('OCR_WEBHOOK_URL is required when OCR_PROVIDER=webhook');
  }
  if (errs.length) throw new Error(`Config error:\n- ${errs.join('\n- ')}`);
}
