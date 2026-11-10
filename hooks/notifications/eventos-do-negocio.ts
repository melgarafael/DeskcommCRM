/**
 * A PERGUNTA AO BANCO QUANDO A SESSÃO NÃO TEM HISTÓRICO (issue #3224).
 *
 * `GET /api/v1/leads/[id]/eventos` devolve as últimas linhas de `event_log`
 * dos três tipos que viram aviso (`lead.assigned`, `lead.won`, `lead.lost`)
 * daquele negócio — o produtor que o gatilho `fn_emit_event_on_lead_change` já
 * alimenta comparando OLD e NEW no banco. Quem decide o que disso vira aviso é
 * `avisosDoBanco`, em `./aviso-de-negocio.ts`, casando o evento com a
 * transação do UPDATE.
 *
 * ═══ Por que uma rota, e não o supabase do browser ═══
 *
 * Mesmo motivo do defeito #376 (documentado em
 * `hooks/notifications/useInboundMessageAlerts.ts`): o cookie de sessão é
 * httpOnly, o supabase-js do browser não o enxerga, e a leitura sai como
 * `anon` — a RLS devolve ZERO LINHAS sem erro, indistinguível de "não há
 * evento". A rota autentica com a sessão de verdade e ainda filtra a
 * organização ATIVA por SQL: um usuário em duas organizações leria as duas
 * pela RLS, e o evento da outra org não pode virar aviso desta.
 *
 * ═══ Silêncio na falha ═══
 *
 * Rota fora do ar, 403, corpo estranho: `[]`. Sem evento do banco não há
 * atestado, e sem atestado o aviso não sai — preferir o silêncio a notificar
 * por engano é a regra das duas issues (#3040 e #3224).
 */
import type { EventoDeNegocio } from "./aviso-de-negocio";

function ehEvento(v: unknown): v is EventoDeNegocio {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const evento = v as Record<string, unknown>;
  const id = evento.entity_id;
  const para = evento.to_user_id;
  return (
    typeof evento.organization_id === "string" &&
    typeof evento.event_type === "string" &&
    typeof evento.created_at === "string" &&
    (typeof id === "string" || id === null) &&
    (typeof para === "string" || para === null)
  );
}

export async function buscaEventosDoNegocio(leadId: string): Promise<EventoDeNegocio[]> {
  try {
    const r = await fetch(`/api/v1/leads/${encodeURIComponent(leadId)}/eventos`, {
      credentials: "include",
    });
    if (!r.ok) return [];
    const json = (await r.json()) as { data?: { eventos?: unknown } | null };
    const linhas = json?.data?.eventos;
    if (!Array.isArray(linhas)) return [];
    return linhas.filter(ehEvento);
  } catch {
    return [];
  }
}
