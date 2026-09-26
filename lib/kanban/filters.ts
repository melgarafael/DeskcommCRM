import type { Lead } from "@/lib/types/leads";
import { cardTemMarcador } from "@/lib/kanban/marcadores-do-card";

/**
 * Prefixo que marca um dono AGENTE no filtro (0070). O param de URL continua
 * sendo `owner=` — humano é o uuid puro, agente é `agent:<uuid>`, e o board
 * não precisa de dois seletores para a mesma pergunta ("de quem é isto?").
 */
export const AGENT_OWNER_PREFIX = "agent:";

export function agentOwnerFilter(agentId: string): string {
  return `${AGENT_OWNER_PREFIX}${agentId}`;
}

export function parseAgentOwnerFilter(value: string | undefined): string | null {
  if (!value?.startsWith(AGENT_OWNER_PREFIX)) return null;
  return value.slice(AGENT_OWNER_PREFIX.length) || null;
}

export interface LeadFilters {
  /** userId | `agent:<uuid>` | "any" | "unassigned" */
  owner?: string | "any" | "unassigned";
  status?: "all" | "open" | "won" | "lost";
  tag?: string;
  search?: string;
  valueCentsMin?: number | null;
  valueCentsMax?: number | null;
  overdueOnly?: boolean;
  /** O `lost_reason` exato do card — filtro de perda (issue #1537). */
  lostReason?: string;
  /** A categoria do motivo de perda (issue #1537), resolvida no funil. */
  lostCategory?: string;
}

/**
 * Serializa/deserializa os filtros do board em query params (deep-linkável).
 * Só os controles expostos na FilterBar: owner, status, tag, busca, atrasados.
 */
export function filtersFromParams(
  sp: { get(key: string): string | null },
): LeadFilters {
  const owner = sp.get("owner");
  const status = sp.get("status");
  const tag = sp.get("tag");
  const search = sp.get("q");
  return {
    owner: owner ?? undefined,
    status:
      status === "open" || status === "won" || status === "lost" || status === "all"
        ? status
        : "all",
    tag: tag ?? undefined,
    search: search ?? undefined,
    overdueOnly: sp.get("overdue") === "1" || undefined,
    lostReason: sp.get("motivo") ?? undefined,
    lostCategory: sp.get("categoria") ?? undefined,
  };
}

export function filtersToParams(f: LeadFilters): string {
  const p = new URLSearchParams();
  if (f.owner && f.owner !== "any") p.set("owner", f.owner);
  if (f.status && f.status !== "all") p.set("status", f.status);
  if (f.tag) p.set("tag", f.tag);
  if (f.search?.trim()) p.set("q", f.search.trim());
  if (f.overdueOnly) p.set("overdue", "1");
  if (f.lostReason) p.set("motivo", f.lostReason);
  if (f.lostCategory) p.set("categoria", f.lostCategory);
  return p.toString();
}

/**
 * `contexto` é o que a tela sabe e o lead não: a categoria NÃO é coluna, ela
 * sai do `settings.lost_reasons` do funil (`lib/leads/motivos-de-perda-do-funil.ts`).
 * Sem contexto, filtrar por categoria não acha nada — que é o comportamento
 * honesto: sem configuração não há o que agrupar.
 */
export interface ContextoDosFiltros {
  categoriaDo?: (motivo: string) => string | undefined;
}

export function applyFilters(
  leads: Lead[],
  f: LeadFilters,
  contexto?: ContextoDosFiltros,
): Lead[] {
  const today = new Date().toISOString().slice(0, 10);
  const search = f.search?.trim().toLowerCase() ?? "";

  return leads.filter((l) => {
    // "Sem responsável" é sem dono NENHUM — lead de dono agente tem dono.
    if (
      f.owner === "unassigned" &&
      (l.owner_user_id !== null || l.owner_agent_id !== null)
    )
      return false;
    if (f.owner && f.owner !== "any" && f.owner !== "unassigned") {
      const agentId = parseAgentOwnerFilter(f.owner);
      if (agentId) {
        if (l.owner_agent_id !== agentId) return false;
      } else if (l.owner_user_id !== f.owner) {
        return false;
      }
    }
    if (f.status && f.status !== "all" && l.status !== f.status) return false;
    // Motivo/categoria só existem em negócio PERDIDO (issue #1537). Escolher um
    // deles é pedir perdas: sem isso, o filtro combinado com a aba "Ganhos"
    // devolvia lista vazia sem dizer por quê.
    if ((f.lostReason || f.lostCategory) && l.status !== "lost") return false;
    if (f.lostReason && l.lost_reason !== f.lostReason) return false;
    if (f.lostCategory) {
      const motivo = l.lost_reason?.trim() ?? "";
      const categoria = motivo ? contexto?.categoriaDo?.(motivo) : undefined;
      if (categoria !== f.lostCategory) return false;
    }
    // As TRÊS caixas de marcador (negócio, contato, conversa) — ver
    // lib/kanban/marcadores-do-card.ts. Só `l.tags` deixava o marcador escrito
    // no contato ou na conversa sem casar card nenhum.
    if (f.tag && !cardTemMarcador(l, f.tag)) return false;
    if (
      search &&
      !`${l.title} ${l.description ?? ""}`.toLowerCase().includes(search)
    )
      return false;
    if (typeof f.valueCentsMin === "number" && (l.value_cents ?? 0) < f.valueCentsMin)
      return false;
    if (typeof f.valueCentsMax === "number" && (l.value_cents ?? 0) > f.valueCentsMax)
      return false;
    if (f.overdueOnly) {
      if (l.status !== "open") return false;
      if (!l.expected_close_date || l.expected_close_date >= today) return false;
    }
    return true;
  });
}
