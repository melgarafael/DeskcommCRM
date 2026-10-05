// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn, isCommunityDsn, integracoesDoCliente } from "./lib/sentry/dsn";
import { opcoesDePrivacidade } from "./lib/sentry/privacidade";
import { integracoesDeReplay, pararReplayEmRotaComCredencial } from "./lib/sentry/replay";

const sentryDsn = resolveSentryDsn(
  typeof window !== "undefined" ? window.__PUBLIC_ENV__?.SENTRY_DSN : undefined,
);
const community = isCommunityDsn(sentryDsn);

Sentry.init({
  dsn: sentryDsn,

  // FORMA DE FUNÇÃO, não de array: array SOMA aos defaults do SDK, e era assim
  // que a `BrowserSession` (default) seguia ligada apesar da política abaixo. A
  // função RECEBE os defaults e o retorno os substitui — é o único jeito de tirar
  // uma integração default sem enumerar as outras dez à mão.
  integrations: (padraoDoSdk) => [
    ...integracoesDoCliente(padraoDoSdk, community),
    // Com o scrub de URL do projeto, e sem gravar a página que tem credencial na
    // URL (ver lib/sentry/replay.ts).
    ...integracoesDeReplay(
      typeof window !== "undefined" ? window.location.href : "",
      Sentry.replayIntegration,
    ),
  ],

  // No Sentry da comunidade, só erro (issue #100): sem trace, sem replay de
  // sessão e sem sessão de release health (ver integracoesDoCliente). O replay DE
  // ERRO continua, porque é o que explica o stack trace — e o replayIntegration()
  // mantém os defaults maskAllText/blockAllMedia.
  tracesSampleRate: community ? 0 : 1,

  replaysSessionSampleRate: community ? 0 : 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Coleta restrita + scrub, num ponto só (Sentry 11 coleta amplo por default).
  ...opcoesDePrivacidade,
});

export function onRouterTransitionStart(href: string, navigationType: string): void {
  pararReplayEmRotaComCredencial(href, Sentry.getReplay());
  Sentry.captureRouterTransitionStart(href, navigationType);
}
