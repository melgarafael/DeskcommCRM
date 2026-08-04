/**
 * PATCH/DELETE /api/v1/pipelines/[id]/stages/[stageId] — renomear, marcar
 * ganho/perda, reordenar e arquivar uma etapa.
 *
 * ⚠️ DELETE ARQUIVA, NÃO APAGA. `crm_leads_stage_id_fkey` é `ON DELETE RESTRICT`:
 * etapa com negócio não pode ser apagada — e não deveria mesmo, porque o
 * histórico dos negócios aponta para ela. Por isso a operação é arquivar, e por
 * isso arquivar exige destino para os negócios (`?destino=<id>`).
 *
 * Auth: sessão por cookie, papel manager+. `organization_id` sai do JWT — nunca
 * do body nem da URL. As regras vivem em `lib/leads/stage-editing.ts` (puras,
 * testadas); aqui só há transporte e a ORDEM das escritas, que é o que os
 * índices únicos imediatos cobram.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { buildLeadActivityRow, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  posicaoEntre,
  updatesDeMarcacao,
  validarArquivamento,
  validarMarcacao,
  validarNomeDeEtapa,
  type EtapaEditavel,
  type PatchDeMarcacao,
  type UpdateDeMarcacao,
} from "@/lib/leads/stage-editing";
import { createClient } from "@/lib/supabase/server";

import { conflitoDoBanco, corpo, lerFunil } from "../_funil";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; stageId: string }>;
}

/**
 * `depois_de` é o vizinho da ESQUERDA (`null` = primeira coluna), não um número
 * de posição: quem arrasta a coluna sabe onde ela caiu, não qual fração de
 * `position` isso vira. Mandar o número da tela duplicaria a conta que
 * `posicaoEntre` já faz — e as duas divergiriam no primeiro ajuste.
 */
const bodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    is_won: z.boolean().optional(),
    is_lost: z.boolean().optional(),
    depois_de: z.string().min(1).nullable().optional(),
    // Spec 16 §9.1 — política de expiração do contexto do agente. Faixa 0..365
    // espelha o CHECK `crm_stages_context_reset_days_range` da migration 0100.
    resets_context: z.boolean().optional(),
    context_reset_after_days: z.number().int().min(0).max(365).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nada para alterar." });

