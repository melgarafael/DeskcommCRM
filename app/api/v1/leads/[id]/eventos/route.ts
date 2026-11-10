/**
 * GET /api/v1/leads/[id]/eventos — o que o BANCO registrou deste negócio:
 * as últimas linhas de `event_log` dos três tipos que viram aviso dentro do
 * app (`lead.assigned`, `lead.won`, `lead.lost`), reduzidas ao que a decisão
 * usa (issue #3224).
 *
 * ═══ Por que esta rota existe ═══
 *
 * O aviso dentro do app (#3183) compara o evento do Realtime com o último
 * estado que a ABA viu daquele negócio, porque o `old` vem só com a chave
 * primária (nenhuma tabela tem `REPLICA IDENTITY FULL`). Sem histórico — o
 * negócio parado, a aba logo após recarregar, a reatribuição A→B em que B só
 * enxerga o negócio quando já é dele — o aviso ficava calado (#3224). Quem tem
 * a resposta é o gatilho `fn_emit_event_on_lead_change`, que grava estes
 * eventos comparando OLD e NEW na MESMA transação do UPDATE: o consumidor
 * (`hooks/notifications/useCrmAlerts.ts`) pergunta aqui quando a memória não
 * alcança.
 *
 * ═══ Por que o client da SESSÃO, e com que cerca ═══
 *
 * A EXISTÊNCIA e a visibilidade do negócio são conferidas com o client da
 * sessão: a RLS de `crm_leads` (`fn_can_view_lead`) esconde de quem não pode
 * ver, e quem não enxerga recebe 404 sem aprender nada — inclusive se o
 * negócio pertence a outra organização. Só então os eventos são lidos, e a
 * leitura filtra `organization_id` da organização ATIVA da sessão (fonte
 * confiável, o cookie — nunca input): um usuário em duas organizações leria
 * as duas pela RLS (`event_log_select` deixa o membro ler a org inteira), e o
 * evento da outra org não pode virar aviso desta. É a mesma regra documentada
 * em `app/api/v1/ai/operator-metrics/route.ts`.
 *
 * Sem nenhuma migration: a rota só LÊ. `REPLICA IDENTITY` e schema seguem
 * intocados, como a issue pede.
 *
 * Read-only ⇒ sem audit (mesma regra das rotas irmãs de leitura).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Os únicos eventos do negócio que viram aviso no app — cf. `aviso-de-negocio.ts`. */
const EVENTOS_DO_AVISO = ["lead.assigned", "lead.won", "lead.lost"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface LinhaDoEvento {
  organization_id?: unknown;
  event_type?: unknown;
  entity_id?: unknown;
  created_at?: unknown;
  payload?: unknown;
}

/** A linha crua vira o formato de `EventoDeNegocio` — dado torto vira `null`. */
function reduzir(linha: LinhaDoEvento): {
  organization_id: string;
  event_type: string;
  entity_id: string | null;
  created_at: string;
  to_user_id: string | null;
} {
  const payload =
    linha.payload && typeof linha.payload === "object" && !Array.isArray(linha.payload)
      ? (linha.payload as Record<string, unknown>)
      : {};
  const para = payload.to_user_id;
  return {
    organization_id: typeof linha.organization_id === "string" ? linha.organization_id : "",
    event_type: typeof linha.event_type === "string" ? linha.event_type : "",
    entity_id: typeof linha.entity_id === "string" ? linha.entity_id : null,
    created_at: typeof linha.created_at === "string" ? linha.created_at : "",
    to_user_id: typeof para === "string" && para.length > 0 ? para : null,
  };
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  // viewer+: todo membro que recebe o realtime de negócios precisa poder
  // perguntar se o banco atestou uma mudança para ele.
  const authz = await requireRole("viewer", { requestId, resource: "leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return fail("not_found", t("Negócio não encontrado."), 404, { requestId });
  }

  const supabase = await createClient();
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  try {
    const { data, error } = await supabase
      .from("event_log")
      .select("organization_id, event_type, entity_id, created_at, payload")
      // Org ATIVA da sessão em SQL, não só na RLS: um membro de duas orgs
      // passaria pelas duas policies e o evento da outra não pode virar aviso.
      .eq("organization_id", org.orgId)
      .eq("entity_kind", "lead")
      .eq("entity_id", id)
      .in("event_type", EVENTOS_DO_AVISO)
      // Sem janela de relógio: o casamento com a transação é de
      // `avisosDoBanco` (created_at × updated_at), e o recorte das últimas
      // linhas é o suficiente para achar o evento desta transação.
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    const eventos = (data ?? [])
      .map((linha) => reduzir(linha as LinhaDoEvento))
      .filter((evento) => evento.organization_id === org.orgId);
    return ok({ eventos }, { requestId });
  } catch (err) {
    logger.error("[leads/eventos] leitura falhou", {
      lead_id: id,
      organization_id: org.orgId,
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", t("Não foi possível ler os eventos do negócio."), 500, { requestId });
  }
}
