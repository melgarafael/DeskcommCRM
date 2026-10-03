import { originFromAutomationEvent } from "@/lib/atendimento/origem-automacao";
/**
 * Ação `create_or_move_lead` — reusa os handlers core de /api/v1/leads
 * (mesmo caminho que REST/MCP) em vez de duplicar a lógica de criação/move.
 *
 * Actor = `webhook_source` com id = ruleId (ator automático; audit registra
 * actor_type=webhook_source). requestId = `rule:${ruleId}` — os handlers
 * propagam esse valor pro metadata.request_id dos eventos que emitem, e é
 * esse prefixo "rule:" que o engine (Task 8) usa pra não reprocessar os
 * eventos derivados (anti-loop profundidade 1: regra→ação→handler→evento).
 */
import { registerAction } from "@/lib/automation/actions";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import {
  escolheEtapaDeDestino,
  montaPayloadDoClone,
  recusaTrocaDeFunil,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { motivoDaPerdaDaOrigem } from "@/lib/leads/motivo-da-perda";

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const pipelineId = typeof config.pipeline_id === "string" ? config.pipeline_id : null;
  const stageId = typeof config.stage_id === "string" ? config.stage_id : null;
  if (!pipelineId || !stageId) {
    return { type: "create_or_move_lead", status: "failed", error: "missing_config" };
  }

  const handlerCtx: HandlerCtx = {
    organization_id: ctx.organizationId,
    actor: { type: "webhook_source", id: ctx.ruleId },
    requestId: `rule:${ctx.ruleId}`,
  };
  // A LINHA INTEIRA do negócio, como `buildContext` a lê (`select *` de
  // `crm_leads`): o ramo abaixo precisa de `title`, `tags`, `custom_fields` e
  // companhia quando o caminho é a transferência (#2155).
  const lead = ctx.context.lead as OrigemParaClonar | undefined;
  const contact = ctx.context.contact as
    | { id: string; name?: string | null; display_name?: string | null; phone_number?: string | null }
    | undefined;

  // `?? undefined` porque `OrigemParaClonar.contact_id` admite `null` (a linha
  // do banco) e `publicaNoContexto` aceita `string | undefined`.
  const contactId = contact?.id ?? lead?.contact_id ?? undefined;
  handlerCtx.serviceOrigin = contactId
    ? (await originFromAutomationEvent(ctx, contactId)) ?? { kind: "unavailable", reason: "origin_capture_failed" }
    : { kind: "unavailable", reason: "origin_capture_failed" };

  try {
    if (lead) {
      if (lead.pipeline_id !== pipelineId) {
        // ── O GATILHO lead.tag_added COM O NEGÓCIO EM OUTRO FUNIL: A REGRA TRANSFERE (#2155) ──
        //
        // O caminho que TRANSFERE (`transfereParaOFunil`, o mesmo da rota
        // `POST /api/v1/leads/[id]/clone`) era alcançável SÓ pelo ramo por
        // contato — e o ramo por contato roda quando o evento NÃO traz o
        // negócio. Com o negócio no evento, o galho acima devolvia
        // `cross_pipeline_move_not_allowed` e a regra "Recepção etiqueta,
        // regra transfere" ficava sem saída: `run_count = 0` e o card parado
        // no funil de entrada.
        //
        // O escopo é ESTREITO de propósito: só `lead.tag_added`. É o gatilho
        // da que a Recepção usa para etiquetar, é o que a issue mediu, e é a
        // fatia que não pede migration. Os demais gatilhos que trazem o
        // negócio (`lead.created`, `lead.stage_changed`, …) seguem recusando —
        // a proposta principal da #2155 (destino por intenção em
        // `ai_router_members`) continua fora, porque exige migration.
        if (ctx.event?.event_type === "lead.tag_added") {
          // UMA TRANSFERÊNCIA POR EVENTO: o motor monta `context` uma vez e o
          // passa a TODAS as regras aplicáveis (`engine.ts`), e o
          // `publicaNoContexto` abaixo troca o negócio do evento pelo clone.
          // Sem esta guarda, uma 2ª regra `lead.tag_added` para outro funil
          // casando no mesmo evento transferia o clone de novo (A→B→C, ou
          // A→B→A com regras opostas). Negócio no contexto que não é o do
          // evento = outra regra já o transferiu: vale a primeira, como no ramo
          // por contato.
          if (lead.id !== ctx.event.entity_id) {
            return {
              type: "create_or_move_lead",
              status: "failed",
              error: "lead_already_transferred_in_event",
            };
          }
          const transferencia = await transfereParaOFunil(ctx, handlerCtx, lead, pipelineId, stageId);
          if (!transferencia.ok) {
            return { type: "create_or_move_lead", status: "failed", error: transferencia.error };
          }
          // O CLONE é o negócio das próximas ações da regra — não o que fechou.
          publicaNoContexto(ctx, transferencia.clone, contactId);
          return {
            type: "create_or_move_lead",
            status: "success",
            detail: { transferido: String(transferencia.clone.id ?? ""), origem: lead.id },
          };
        }
        return { type: "create_or_move_lead", status: "failed", error: "cross_pipeline_move_not_allowed" };
      }
      const movido = await moveLeadHandler(ctx.admin, handlerCtx, lead.id, { to_stage_id: stageId });
      publicaNoContexto(ctx, movido, contactId);
      return { type: "create_or_move_lead", status: "success", detail: { moved: lead.id } };
    }
    if (contact) {
      // Gatilho de CONTATO não traz lead no contexto (`lib/automation/engine.ts`),
      // e sem isto a ação chamada de "criar/mover" só sabia criar: o contato
      // ganhava um negócio novo a cada vez que a regra rodava (#958). O negócio
      // procurado é o ABERTO no funil de destino — negócio de outro funil segue
      // fora, pela mesma regra que recusa mover entre funis.
      const existente = await negocioAbertoDoContato(ctx, contact.id, pipelineId);
      if (existente) {
        const movido = await moveLeadHandler(ctx.admin, handlerCtx, existente, { to_stage_id: stageId });
        publicaNoContexto(ctx, movido, contact.id);
        return { type: "create_or_move_lead", status: "success", detail: { moved: existente } };
      }

      // ── O CONTATO COM NEGÓCIO ABERTO EM OUTRO FUNIL: A REGRA TRANSFERE ───────
      //
      // Até aqui a busca era SÓ no funil de destino, e o contato que já tinha
      // negócio aberto em outro funil não era encontrado — a execução caía no
      // `createLeadHandler` logo abaixo e o cliente ficava com DOIS negócios
      // abertos, um em cada funil (#992). Nenhum aviso, nenhum erro: dois cards,
      // e a equipe sem saber qual dos dois é o de verdade.
      //
      // O caminho é o MESMO da rota `POST /api/v1/leads/[id]/clone` (o módulo
      // `lib/leads/clonar-para-funil.ts` decide o que se copia e qual etapa
      // recebe o clone; `encerraDemanda` fecha a origem). Duas implementações de
      // "trocar de funil" divergiriam na primeira mudança de uma delas.
      const emOutroFunil = await negocioAbertoEmOutroFunil(ctx, contact.id, pipelineId);
      if (emOutroFunil) {
        const transferencia = await transfereParaOFunil(ctx, handlerCtx, emOutroFunil, pipelineId, stageId);
        if (!transferencia.ok) {
          return { type: "create_or_move_lead", status: "failed", error: transferencia.error };
        }
        // O CLONE é o negócio das próximas ações da regra — não o que fechou.
        publicaNoContexto(ctx, transferencia.clone, contact.id);
        return {
          type: "create_or_move_lead",
          status: "success",
          detail: { transferido: String(transferencia.clone.id ?? ""), origem: emOutroFunil.id },
        };
      }
      const created = await createLeadHandler(ctx.admin, handlerCtx, {
        pipeline_id: pipelineId,
        stage_id: stageId,
        // O título nasce do MESMO resolvedor das telas. Remontado à mão, ele
        // gravava `Contato 543134@lid` no card do funil — e título de lead
        // não se reescreve sozinho depois.
        title: nomeDoContato(contact) ?? contact.phone_number ?? "Lead da automação",
        contact_id: contact.id,
        source: "automation",
      } as Parameters<typeof createLeadHandler>[2]);
      publicaNoContexto(ctx, created, contact.id);
      return { type: "create_or_move_lead", status: "success", detail: { created: String(created.id) } };
    }
    return { type: "create_or_move_lead", status: "skipped", detail: { reason: "no_lead_or_contact" } };
  } catch (err) {
    return {
      type: "create_or_move_lead",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * O negócio ABERTO do contato neste funil, se houver um.
 *
 * Só o funil de destino. O negócio do contato em OUTRO funil não é movido de
 * etapa (mover entre funis é recusado logo acima) — ele é o caso de
 * `negocioAbertoEmOutroFunil`, que transfere. Falha de leitura devolve `null`.
 */
async function negocioAbertoDoContato(
  ctx: ActionCtx,
  contactId: string,
  pipelineId: string,
): Promise<string | null> {
  const { data } = await ctx.admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/** As colunas que o clone precisa copiar da origem. */
const COLUNAS_DA_ORIGEM =
  "id, pipeline_id, status, title, description, contact_id, value_cents, currency, " +
  "owner_user_id, owner_agent_id, expected_close_date, tags, source, custom_fields, source_metadata";

/**
 * O negócio ABERTO do contato em qualquer OUTRO funil, se houver um.
 *
 * É o caso que a #992 mediu: o contato tem negócio aberto no funil A, a regra
 * aponta para o funil B, e sem esta leitura a ação criava um segundo negócio em
 * B em vez de levar o de A. O mais recente primeiro — o mesmo desempate de
 * `negocioAbertoDoContato`, e o mesmo comportamento quando a leitura falha
 * (`null`: a ação cria, como criava antes).
 */
async function negocioAbertoEmOutroFunil(
  ctx: ActionCtx,
  contactId: string,
  pipelineId: string,
): Promise<OrigemParaClonar | null> {
  const { data } = await ctx.admin
    .from("crm_leads")
    .select(COLUNAS_DA_ORIGEM)
    .eq("organization_id", ctx.organizationId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .neq("pipeline_id", pipelineId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as OrigemParaClonar | null) ?? null;
}

/**
 * Leva o negócio do contato para o funil da regra: clona e encerra a origem.
 *
 * Mesma ordem da rota do clone, e pelas mesmas razões: o funil de destino
 * confere a etapa, a origem confere se tem onde fechar (sem isso o clone
 * nasceria com a origem aberta — o defeito de novo, agora em dobro) e só então
 * o clone é criado e a origem encerrada como PERDIDA com o motivo da
 * transferência. O motivo é o canônico `moved_to_another_pipeline`, que não é
 * perda comercial: `fn_attendant_metrics` o exclui (migration 0266).
 *
 * Devolve o erro em vez de lançar: quem chama transforma isso no `status:
 * "failed"` da execução, que é o que a aba Atividade mostra ao operador.
 */
async function transfereParaOFunil(
  ctx: ActionCtx,
  handlerCtx: HandlerCtx,
  origem: OrigemParaClonar,
  pipelineId: string,
  stageId: string,
): Promise<{ ok: true; clone: Record<string, unknown> } | { ok: false; error: string }> {
  const recusa = recusaTrocaDeFunil(origem, pipelineId);
  if (recusa) return { ok: false, error: recusa.code };

  const { data: etapas, error: etapasErr } = await ctx.admin
    .from("crm_stages")
    .select("id, pipeline_id, position, is_won, is_lost, is_archived")
    .eq("organization_id", ctx.organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (etapasErr) return { ok: false, error: etapasErr.message };

  const destino = escolheEtapaDeDestino((etapas ?? []) as EtapaDoFunil[], stageId);
  if (!destino.ok) return { ok: false, error: destino.code };

  const { data: etapaDePerda, error: perdaErr } = await ctx.admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("pipeline_id", origem.pipeline_id)
    .eq("is_lost", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  if (perdaErr) return { ok: false, error: perdaErr.message };
  if (!etapaDePerda) return { ok: false, error: "origem_sem_etapa_de_perda" };

  const clone = await createLeadHandler(ctx.admin, handlerCtx, montaPayloadDoClone(origem, destino.etapa));

  await encerraDemanda(ctx.admin, handlerCtx, {
    leadId: origem.id,
    desfecho: "lost",
    motivo: motivoDaPerdaDaOrigem(null),
    razaoNaTimeline: "Levado para outro funil pela automação",
    payloadNaTimeline: { to_pipeline_id: pipelineId, to_lead_id: clone.id },
  });

  return { ok: true, clone: clone as unknown as Record<string, unknown> };
}

/**
 * As ações seguintes da MESMA regra passam a enxergar o lead.
 *
 * `assign_owner` lê `ctx.context.lead` e, num gatilho de contato, devolvia
 * `skipped: missing_input` mesmo depois de esta ação ter criado o negócio —
 * a execução inteira aparecia como "Parcial" na aba Atividade (#958). As
 * condições da regra já foram avaliadas quando isto roda (`engine.ts` filtra
 * `applicable` antes do laço), então escrever aqui não muda o que casou.
 */
function publicaNoContexto(ctx: ActionCtx, row: Record<string, unknown>, contactId?: string): void {
  // A LINHA INTEIRA, mesclada com o que já havia no contexto — nunca um objeto
  // com três campos. `add_tag` lê `ctx.context.lead.tags` como "as tags do
  // banco" e grava `[...prev, ...added]`: com um objeto parcial, `prev` é `[]`
  // e o UPDATE APAGA as tags existentes do negócio, inclusive a de anúncio que
  // `lib/leads/nascimento-do-lead.ts` grava. `call_webhook` projeta o mesmo
  // objeto sobre LEAD_PUBLIC_FIELDS, então o corpo entregue ao endpoint do
  // cliente encolheria em silêncio pelo mesmo motivo.
  const anterior = (ctx.context.lead ?? {}) as Record<string, unknown>;
  ctx.context.lead = {
    ...anterior,
    ...row,
    contact_id: row.contact_id ?? contactId ?? anterior.contact_id ?? null,
  };
}

registerAction({ type: "create_or_move_lead", execute });
