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
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import {
  escolheEtapaDeDestino,
  montaPayloadDoClone,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
// MESMA transferência do roteador de intenção (#2155): duas implementações de
// "trocar de funil" divergiriam na primeira mudança de uma delas.
import { COLUNAS_DA_ORIGEM, transfereParaOFunil } from "@/lib/leads/transfere-para-o-funil";
// O degrau compartilhado com a captação por webhook (#3101): "o negócio aberto
// do contato neste funil" é UMA pergunta, com um dono só.
import { negocioAbertoDoContato } from "@/lib/leads/negocio-aberto-do-contato";

/** O que a linha do tempo diz de quem levou o card — o roteador de intenção diz outra coisa. */
const RAZAO_DA_AUTOMACAO = "Levado para outro funil pela automação";

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
          const transferencia = await transfereParaOFunil(ctx.admin, ctx.organizationId, handlerCtx, lead, pipelineId, stageId, RAZAO_DA_AUTOMACAO);
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

        // ── O GATILHO lead.won COM O NEGÓCIO EM OUTRO FUNIL: A CONTINUAÇÃO (#2769) ──
        //
        // A agência fecha no funil de VENDAS e acompanha no funil de
        // PÓS-VENDA. O que a issue mediu: marcar ganho ANTES da troca escondia
        // a venda (a origem encerrava como PERDIDA com
        // `moved_to_another_pipeline`), e trocar antes de marcar ganho tirava a
        // origem dos relatórios de vendas e comissão. Os dois cantos da
        // bifurcação perdiam dado — e a saída manual ("levar o card para
        // Experiência") dependia de alguém lembrar.
        //
        // Aqui NADA é transferido: o negócio que ganhou fica GANHO, na mesma
        // etapa, intocado, e nasce um card NOVO no funil de destino com o
        // conteúdo daquele (o MESMO `montaPayloadDoClone` do `/clone`, então
        // título, descrição, contato, valor, dono, tags e campos personalizados
        // vêm juntos — nunca um card em branco). O vínculo dos dois cards é
        // `source_metadata.clonado_de`, que `montaPayloadDoClone` grava. O
        // ponteiro fica gravado no card novo, mas nenhuma tela o mostra ainda
        // (#2769, item 2) — e a origem não recebe ponteiro de volta.
        //
        // `retomado_de_lead_id` é anulado de propósito: `montaPayloadDoClone`
        // aponta para TODA origem encerrada, mas este card não é uma nova
        // TENTATIVA do mesmo negócio — é a continuação de um que JÁ ganhou, e
        // contar isso encheria "tentativas até ganhar" com o pós-venda.
        //
        // O escopo é ESTREITO de propósito: só `lead.won`. Os demais gatilhos
        // que trazem o negócio (`lead.lost`, `lead.stage_changed`, …) seguem
        // em `cross_pipeline_move_not_allowed` logo abaixo, e
        // `tests/invariants/automation-actions-crud.test.ts` continua
        // congelado batendo nesse erro.
        if (ctx.event?.event_type === "lead.won") {
          // UMA CONTINUAÇÃO POR EVENTO — a mesma guarda do `lead.tag_added`:
          // o motor monta `context` uma vez e o passa a TODAS as regras do
          // evento, e o `publicaNoContexto` abaixo troca o negócio do evento
          // pelo card novo. Sem isto, uma 2ª regra `lead.won` para outro funil
          // clonava a CLONAGEM. Só quando o motor declarou a entidade; sem
          // `entity_id` não há o que comparar.
          if (typeof ctx.event.entity_id === "string" && ctx.event.entity_id !== lead.id) {
            return {
              type: "create_or_move_lead",
              status: "failed",
              error: "lead_already_transferred_in_event",
            };
          }

          const { data: etapas, error: etapasErr } = await ctx.admin
            .from("crm_stages")
            .select("id, pipeline_id, position, is_won, is_lost, is_archived")
            .eq("organization_id", ctx.organizationId)
            .eq("pipeline_id", pipelineId)
            .eq("is_archived", false)
            .order("position", { ascending: true });
          if (etapasErr) {
            return { type: "create_or_move_lead", status: "failed", error: etapasErr.message };
          }
          // A MESMA escolha de etapa da transferência e do `/clone`: com
          // `stage_id` informado ele precisa ser etapa DESTE funil, e etapa de
          // fechamento é recusada — nascer pós-venda dentro de uma etapa de
          // ganho fecharia o card no instante em que ele nasce.
          //
          // `destino.texto`, não `destino.code`: a frase já vem em português
          // ("A etapa de destino é de fechamento…") e é ela que a aba Atividade
          // imprime. Mandar o código aqui seria exatamente o defeito da #1090 —
          // o operador lendo `stage_destino_terminal` no lugar de uma frase —
          // e a guarda de `tests/unit/motivo-de-parada-tem-frase.test.ts` cobra
          // todo código literal que sai destas ações. `texto` cai na fronteira
          // que a própria guarda declara: mensagem de gente, não código.
          const destino = escolheEtapaDeDestino((etapas ?? []) as EtapaDoFunil[], stageId);
          if (!destino.ok) {
            return { type: "create_or_move_lead", status: "failed", error: destino.texto };
          }

          // NÃO DUPLICAR (#2769, item 3): a chave é o NEGÓCIO de origem, não o
          // contato. Pelo contato, a 2ª venda do mesmo cliente achava o
          // pós-venda da 1ª, MOVIA aquele card de volta para a etapa inicial e
          // ficava sem card próprio; e um negócio sem contato reentregue
          // nascia duas vezes. Se a continuação DESTE negócio já existe neste
          // funil, nada se escreve.
          //
          // A falha da leitura é recusa, não "não achei": tratá-la como
          // ausência criaria o card de novo — a duplicata que esta guarda
          // existe para impedir.
          //
          // Card de pós-venda criado À MÃO antes desta regra não tem
          // `clonado_de` e não é reconhecido como continuação.
          const { data: continuacao, error: continuacaoErr } = await ctx.admin
            .from("crm_leads")
            .select("*")
            .eq("organization_id", ctx.organizationId)
            .eq("pipeline_id", pipelineId)
            .eq("source_metadata->clonado_de->>lead_id", lead.id)
            .limit(1)
            .maybeSingle();
          if (continuacaoErr) {
            return { type: "create_or_move_lead", status: "failed", error: continuacaoErr.message };
          }
          if (continuacao) {
            // As ações seguintes da regra enxergam a MESMA continuação que
            // enxergaram da primeira vez.
            publicaNoContexto(ctx, continuacao as Record<string, unknown>, contactId);
            return {
              type: "create_or_move_lead",
              status: "success",
              detail: { ja_existia: String((continuacao as { id?: unknown }).id ?? ""), origem: lead.id },
            };
          }

          const criado = await createLeadHandler(ctx.admin, handlerCtx, {
            ...montaPayloadDoClone(lead, destino.etapa),
            retomado_de_lead_id: null,
          });
          // O card novo é o negócio que as ações seguintes da regra enxergam.
          publicaNoContexto(ctx, criado, contactId);
          return {
            type: "create_or_move_lead",
            status: "success",
            detail: { criado: String(criado.id ?? ""), origem: lead.id },
          };
        }
        return { type: "create_or_move_lead", status: "failed", error: "cross_pipeline_move_not_allowed" };
      }

      // ── lead.won NO MESMO FUNIL: A AÇÃO NÃO MOVE (#1528 + #2769) ────────────
      //
      // Com a porta de `lead.won` aberta para `create_or_move_lead`, este ramo
      // (mesmo funil) volta a ser alcançável — e é EXATAMENTE o que a #1528
      // vetou: mover o negócio recém-ganho para uma etapa aberta o REABRE,
      // `lead.stage_changed` sai do reabrir, uma regra de etapa o leva de volta
      // para a etapa de ganho, e as duas se realimentam sem fim.
      //
      // Então `lead.won` só tem uma moda aqui: CRIAR a continuação noutro
      // funil (o ramo acima). O mesmo funil não é continuação — é reescrever o
      // ganho —, e a recusa diz isso com uma frase própria na aba Atividade.
      if (ctx.event?.event_type === "lead.won") {
        return {
          type: "create_or_move_lead",
          status: "failed",
          error: "continuacao_exige_outro_funil",
        };
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
      const existente = await negocioAbertoDoContato(ctx.admin, ctx.organizationId, contact.id, pipelineId);
      if (existente) {
        const movido = await moveLeadHandler(ctx.admin, handlerCtx, existente.id, { to_stage_id: stageId });
        publicaNoContexto(ctx, movido, contact.id);
        return { type: "create_or_move_lead", status: "success", detail: { moved: existente.id } };
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
        const transferencia = await transfereParaOFunil(ctx.admin, ctx.organizationId, handlerCtx, emOutroFunil, pipelineId, stageId, RAZAO_DA_AUTOMACAO);
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
      error: mensagemDeErro(err),
    };
  }
}

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
