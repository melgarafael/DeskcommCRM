import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/PUT /api/v1/pipelines/[id]/agent-mapping — quem diz ao agente onde ficam
 * as etapas DESTE funil.
 *
 * A ponte é `crm_stages.agent_stage_hint` (migration 0084): ela já move cards em
 * produção, mas até agora nenhuma tela escrevia nessa coluna. Esta rota é a
 * escrita; as regras vivem em `lib/leads/agent-mapping.ts` (puras, testadas) e
 * aqui só há transporte.
 *
 * Auth: sessão por cookie, papel manager+ (é configuração do funil, não leitura
 * de card). `organization_id` sai do JWT — nunca do body. O client é o do
 * usuário, então a RLS vale; o filtro explícito de `organization_id` é a
 * convenção do repo e a rede que sobra se a policy mudar.
 *
 * ⚠️ O PUT É TOTAL E IDEMPOTENTE. O corpo descreve o estado desejado dos SETE
 * passos — `null` explícito é "não mover", não "não mexi nisso". Um delta
 * parcial reabriria o caso em que a tela ocupa uma etapa e desmapeia em silêncio
 * o passo que ela declarava.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { LEAD_STAGES, type LeadStage } from "@/lib/agent-engine/agent/lead-state";
import {
  diffParaUpdates,
  validarMapeamento,
  type EtapaDoMapa,
} from "@/lib/leads/agent-mapping";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * `.min(1)` e não `.uuid()`: um id que não é uuid ainda é "etapa que não faz
 * parte deste funil", e a regra pura responde isso em português com o nome do
 * passo. O erro do Zod seria uma mensagem de transporte para um engano de tela.
 */
const escolha = z.string().min(1).nullable();

/**
 * `satisfies` é a guarda de compilação do contrato total: se `LEAD_STAGES`
 * ganhar um passo e esta lista não, o `tsc` quebra aqui em vez de a rota aceitar
 * um mapa incompleto em produção.
 */
const bodySchema = z.object({
  mapeamento: z
    .object({
      new: escolha,
      contacted: escolha,
      qualifying: escolha,
      qualified: escolha,
      negotiating: escolha,
      won: escolha,
      lost: escolha,
    } satisfies Record<LeadStage, typeof escolha>)
    .strict(),
});

/**
 * Estado do funil como a tela precisa dele. Devolve `null` quando o pipeline não
 * é desta organização — para o chamador isso é 404, e é a MESMA resposta de um
 * pipeline inexistente: dizer "existe, mas não é seu" já é vazar a existência.
 *
 * `is_archived = false` porque o board não mostra etapa arquivada e o índice
 * único do banco a ignora: oferecê-la seria deixar o tenant configurar um
 * mapeamento invisível.
 *
 * A ordem por `position` é a ordem do funil na tela — a mesma do board. Sem ela
 * o tenant escolheria etapas numa lista embaralhada. `position` não entra no
 * `select` porque o PostgREST ordena por coluna que não foi projetada.
 */
/**
 * A etapa como ESTA rota a lê: a régua do mapeamento mais a autoria da última
 * mudança de configuração.
 *
 * ⚠️ A AUTORIA NÃO ENTRA EM `EtapaDoMapa`. Aquele tipo é o contrato do
 * MAPEAMENTO (o que decide qual etapa representa qual passo do assistente), e
 * `validarMapeamento`/`diffParaUpdates` trabalham em cima dele. Autoria é sobre
 * quem mexeu, não sobre o que a etapa significa — misturar as duas coisas faria
 * a regra do mapeamento carregar um campo que ela nunca lê.
 */
type EtapaComAutoria = EtapaDoMapa & {
  last_change_actor_kind: string | null;
  last_change_at: string | null;
};

async function lerFunil(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  pipelineId: string,
): Promise<{ etapas: EtapaComAutoria[] } | null> {
  const { data: pipeline, error: pipeErr } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("id", pipelineId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pipeErr) throw new Error(pipeErr.message);
  if (!pipeline) return null;

  const { data, error } = await supabase
    .from("crm_stages")
    // A autoria entra na MESMA leitura que a tela de etapas já faz. Uma segunda
    // consulta só para ela seria um round-trip por render numa tela de
    // configuração — e um caminho a mais para a lista e a autoria divergirem.
    .select("id, name, is_won, is_lost, agent_stage_hint, last_change_actor_kind, last_change_at")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);

  return { etapas: (data ?? []) as unknown as EtapaComAutoria[] };
}

