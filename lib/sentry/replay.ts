/**
 * O Replay passa pelo MESMO scrub de URL que o resto da telemetria.
 *
 * Os hooks de `./scrub` não o alcançam sozinhos: o `replay_event` não passa pelo
 * `beforeSend` (o `@sentry/core` só o chama para evento de erro), e a gravação é
 * montada pelo próprio `@sentry/replay`. Há três lugares por onde a URL da página
 * entra no Replay, e cada um pede um mecanismo:
 *
 * 1. `replay_event` (`urls`, `request.url`, header `Referer`) — um processador de
 *    evento, que roda em `prepareEvent` também para o replay.
 * 2. Eventos de gravação customizados (breadcrumb e span de performance, com a URL
 *    em `description` e `data.previous`) — o `beforeAddRecordingEvent`.
 * 3. O evento `Meta` do rrweb, com `href: window.location.href` cru, emitido a cada
 *    snapshot completo — e o DOM da página, onde o token pode estar num campo
 *    oculto (o rrweb não mascara `input[type=hidden]`). Nenhuma opção pública do
 *    SDK alcança esses dois: o `beforeAddRecordingEvent` só recebe evento
 *    customizado. Por isso, nas páginas com credencial na URL, o Replay não grava.
 */
import { scrubUrl, sentryScrubHooks, urlComCredencial } from "./scrub";

type RecordingEventLike = {
  data?: { tag?: unknown; payload?: unknown };
};
type PerformanceSpanPayload = { description?: unknown; data?: { previous?: unknown } };
type BreadcrumbPayload = Parameters<typeof sentryScrubHooks.beforeBreadcrumb>[0];

/** `beforeAddRecordingEvent` do `replayIntegration`. */
export function limparEventoDeGravacao<T extends RecordingEventLike>(event: T): T {
  const payload = event.data?.payload;
  if (!payload || typeof payload !== "object") return event;
  if (event.data?.tag === "breadcrumb") {
    sentryScrubHooks.beforeBreadcrumb(payload as BreadcrumbPayload);
  } else if (event.data?.tag === "performanceSpan") {
    const span = payload as PerformanceSpanPayload;
    if (typeof span.description === "string") span.description = scrubUrl(span.description);
    if (span.data && typeof span.data.previous === "string") {
      span.data.previous = scrubUrl(span.data.previous);
    }
  }
  return event;
}

type ReplayEventLike = Parameters<typeof sentryScrubHooks.beforeSend>[0] & {
  type?: string;
  urls?: unknown;
};

/** Processador do `replay_event`, que o `beforeSend` nunca vê. */
export const replayEventSemUrlCrua = {
  name: "ReplayEventSemUrlCrua",
  processEvent<T extends ReplayEventLike>(event: T): T {
    if (event.type !== "replay_event") return event;
    sentryScrubHooks.beforeSend(event);
    if (Array.isArray(event.urls)) {
      event.urls = event.urls.map((url) => (typeof url === "string" ? scrubUrl(url) : url));
    }
    return event;
  },
};

type OpcoesDoReplay = { beforeAddRecordingEvent: typeof limparEventoDeGravacao };

/**
 * As integrações de Replay para a página carregada em `urlDaPagina`: nenhuma
 * quando a URL carrega credencial (ver item 3 do cabeçalho).
 */
export function integracoesDeReplay<R>(
  urlDaPagina: string,
  criarReplay: (opcoes: OpcoesDoReplay) => R,
): Array<R | typeof replayEventSemUrlCrua> {
  if (urlComCredencial(urlDaPagina)) return [];
  return [criarReplay({ beforeAddRecordingEvent: limparEventoDeGravacao }), replayEventSemUrlCrua];
}

/**
 * Na navegação do lado do cliente PARA uma página com credencial, o Replay para.
 * ponytail: não volta a gravar até a próxima carga de página — religar exigiria
 * refazer a amostragem, e essas páginas são porta de entrada vinda de e-mail.
 */
export function pararReplayEmRotaComCredencial(
  href: string,
  replay: { stop(): Promise<void> } | undefined,
): void {
  if (replay && urlComCredencial(href)) void replay.stop();
}
