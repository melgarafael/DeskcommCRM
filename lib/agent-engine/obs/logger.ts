/**
 * Logger estruturado MÍNIMO (F2-04): JSON por linha em stdout — ts, level, msg +
 * campos. PII nunca entra em `fields` (disciplina do call site — payload de job e
 * conteúdo de lead não são logáveis; o scanner de obs-metrics.test.ts vigia).
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(stream: NodeJS.WritableStream = process.stdout): Logger {
  const write = (level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields): void => {
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

/**
 * Logger derivado com campos fixos de escopo (F2-16) — ex.: o contexto do RUN
 * (job_id = run id, tenant_id, lead_id) carimbado em toda linha do turno sem
 * repetir os campos em cada call site. `fields` do call site vence em colisão.
 */
export function withFields(log: Logger, bindings: LogFields): Logger {
  return {
    info: (msg, fields) => log.info(msg, { ...bindings, ...fields }),
    warn: (msg, fields) => log.warn(msg, { ...bindings, ...fields }),
    error: (msg, fields) => log.error(msg, { ...bindings, ...fields }),
  };
}