/** Os sete passos sempre presentes: quem lê não precisa saber quais faltam. */
function mapaDeEtapas(etapas: EtapaDoMapa[]): Record<LeadStage, string | null> {
  const mapa = Object.fromEntries(LEAD_STAGES.map((p) => [p, null])) as Record<
    LeadStage,
    string | null
  >;
  for (const e of etapas) {
    const hint = e.agent_stage_hint;
    if (hint && (LEAD_STAGES as readonly string[]).includes(hint)) {
      mapa[hint as LeadStage] = e.id;
    }
  }
  return mapa;
}

function corpo(etapas: EtapaComAutoria[]) {
  return {
    etapas: etapas.map((e) => ({
      id: e.id,
      name: e.name,
      is_won: e.is_won,
      is_lost: e.is_lost,
      last_change_actor_kind: e.last_change_actor_kind ?? null,
      last_change_at: e.last_change_at ?? null,
    })),
    mapeamento: mapaDeEtapas(etapas),
  };
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "pipeline_agent_mapping" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id: pipelineId } = await ctx.params;
  const supabase = await createClient();

  try {
    const funil = await lerFunil(supabase, authz.org.orgId, pipelineId);
    if (!funil) return fail("not_found", t("Funil não encontrado."), 404, { requestId });
    return ok(corpo(funil.etapas), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}

export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "pipeline_agent_mapping" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail(
      "validation_failed",
      t("Envie o mapeamento completo dos sete passos do atendimento."),
      422,
      { requestId, details: parsed.error.flatten() },
    );
  }

  const supabase = await createClient();

  let funil: Awaited<ReturnType<typeof lerFunil>>;
  try {
    funil = await lerFunil(supabase, orgId, pipelineId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  // Pipeline de outra org morre AQUI, antes de qualquer escrita: responder 404
  // depois de gravar seria pior que responder 200.
  if (!funil) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  const { mapeamento } = parsed.data;

  // ⚠️ VALIDAR ANTES DE TOCAR O BANCO. O CHECK da 0084 é a rede de segurança, não
  // a primeira linha: um `23514` cru chega ao dono da clínica como "violates
  // check constraint crm_stages_hint_coerente_com_won_lost". As mensagens daqui
  // são texto de tela — vão inteiras para o corpo, sem reescrita.
  const veredito = validarMapeamento(mapeamento, funil.etapas);
  if (!veredito.ok) {
    return fail("unprocessable_entity", veredito.erros[0]!, 422, {
      requestId,
      details: { erros: veredito.erros },
    });
  }

  const updates = diffParaUpdates(funil.etapas, mapeamento);

  // ⚠️ EM SEQUÊNCIA, NA ORDEM DO DIFF. O índice único `uniq_crm_stages_pipeline_hint`
  // é imediato: as liberações precisam estar gravadas antes das ocupações, senão
  // o banco recusa. Disparar em paralelo desfaz essa proteção.
  //
  // Ceiling conhecido: não há transação — se um update falhar no meio, os
  // anteriores ficam. É recuperável porque este PUT é total e idempotente
  // (reenviar o mesmo mapa converge) e a resposta de erro não mente sobre o
  // estado; a saída definitiva seria uma função SQL, que só vale a pena se isto
  // deixar de ser uma tela de configuração ocasional.
  for (const u of updates) {
    const { error } = await supabase
      .from("crm_stages")
      .update({ agent_stage_hint: u.hint })
      .eq("id", u.stageId)
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId);
    if (!error) continue;

    // As duas recusas do banco significam a mesma coisa para o usuário: o funil
    // mudou entre a leitura e a gravação. Nenhuma das duas pode chegar à tela
    // como texto do Postgres — `violates check constraint
    // crm_stages_hint_coerente_com_won_lost` é exatamente a mensagem que a
    // camada pura existe para evitar, e devolvê-la no 500 a traria de volta.
    const nome = funil.etapas.find((e) => e.id === u.stageId)?.name ?? "escolhida";
    const conflito: Record<string, string> = {
      "23505": `A etapa «${nome}» já está representando esse passo do atendimento.`,
      "23514": `A etapa «${nome}» mudou de papel neste funil (ganho ou perda) enquanto você editava.`,
    };
    const motivo = conflito[(error as { code?: string }).code ?? ""];
    if (motivo) {
      return fail("state_conflict", `${motivo} Recarregue a página e tente de novo.`, 409, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  if (updates.length > 0) {
    void audit({
      action: "pipeline.agent_mapping_updated",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_pipeline",
      resourceId: pipelineId,
      requestId,
      metadata: { mapeamento, updates },
    });
  }

  // Relê em vez de espelhar o que foi pedido: a tela mostra o que o banco tem,
  // inclusive se um update parcial deixou o funil diferente do mapa enviado.
  try {
    const depois = await lerFunil(supabase, orgId, pipelineId);
    if (!depois) return fail("not_found", t("Funil não encontrado."), 404, { requestId });
    return ok(corpo(depois.etapas), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}
