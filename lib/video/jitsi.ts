/**
 * Servidor de videochamada (Jitsi Meet, #2440) — resolução em runtime.
 *
 * Por que existe: o produto já liga para o contato (chamada de voz, spec 18),
 * mas não tem como ver a cara de quem atende. O Jitsi é a rota curta: sala por
 * URL; o contato entra sem conta e sem instalar nada — o link chega pelo
 * WhatsApp e abre no navegador do celular.
 *
 * Por que a URL vem de `window.__PUBLIC_ENV__` e não de `NEXT_PUBLIC_*`: é a
 * mesma razão da marca e do DSN do Sentry (`lib/branding.ts`, `lib/sentry/dsn.ts`).
 * O self-hoster roda uma imagem PRÉ-BUILDADA; `NEXT_PUBLIC_*` é queimada no
 * `next build` e ele nunca conseguiria apontar para o próprio servidor. Ver o
 * cabeçalho de `app/public-env-script.tsx` — lá dentro está o bug de produção
 * que ensinou a regra.
 *
 * Vazio = a instalação não oferece videochamada. É esse "não tem" que o
 * botão do header lê para se esconder (padrão `WACALLS_API_BASE_URL`:
 * esconde, nunca erro).
 */

import { randomId } from "@/lib/random-id";

/** Só `http(s)://`. Toda outra origem vira `null` — vira `href`, então um
 * `javascript:` ou um `data:` aqui seria código executando no clique. */
const EH_HTTP = /^https?:\/\/\S+$/i;

/** Valor da env já normalizado: `null` quando a instalação não oferece video. */
export function resolveServidorDeVideo(
  valor: string | undefined | null,
): string | null {
  const url = (valor ?? "").trim().replace(/\/+$/, "");
  if (url.length === 0) return null;
  // O Zod de `lib/env.ts` já recusa fora de http(s) (e desliga a feature em
  // vez de derrubar o boot); esta segunda triagem é quem protege o `href` no
  // navegador, que lê o payload injetado e não passa pelo Zod de novo.
  if (!EH_HTTP.test(url)) return null;
  return url;
}

/**
 * URL do servidor de videochamada para quem estiver rodando.
 *
 * No navegador lê `window.__PUBLIC_ENV__` (injetado em runtime); no servidor
 * cai em `process.env` — mesmo caminho de `branding()`. `process.env` inteiro
 * (não o acesso estático) para o Next não substituir o valor pelo do build.
 */
export function servidorDeVideo(): string | null {
  if (typeof window !== "undefined") {
    return resolveServidorDeVideo(window.__PUBLIC_ENV__?.JITSI_SERVER_URL);
  }
  return resolveServidorDeVideo(process.env.JITSI_SERVER_URL);
}

/**
 * Nome da sala: `sala-<uuid aleatório>`, gerado NO MOMENTO em que o diálogo
 * abre — nada é gravado.
 *
 * Duas decisões aqui são do review do #2441:
 *
 *  - **Aleatório por chamada, não derivado da conversa.** Com a sala fixa
 *    (o primeiro formato era o UUID da conversa), o link de UMA consulta
 *    entraria na seguinte enquanto a conversa existir — e o id interno da
 *    conversa sairia para fora. Aqui o link vale para o encontro que o
 *    operador acabou de abrir, e só.
 *  - **Prefixo `sala-`, não o nome do produto.** Este link vai parar na tela
 *    do cliente final de quem revende a instalação; a sala não é lugar de
 *    marca. Por isso o prefixo é neutro e `lib/video/jitsi.ts` NÃO entra em
 *    `MARCA_CONGELADA` (a lista só encolhe).
 *
 * O uuid vem de `randomId()` e não de `crypto.randomUUID` cru: este módulo
 * roda no navegador (o botão o importa), e o navegador só expõe `randomUUID`
 * em contexto seguro (https ou localhost). No self-host em `http://IP` a
 * chamada crua lança `TypeError` e o diálogo nunca abre (medido no Chromium,
 * review do #2441).
 */
export function novaSala(): string {
  return `sala-${randomId()}`;
}

/**
 * URL completa da sala, ou `null` quando não há servidor.
 *
 * Sem servidor não existe "sala parcial": devolver a sala sozinha deixaria o
 * botão montar um `href` relativo que abriria uma rota interna nossa como se
 * fosse videochamada.
 */
export function urlDaSala(servidor: string | null, sala: string): string | null {
  if (!servidor) return null;
  return `${servidor}/${sala}`;
}
