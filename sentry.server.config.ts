// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn, isCommunityDsn, DEFAULT_SENTRY_DSN } from "./lib/sentry/dsn";
import { opcoesDePrivacidade } from "./lib/sentry/privacidade";

const sentryDsn = resolveSentryDsn(process.env.SENTRY_DSN);
const community = isCommunityDsn(sentryDsn);

Sentry.init({
  dsn: sentryDsn,

  // No Sentry da comunidade, só erro (issue #100). Ver isCommunityDsn().
  tracesSampleRate: community ? 0 : 1,

  // Coleta restrita + scrub, num ponto só (Sentry 11 coleta amplo por default).
  ...opcoesDePrivacidade,
});

// Transparência de telemetria: uma linha no boot dizendo o que está ativo e como
// desligar. Evita "telemetria silenciosa" num projeto open source self-host.
if (!sentryDsn) {
  console.info("[telemetria] Desligada (SENTRY_DSN=off) — nenhum erro é enviado.");
} else if (sentryDsn === DEFAULT_SENTRY_DSN) {
  console.info(
    "[telemetria] Relatórios de erro anonimizados ATIVOS (Sentry da comunidade). " +
      "Sem rastreamento de performance nem replay de sessão. " +
      "Desligue com SENTRY_DSN=off, ou envie pro seu com SENTRY_DSN=<seu-dsn>.",
  );
} else {
  console.info("[telemetria] Erros sendo enviados ao Sentry configurado em SENTRY_DSN.");
}
