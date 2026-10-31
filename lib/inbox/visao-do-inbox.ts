/**
 * A VISÃO DO INBOX NA URL (redesign kvgroup).
 *
 * O redesign separa três perguntas que a fileira de abas misturava:
 *  - ONDE    → a visão, escolhida no submenu do Inbox na barra lateral;
 *  - ESTADO  → o status (abertas, fechadas, arquivadas), no seletor da lista;
 *  - DE QUEM → as três abas (Minhas, Fila, Todas).
 *
 * As três moram na URL, para recarregar e compartilhar sem perder o lugar. A
 * barra lateral (que monta os links) e o `InboxLayout` (que aplica o filtro)
 * leem ESTE módulo — duas leituras da mesma URL não podem discordar.
 *
 * Parâmetros: `view` (todas | nao-lidas | grupos), `channel`, `tag`,
 * `filter` (a aba; `ai` é a visão "Com agente de IA") e `status`.
 */

export type VisaoDoInbox =
  | { tipo: "todas" }
  | { tipo: "ia" }
  | { tipo: "nao-lidas" }
  | { tipo: "grupos" }
  | { tipo: "canal"; id: string }
  | { tipo: "tag"; nome: string };

export type StatusDaLista = "abertas" | "fechadas" | "arquivadas";

export const CHAVES_DA_VISAO = ["view", "channel", "tag"] as const;

interface LeitorDeParams {
  get(nome: string): string | null;
  toString(): string;
}

export function visaoAtiva(params: LeitorDeParams): VisaoDoInbox {
  if (params.get("filter") === "ai") return { tipo: "ia" };
  const view = params.get("view");
  if (view === "nao-lidas") return { tipo: "nao-lidas" };
  if (view === "grupos") return { tipo: "grupos" };
  const canal = params.get("channel");
  if (canal) return { tipo: "canal", id: canal };
  const tag = params.get("tag");
  if (tag) return { tipo: "tag", nome: tag };
  return { tipo: "todas" };
}

/** A URL que leva a uma visão, preservando aba, status e conversa aberta. */
export function hrefDaVisao(params: LeitorDeParams | null, visao: VisaoDoInbox): string {
  const proximo = new URLSearchParams(params ? params.toString() : "");
  for (const chave of CHAVES_DA_VISAO) proximo.delete(chave);
  if (visao.tipo === "ia") {
    proximo.set("filter", "ai");
    proximo.delete("status");
  } else if (proximo.get("filter") === "ai") {
    proximo.delete("filter");
  }
  if (visao.tipo === "todas") proximo.set("view", "todas");
  if (visao.tipo === "nao-lidas") proximo.set("view", "nao-lidas");
  if (visao.tipo === "grupos") proximo.set("view", "grupos");
  if (visao.tipo === "canal") proximo.set("channel", visao.id);
  if (visao.tipo === "tag") proximo.set("tag", visao.nome);
  const qs = proximo.toString();
  return qs ? `/app/inbox?${qs}` : "/app/inbox";
}

/** Os filtros auxiliares que a visão da URL impõe, ou `null` sem visão explícita. */
export function filtrosDaVisao(params: LeitorDeParams): {
  onlyUnread: boolean;
  onlyGroups: boolean;
  channel_session_id: string | undefined;
  tag: string | undefined;
} | null {
  if (!CHAVES_DA_VISAO.some((chave) => params.get(chave) !== null)) return null;
  const visao = visaoAtiva(params);
  return {
    onlyUnread: visao.tipo === "nao-lidas",
    onlyGroups: visao.tipo === "grupos",
    channel_session_id: visao.tipo === "canal" ? visao.id : undefined,
    tag: visao.tipo === "tag" ? visao.nome : undefined,
  };
}

/**
 * O status escolhido no seletor da lista. `?filter=closed`/`archived` eram as
 * abas Fechadas/Arquivadas — os links antigos continuam caindo no lugar certo.
 */
export function statusDaLista(params: LeitorDeParams): StatusDaLista {
  const status = params.get("status");
  if (status === "fechadas" || status === "arquivadas") return status;
  const filtro = params.get("filter");
  if (filtro === "closed") return "fechadas";
  if (filtro === "archived") return "arquivadas";
  return "abertas";
}
