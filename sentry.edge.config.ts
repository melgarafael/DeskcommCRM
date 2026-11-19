// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn, isCommunityDsn, integracoesDoServidor } from "./lib/sentry/dsn";
import { opcoesDePrivacidade } from "./lib/sentry/privacidade";

const sentryDsn = resolveSentryDsn(process.env.SENTRY_DSN);

// Sem DSN, sem Sentry — inclusive sem a integração do AI SDK, que é a que trava
// o `streamText` com tools da assinatura (#4798). Ver `integracoesDoServidor`.
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,

    // No Sentry da comunidade, só erro (issue #100). Ver isCommunityDsn().
    tracesSampleRate: isCommunityDsn(sentryDsn) ? 0 : 1,

    integrations: integracoesDoServidor,

    // Coleta restrita + scrub, num ponto só (Sentry 11 coleta amplo por default).
    ...opcoesDePrivacidade,
  });
}
