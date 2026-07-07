// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn, DEFAULT_SENTRY_DSN } from "./lib/sentry/dsn";

const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-waha-api-key",
  "x-nuvemshop-token",
  "x-deskcomm-token",
];

function scrubMessage(input: string): string {
  return input
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, "[CPF]")
    .replace(/\+?\d{2}\s?\d{4,5}-?\d{4}/g, "[PHONE]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]");
}

const sentryDsn = resolveSentryDsn(process.env.SENTRY_DSN);

Sentry.init({
  dsn: sentryDsn,

  tracesSampleRate: 1,
  enableLogs: true,
  sendDefaultPii: false,

  beforeSend(event) {
    if (event.request?.headers) {
      const headers = event.request.headers as Record<string, string>;
      for (const k of Object.keys(headers)) {
        if (SENSITIVE_HEADERS.includes(k.toLowerCase())) {
          delete headers[k];
        }
      }
    }
    if (typeof event.message === "string") {
      event.message = scrubMessage(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (ex.value) ex.value = scrubMessage(ex.value);
      }
    }
    return event;
  },
});

// Transparência de telemetria: uma linha no boot dizendo o que está ativo e como
// desligar. Evita "telemetria silenciosa" num projeto open source self-host.
if (!sentryDsn) {
  console.info("[telemetria] Desligada (SENTRY_DSN=off) — nenhum erro é enviado.");
} else if (sentryDsn === DEFAULT_SENTRY_DSN) {
  console.info(
    "[telemetria] Relatórios de erro anonimizados ATIVOS (Sentry da comunidade). " +
      "Desligue com SENTRY_DSN=off, ou envie pro seu com SENTRY_DSN=<seu-dsn>.",
  );
} else {
  console.info("[telemetria] Erros sendo enviados ao Sentry configurado em SENTRY_DSN.");
}
