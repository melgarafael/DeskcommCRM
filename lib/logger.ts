/**
 * Structured JSON logger (zero-deps, pino-style API).
 *
 * Used in API routes and workers. Output is one JSON line per call so log
 * aggregators (Vercel runtime logs, Sentry breadcrumb sinks, etc.) can index
 * arbitrary fields without parsing free-form strings.
 *
 * Never log secrets, raw tokens, message bodies, CPF, or phone numbers.
 */

export type LogContext = Record<string, unknown>;

function fmt(level: string, msg: string, ctx?: LogContext): string {
  return JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...(ctx ?? {}),
  });
}

export const logger = {
  info(msg: string, ctx?: LogContext): void {
    // eslint-disable-next-line no-console
    console.log(fmt("info", msg, ctx));
  },
  warn(msg: string, ctx?: LogContext): void {
    // eslint-disable-next-line no-console
    console.warn(fmt("warn", msg, ctx));
  },
  error(msg: string, ctx?: LogContext): void {
    // eslint-disable-next-line no-console
    console.error(fmt("error", msg, ctx));
  },
  debug(msg: string, ctx?: LogContext): void {
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.log(fmt("debug", msg, ctx));
    }
  },
};
