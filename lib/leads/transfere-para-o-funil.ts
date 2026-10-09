import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import {
  recusaDeCamposObrigatorios,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";
import {
  escolheEtapaDeDestino,
  montaPayloadDoClone,
  recusaTrocaDeFunil,
  type EtapaDoFunil,
  type OrigemParaClonar,
} from "@/lib/leads/clonar-para-funil";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { motivoDaPerdaDaOrigem } from "@/lib/leads/motivo-da-perda";

/** As colunas que o clone precisa copiar da origem. */
export const COLUNAS_DA_ORIGEM =
  "id, pipeline_id, status, title, description, contact_id, value_cents, currency, " +
  "owner_user_id, owner_agent_id, expected_close_date, tags, source, custom_fields, source_metadata";

/** A linha COMPLETA do negócio de origem, como a automação a lê. */
export type OrigemDaTransferencia = OrigemParaClonar;

/**
 * Clona o negócio no funil de destino e encerra a origem — a ÚNICA forma de
 * trocar de funil do sistema (automação e roteador de intenção, #2155).
 *
 * Mesma ordem da rota do clone, e pelas mesmas razões: o funil de destino
 * confere a etapa, a origem confere se tem onde fechar (sem isso o clone
 * nasceria com a origem aberta — o defeito de novo, agora em dobro) e só então
 * o clone é criado e a origem encerrada como PERDIDA com o motivo da
 * transferência. A exigência de campos da etapa de perda da ORIGEM pergunta
 * ANTES do clone (#2303): `encerraDemanda` faria a mesma pergunta, mas já com
 * o clone gravado — dois abertos.
 *
 * O motivo é o canônico `moved_to_another_pipeline`, que não é
 * perda comercial: `fn_attendant_metrics` o exclui (migration 0266).
 *
 * `razaoNaTimeline` diz QUEM levou o card — a automação ou o roteador de
 * intenção —, porque é a única pista que o operador tem ao ler a linha do tempo.
 *
 * Devolve o erro em vez de lançar (uma exceção: a régua de campos obrigatórios,
 * que LANÇA o MESMO 422 `required_fields_missing` de `createLeadHandler`, para
 * os dois chamadores continuarem tratando exatamente o mesmo código): quem
 * chama transforma isso no `status: "failed"` da execução, que é o que a aba
 * Atividade mostra ao operador.
 */
export async function transfereParaOFunil(
  admin: SupabaseClient,
  organizationId: string,
  handlerCtx: HandlerCtx,
  origem: OrigemParaClonar,
  pipelineId: string,
  stageId: string | null,
  razaoNaTimeline: string,
): Promise<{ ok: true; clone: Record<string, unknown> } | { ok: false; error: string }> {
  const recusa = recusaTrocaDeFunil(origem, pipelineId);
  if (recusa) return { ok: false, error: recusa.code };

  const { data: etapas, error: etapasErr } = await admin
    .from("crm_stages")
    .select("id, pipeline_id, position, is_won, is_lost, is_archived")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (etapasErr) return { ok: false, error: etapasErr.message };

  const destino = escolheEtapaDeDestino((etapas ?? []) as EtapaDoFunil[], stageId);
  if (!destino.ok) return { ok: false, error: destino.code };

  const { data: etapaDePerda, error: perdaErr } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", origem.pipeline_id)
    .eq("is_lost", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  if (perdaErr) return { ok: false, error: perdaErr.message };
  if (!etapaDePerda) return { ok: false, error: "origem_sem_etapa_de_perda" };

  // ── A RÉGUA DE CAMPOS DA ETAPA DE PERDA DA ORIGEM, ANTES DA PRIMEIRA ESCRITA ──
  //
  // `encerraDemanda` faz esta mesma pergunta — com a MESMA função
  // (`validaCamposExigidos`) —, mas lá dentro ela só roda DEPOIS do clone já
  // gravado: a troca de funil são duas escritas sem transação entre elas. Quando
  // a etapa de perda da ORIGEM tem `obrigatorio_em` (por `ao_perder` ou por
  // etapa) com um campo que o negócio não tem, o `required_fields_missing`
  // nascia tarde e o cliente ficava com DOIS negócios abertos, um em cada funil
  // (#2303) — a recusa dizendo "nada mudou" com o clone já no destino.
  //
  // Aqui a pergunta custa uma leitura e não deixa meio-estado nenhum: se
  // recusar, o clone ainda não existe. Mesmo veredito de lá, byte a byte —
  // settings do funil da ORIGEM (fail-open: `null` = nada exigido) e destino =
  // a etapa de perda que a busca acima acabou de achar, com `desfecho: "lost"`.
  // O atalho "já estava perdido" de `encerraDemanda` (que devolve `jaEstava`
  // sem validar) não é alcançável por aqui: `recusaTrocaDeFunil` lá em cima já
  // recusou origem que não está `open`.
  //
  // A recusa é o MESMO 422 `required_fields_missing` com `details.faltando` que
  // os dois chamadores já tratam — a automação vira `status: "failed"` na aba
  // Atividade e o roteador de intenção (#2297) abre o aviso na Central apontando
  // para o negócio de origem, que continua aberto.
  const settingsDaOrigem = await settingsDoFunil(admin, origem.pipeline_id);
  const vereditoDaOrigem = validaCamposExigidos({
    lead: origem as unknown as Record<string, unknown>,
    settingsDoFunil: settingsDaOrigem,
    destino: { stageId: etapaDePerda.id, desfecho: "lost" },
    motivoDeGanho: null,
  });
  if (vereditoDaOrigem.faltando.length > 0) {
    const recusaDaOrigem = recusaDeCamposObrigatorios(
      vereditoDaOrigem.faltando,
      handlerCtx.idioma,
    );
    throw new ApiError(
      422,
      recusaDaOrigem.codigo,
      { faltando: vereditoDaOrigem.faltando },
      handlerCtx.requestId,
      recusaDaOrigem.mensagem,
    );
  }

  const clone = await createLeadHandler(admin, handlerCtx, montaPayloadDoClone(origem, destino.etapa));

  await encerraDemanda(admin, handlerCtx, {
    leadId: origem.id,
    desfecho: "lost",
    motivo: motivoDaPerdaDaOrigem(null),
    razaoNaTimeline,
    payloadNaTimeline: { to_pipeline_id: pipelineId, to_lead_id: clone.id },
  });

  return { ok: true, clone: clone as unknown as Record<string, unknown> };
}
