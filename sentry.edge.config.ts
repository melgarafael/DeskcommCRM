// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn, isCommunityDsn } from "./lib/sentry/dsn";
import { opcoesDePrivacidade } from "./lib/sentry/privacidade";

const sentryDsn = resolveSentryDsn(process.env.SENTRY_DSN);

Sentry.init({
  dsn: sentryDsn,

  // No Sentry da comunidade, só erro (issue #100). Ver isCommunityDsn().
  tracesSampleRate: isCommunityDsn(sentryDsn) ? 0 : 1,

  // Coleta restrita + scrub, num ponto só (Sentry 11 coleta amplo por default).
  ...opcoesDePrivacidade,
});