/** Só estes dois campos são a política de contexto — o resto da rota é manager+. */
function tocaPoliticaDeContexto(pedido: z.infer<typeof bodySchema>): boolean {
  return pedido.resets_context !== undefined || pedido.context_reset_after_days !== undefined;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const { id: pipelineId, stageId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Não entendi o que mudar nesta etapa.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const pedido = parsed.data;

  // ⚠️ POLÍTICA DE CONTEXTO É ADMIN, O RESTO DA ROTA É MANAGER+. `requireRole` é
  // o helper ÚNICO de autorização (reimplementar a comparação de rank aqui seria
  // o anti-padrão "matriz advisória") — por isso o gate mais alto é uma SEGUNDA
  // chamada a ele, não uma conta de ROLE_RANK na mão. Só dispara quando o corpo
  // toca `resets_context`/`context_reset_after_days`; nome, papel e ordem
  // continuam manager+ como sempre.
  if (tocaPoliticaDeContexto(pedido)) {
    const authzPolitica = await requireRole("admin", { requestId, resource: "crm_stages" });
    if (!authzPolitica.ok) return authzPolitica.response;
  }

  const supabase = await createClient();

  let etapas: EtapaEditavel[] | null;
  try {
    etapas = await lerFunil(supabase, orgId, pipelineId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  // Funil ou etapa de outra org morrem AQUI, antes de qualquer escrita. O
  // `lerFunil` filtra por `organization_id`, então uma etapa de outro tenant
  // simplesmente não está nesta lista — e a resposta é a mesma de uma etapa
  // inexistente (dizer "existe, mas não é sua" já vaza a existência).
  if (!etapas) return fail("not_found", "Funil não encontrado.", 404, { requestId });
  const alvo = etapas.find((e) => e.id === stageId);
  if (!alvo) return fail("not_found", "Etapa não encontrada.", 404, { requestId });

  // ⚠️ ARQUIVADA NÃO SE EDITA — e este é o caso perigoso, não um detalhe de
  // higiene. `lerFunil` devolve as arquivadas de propósito (elas ainda ocupam
  // slug e disputam nome), e `uniq_crm_stages_pipeline_won` é PARCIAL
  // (`where is_won and is_archived = false`): marcar uma arquivada como etapa de
  // ganho passa pelo índice, libera a etapa de ganho de verdade e deixa o funil
  // com o ganho numa coluna que sumiu do quadro. `/leads/[id]/win` busca
  // `.eq("is_won", true)` SEM filtrar arquivada — o negócio fechado iria parar
  // lá. Alcançável sem má-fé: uma aba aberta antes de a etapa ser arquivada.
  if (alvo.is_archived) {
    return fail(
      "state_conflict",
      `A etapa «${alvo.name}» foi arquivada e não está mais no quadro. Recarregue a página.`,
      409,
      { requestId },
    );
  }

  // ⚠️ VALIDAR ANTES DE TOCAR O BANCO — as constraints são rede de segurança.
  if (pedido.name !== undefined) {
    const veredito = validarNomeDeEtapa(pedido.name, etapas, stageId);
    if (!veredito.ok) return fail("unprocessable_entity", veredito.erro, 422, { requestId });
  }

  const temMarcacao = pedido.is_won !== undefined || pedido.is_lost !== undefined;
  if (temMarcacao) {
    const veredito = validarMarcacao(etapas, stageId, pedido);
    if (!veredito.ok) return fail("unprocessable_entity", veredito.erro, 422, { requestId });
  }

  const patchDoAlvo: PatchDeMarcacao & {
    name?: string;
    position?: number;
    resets_context?: boolean;
    context_reset_after_days?: number;
  } = {};
  if (pedido.name !== undefined) patchDoAlvo.name = pedido.name.trim();
  if (pedido.resets_context !== undefined) patchDoAlvo.resets_context = pedido.resets_context;
  if (pedido.context_reset_after_days !== undefined) {
    patchDoAlvo.context_reset_after_days = pedido.context_reset_after_days;
  }

  if (pedido.depois_de !== undefined) {
    // Só as ativas compõem a régua: arquivada não ocupa lugar no quadro.
    const ativas = etapas.filter((e) => !e.is_archived && e.id !== stageId);
    const i = pedido.depois_de === null ? -1 : ativas.findIndex((e) => e.id === pedido.depois_de);
    if (pedido.depois_de !== null && i < 0) {
      return fail(
        "unprocessable_entity",
        "A etapa que você escolheu como vizinha não está mais no funil. Recarregue a página.",
        422,
        { requestId },
      );
    }
    const posicao = posicaoEntre(ativas[i]?.position ?? null, ativas[i + 1]?.position ?? null);
    // `posicaoEntre` devolve NaN com vizinhas de MESMA posição (funil que
    // precisa de rebalanceamento). NaN vira `null` no JSON e a coluna é NOT NULL:
    // seria um 23502 cru. Recusar aqui é a diferença entre "tente de novo" e
    // "null value in column position violates not-null constraint".
    if (!Number.isFinite(posicao)) {
      return fail(
        "state_conflict",
        "As colunas deste funil estão empatadas na ordenação. Recarregue a página e mova a etapa para outro lugar.",
        409,
        { requestId },
      );
    }
    patchDoAlvo.position = posicao;
  }

  // A marcação pode exigir DOIS updates (liberar a antiga, ocupar a nova); nome
  // e posição viajam junto com o update do alvo, nunca num terceiro.
  const updates: UpdateDeMarcacao[] = temMarcacao
    ? updatesDeMarcacao(etapas, stageId, pedido)
    : [];
  if (Object.keys(patchDoAlvo).length > 0) {
    const i = updates.findIndex((u) => u.stageId === stageId);
    if (i >= 0) updates[i] = { stageId, patch: { ...updates[i]!.patch, ...patchDoAlvo } };
    else updates.push({ stageId, patch: patchDoAlvo });
  }

  // ⚠️ EM SEQUÊNCIA, NA ORDEM QUE `updatesDeMarcacao` DEVOLVE.
  // `uniq_crm_stages_pipeline_won` e `_lost` são imediatos (não deferíveis):
  // marcar a nova antes de liberar a antiga é 23505 na cara do usuário.
  // Disparar em paralelo desfaz exatamente essa proteção.
  //
  // Ceiling conhecido: não há transação — se o segundo update falhar, o primeiro
  // fica. É recuperável porque a liberação sozinha só deixa o funil SEM etapa de
  // ganho (estado que a própria tela mostra e permite corrigir), e a resposta de
  // erro não mente sobre isso; a saída definitiva seria uma função SQL, que só
  // vale a pena se isto deixar de ser uma tela de configuração ocasional.
  for (const u of updates) {
    const { error } = await supabase
      .from("crm_stages")
      .update(u.patch)
      .eq("id", u.stageId)
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId);
    if (!error) continue;

    const nome = etapas.find((e) => e.id === u.stageId)?.name ?? "escolhida";
    const conflito = conflitoDoBanco(error as { code?: string }, nome, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }

  // ⚠️ AUDIT SEPARADO PARA POLÍTICA DE CONTEXTO. `context.policy_changed` é a
  // ação de governança que a Spec 16 exige para este par de campos — distinta de
  // `pipeline.stage_updated` (nome/papel/ordem), que só dispara quando o pedido
  // toca algo ALÉM da política (senão duas linhas de audit narrariam a mesma
  // edição de duas formas diferentes).
  const tocaOutraCoisa = pedido.name !== undefined || temMarcacao || pedido.depois_de !== undefined;
  if (updates.length > 0 && tocaOutraCoisa) {
    void audit({
      action: "pipeline.stage_updated",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_stage",
      resourceId: stageId,
      requestId,
      metadata: { pipeline_id: pipelineId, pedido, updates },
    });
  }
  if (tocaPoliticaDeContexto(pedido)) {
    void audit({
      action: "context.policy_changed",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_stage",
      resourceId: stageId,
      requestId,
      metadata: {
        pipeline_id: pipelineId,
        resets_context: pedido.resets_context,
        context_reset_after_days: pedido.context_reset_after_days,
      },
    });
  }

  try {
    const depois = await lerFunil(supabase, orgId, pipelineId);
    if (!depois) return fail("not_found", "Funil não encontrado.", 404, { requestId });
    return ok(corpo(depois), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const { id: pipelineId, stageId } = await ctx.params;
  const destinoId = req.nextUrl.searchParams.get("destino");

  const supabase = await createClient();

  let etapas: EtapaEditavel[] | null;
  try {
    etapas = await lerFunil(supabase, orgId, pipelineId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  if (!etapas) return fail("not_found", "Funil não encontrado.", 404, { requestId });
  const alvo = etapas.find((e) => e.id === stageId);
  if (!alvo) return fail("not_found", "Etapa não encontrada.", 404, { requestId });

  // Os negócios da etapa, com a contagem EXATA do banco no mesmo round-trip: a
  // contagem vai inteira para a mensagem de recusa ("escolha para onde vão os 2
  // negócios" sem dizer quantos são não ajuda ninguém a decidir), e as linhas
  // são o que a timeline de cada card precisa depois da mudança.
  const { data: negociosDaEtapa, count, error: contErr } = await supabase
    .from("crm_leads")
    .select("id, contact_id", { count: "exact" })
    .eq("organization_id", orgId)
    .eq("stage_id", stageId);
  if (contErr) return fail("internal_error", contErr.message, 500, { requestId });
  const negocios = count ?? 0;

  const veredito = validarArquivamento(etapas, stageId, { negocios, destinoId });
  // A CONTAGEM VAI EM `details`, não só dentro da frase. A tela pergunta "N
  // negócios estão nesta etapa, para onde eles vão?" e precisa do NÚMERO; extraí-lo
  // da mensagem com regex seria uma segunda régua que quebra na primeira vez que
  // alguém melhorar o texto. A frase continua sendo a mesma para quem lê.
  if (!veredito.ok) {
    return fail("unprocessable_entity", veredito.erro, 422, {
      requestId,
      // `precisa_destino` diz QUAL regra recusou. Sem ele a tela teria de
      // re-derivar o motivo ("tem negócio e não é de ganho/perda") e engoliria
      // qualquer recusa nova sobre uma etapa comum com negócios, trocando-a por
      // "para onde eles vão?" — o usuário gastaria um passo antes de ver o
      // motivo real.
      details: { negocios, precisa_destino: veredito.precisaDestino === true },
    });
  }

  // ⚠️ OS NEGÓCIOS ANDAM PRIMEIRO. Arquivar antes de mover deixaria os cards
  // apontando para uma coluna fora do quadro se a segunda escrita falhasse —
  // sumiço silencioso, o pior desfecho possível aqui.
  if (negocios > 0 && destinoId) {
    const { error } = await supabase
      .from("crm_leads")
      .update({ stage_id: destinoId })
      .eq("organization_id", orgId)
      .eq("stage_id", stageId);
    if (error) {
      // O texto do Postgres vai em `details`, não colado na frase: a mensagem é
      // o que a tela mostra ao dono da clínica, e "violates check constraint" no
      // meio dela é exatamente o que a camada pura existe para evitar.
      return fail(
        "internal_error",
        `Não consegui mover os negócios de «${alvo.name}». A etapa continua no quadro — tente de novo.`,
        500,
        { requestId, details: { erro: error.message } },
      );
    }
  }

  const { error } = await supabase
    .from("crm_stages")
    .update({ is_archived: true })
    .eq("id", stageId)
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId);
  if (error) {
    const conflito = conflitoDoBanco(error as { code?: string }, alvo.name, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }

  // ⚠️ O CARD MUDOU DE COLUNA — A LINHA DO TEMPO DELE TEM QUE DIZER POR QUÊ.
  // O `api_audit_log` registra a ação de configuração, mas nenhuma tela de lead
  // o lê: sem isto o cliente vê o card noutra coluna e a timeline não explica
  // nada (doutrina do sistema vivo, §3 — "mudança de estágio gera atividade E
  // aparece na tela"). É UM insert multi-linha: uma ida ao banco, tantas linhas
  // quantos cards de fato se moveram.
  const movidos = destinoId ? (negociosDaEtapa ?? []) : [];
  if (movidos.length > 0) {
    const destinoNome = etapas.find((e) => e.id === destinoId)?.name ?? null;
    const { error: ativErr } = await supabase.from("crm_lead_activities").insert(
      movidos.map((lead) =>
        buildLeadActivityRow({
          organizationId: orgId,
          leadId: lead.id as string,
          contactId: (lead.contact_id as string | null) ?? null,
          type: "stage_changed",
          sourceModule: "crm",
          sourceId: stageId,
          // Foi uma pessoa que arquivou a etapa — não o sistema "sozinho".
          actor: { type: "user", id: authz.user.id },
          reason: `${stageChangeReason(alvo.name, destinoNome)} (a etapa «${alvo.name}» foi arquivada)`,
          payload: {
            from_stage_id: stageId,
            to_stage_id: destinoId,
            pipeline_id: pipelineId,
            stage_archived: true,
          },
        }),
      ),
    );
    // Falha BAIXO: os cards já se moveram e a operação não pode ser desfeita por
    // causa do rastro — mas falhar baixo é escolher não bloquear, não escolher
    // não contar (`registraFalhaDeAtividade` avisa em `event_log`).
    if (ativErr) {
      await registraFalhaDeAtividade(supabase, {
        organizationId: orgId,
        leadId: movidos[0]!.id as string,
        tipo: "stage_changed",
        origem: `pipelines/${pipelineId}/stages/${stageId} DELETE (${movidos.length} negócios)`,
        erro: ativErr.message,
        requestId,
      });
    }
  }

  void audit({
    action: "pipeline.stage_archived",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_stage",
    resourceId: stageId,
    requestId,
    metadata: {
      pipeline_id: pipelineId,
      name: alvo.name,
      destino_id: destinoId,
      negocios_movidos: destinoId ? negocios : 0,
    },
  });

  try {
    const depois = await lerFunil(supabase, orgId, pipelineId);
    if (!depois) return fail("not_found", "Funil não encontrado.", 404, { requestId });
    return ok(corpo(depois), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}
