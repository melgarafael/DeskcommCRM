import { z } from "zod";

import { AGENT_OWNER_PREFIX, type LeadFilters, marcadoresDoFiltro } from "@/lib/kanban/filters";

/**
 * OS FILTROS QUE A ABA LISTA APLICA NA CONSULTA (#3172, fatia 2 — primeira parte).
 *
 * ─── Por que a Lista não reaproveita o `applyFilters` do quadro ─────────────
 *
 * O quadro lê o funil inteiro e filtra em memória. A Lista lê UMA página do
 * banco (`GET …/pipelines/[id]/leads`), e filtrar a página depois que ela chega
 * mente: com `Responsável: Ana` e 50 negócios na página 1, sobram os 3 da Ana que
 * caíram nela — e os outros 40 dela, nas páginas seguintes, somem. O filtro
 * tem de ir para a CONSULTA, antes do `range`.
 *
 * Esta parte leva os dois filtros que são uma coluna só no banco:
 *
 *   * `owner` — o MESMO valor da barra e da URL: uuid de pessoa, `agent:<uuid>`
 *     de agente, ou `unassigned` (sem dono NENHUM — negócio com agente tem dono,
 *     como no quadro);
 *   * `status` — `open`, `won` ou `lost`.
 *
 * Busca, etiqueta (três caixas e E/OU), atrasados (o "hoje" de quem olha),
 * motivo e categoria da perda ficam para a próxima parte. Enquanto isso, a tela
 * DIZ que eles não valem na Lista (`filtrosForaDaLista`) — uma lista que parece
 * filtrada e não está é a resposta em que o operador acredita.
 */

export interface FiltrosDaLista {
  /** uuid de pessoa | `agent:<uuid>` | `unassigned`. Ausente = de todos. */
  owner?: string;
  /** Ausente = todos (menos arquivado, que a rota nunca lista). */
  status?: "open" | "won" | "lost";
}

/** O recorte da barra que a Lista sabe aplicar. "Todos" vira ausência, não valor. */
export function filtrosDaLista(f: LeadFilters): FiltrosDaLista {
  const out: FiltrosDaLista = {};
  if (f.owner && f.owner !== "any") out.owner = f.owner;
  if (f.status && f.status !== "all") out.status = f.status;
  return out;
}

/**
 * A query string dos filtros, em ORDEM FIXA (`owner`, depois `status`).
 *
 * É também a identidade do filtro na chave de cache da página: a mesma escolha
 * tem de dar a mesma string, senão o cache guardaria a mesma página duas vezes.
 */
export function paramsDosFiltrosDaLista(f: FiltrosDaLista): string {
  const p = new URLSearchParams();
  if (f.owner) p.set("owner", f.owner);
  if (f.status) p.set("status", f.status);
  return p.toString();
}

/** Os filtros da barra que a Lista AINDA não aplica — nomes estáveis, a tela traduz. */
export type FiltroForaDaLista = "busca" | "etiqueta" | "atrasados" | "motivo" | "categoria";

/**
 * Quais filtros ATIVOS a Lista está ignorando. Lista vazia = o que a tela mostra
 * é exatamente o que a barra pede.
 */
export function filtrosForaDaLista(f: LeadFilters): FiltroForaDaLista[] {
  const fora: FiltroForaDaLista[] = [];
  if (f.search?.trim()) fora.push("busca");
  if (marcadoresDoFiltro(f.tag).length > 0) fora.push("etiqueta");
  if (f.overdueOnly) fora.push("atrasados");
  if (f.lostReason) fora.push("motivo");
  if (f.lostCategory) fora.push("categoria");
  return fora;
}

/**
 * De QUEM é, em coluna do banco. Mesma regra do `applyFilters` do quadro:
 * pessoa casa `owner_user_id`, agente casa `owner_agent_id`, e "sem responsável"
 * é as DUAS nulas.
 */
export type DonoDoFiltro =
  | { coluna: "owner_user_id" | "owner_agent_id"; id: string }
  | "ninguem";

export function donoDoFiltro(owner: string): DonoDoFiltro {
  if (owner === "unassigned") return "ninguem";
  if (owner.startsWith(AGENT_OWNER_PREFIX)) {
    return { coluna: "owner_agent_id", id: owner.slice(AGENT_OWNER_PREFIX.length) };
  }
  return { coluna: "owner_user_id", id: owner };
}

const uuid = z.string().uuid();

/**
 * O lado da ROTA: lê `owner` e `status` da URL.
 *
 * Valor desconhecido é ERRO (422), e não "sem filtro": responder o funil inteiro
 * a um `owner=` que não se entendeu é a lista parecer filtrada sem estar. `any` e
 * `all` são o "todos" que a barra já escreve, e valem ausência.
 */
export function lerFiltrosDaLista(
  sp: URLSearchParams,
): { ok: true; filtros: FiltrosDaLista } | { ok: false; campo: "owner" | "status" } {
  const filtros: FiltrosDaLista = {};

  const owner = sp.get("owner")?.trim();
  if (owner && owner !== "any") {
    const agente = owner.startsWith(AGENT_OWNER_PREFIX)
      ? owner.slice(AGENT_OWNER_PREFIX.length)
      : null;
    const valido =
      owner === "unassigned" ||
      (agente !== null ? uuid.safeParse(agente).success : uuid.safeParse(owner).success);
    if (!valido) return { ok: false, campo: "owner" };
    filtros.owner = owner;
  }

  const status = sp.get("status")?.trim();
  if (status && status !== "all") {
    if (status !== "open" && status !== "won" && status !== "lost") {
      return { ok: false, campo: "status" };
    }
    filtros.status = status;
  }

  return { ok: true, filtros };
}
