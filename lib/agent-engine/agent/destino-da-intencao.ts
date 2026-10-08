import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import {
  COLUNAS_DA_ORIGEM,
  transfereParaOFunil,
  type OrigemDaTransferencia,
} from "@/lib/leads/transfere-para-o-funil";
import { abreAvisoDeDestinoRecusado } from "./aviso-de-destino-recusado";

export type StatusDoDestino =
  /** A intenção não declarou funil — o roteamento de sempre (#2155). */
  | "sem_destino"
  /** Nenhum negócio aberto do contato: não há card a mover. */
  | "sem_negocio"
  /** Dois negócios empatados: mover um seria chute (§3.2). */
  | "nao_roteado"
  /** O card já está no funil destino — nada a fazer, sem retroceder. */
  | "ja_no_destino"
  /**
   * O contato JÁ tem outro negócio aberto no funil destino: transferir criaria
   * o segundo card do mesmo cliente no mesmo funil. Não se move nada.
   */
  | "destino_ocupado"
  | "transferido"
  /** A transferência recusou (`stage_pipeline_mismatch`, etapa, etc.). */
  | "recusado";

export interface ResultadoDoDestino {
  status: StatusDoDestino;
  error?: string;
  origemId?: string;
  cloneId?: string;
}

export interface DestinoDaIntencaoDeps {
  admin: SupabaseClient;
  organizationId: string;
  /** O CONTATO do turno (`leadId` em inbound-turn), não o id do negócio. */
  contactId: string;
  destinoPipelineId: string;
  destinoStageId: string | null;
  handlerCtx: HandlerCtx;
}

/**
 * Leva o card do contato para o funil que a intenção do roteador declarou (#2155).
 *
 * O roteador escolhia o AGENTE e o card ficava no funil de entrada: o agente do
 * produto não escrevia nele. Aqui o destino é aplicado com a MESMA transferência
 * das regras de automação (`transfereParaOFunil`: clona no destino e encerra a
 * origem como transferência) — duas implementações de "trocar de funil"
 * divergiriam na primeira mudança de uma delas.
 *
 * Quatro recusas são silenciosas e propositalmente não são erro: card já no
 * destino (idempotente em toda mensagem seguinte), destino já com negócio aberto
 * (não duplica o card do cliente), sem negócio aberto e alvo ambíguo — a única
 * coisa visível ao cliente final que este caminho pode causar é mover o card
 * errado.
 *
 * A QUINTA — `recusado`, quando a transferência é barrada (a régua de campos
 * obrigatórios do destino, entre outras) — NÃO é silenciosa desde o #2297: ela
 * abre um aviso na Central apontando para o negócio de origem, que continua
 * aberto. Silenciar uma recusa é diferente de não mover nada: aqui o card não
 * foi para onde a intenção mandou, e alguém precisa saber.
 */
export async function aplicaDestinoDaIntencao(
  deps: DestinoDaIntencaoDeps,
): Promise<ResultadoDoDestino> {
  const { data, error } = await deps.admin
    .from("crm_leads")
    .select(`${COLUNAS_DA_ORIGEM}, last_activity_at`)
    .eq("organization_id", deps.organizationId)
    .eq("contact_id", deps.contactId)
    .eq("status", "open");
  if (error) return { status: "recusado", error: error.message };

  const abertos = ((data ?? []) as unknown as OrigemDaTransferencia[]).map(
    (linha) => linha as OrigemDaTransferencia & LeadCandidate,
  );
  if (abertos.length === 0) return { status: "sem_negocio" };

  // Primeiro o DESTINO: se o contato já tem negócio aberto lá, nada se move —
  // e esta leitura vem antes de escolher o alvo, porque dois negócios abertos
  // (um em cada funil) são ambíguos para `resolveActiveLeadForContact` e cairiam
  // em `nao_roteado` com a resposta certa escondida atrás do motivo errado.
  const noDestino = abertos.filter((linha) => linha.pipeline_id === deps.destinoPipelineId);
  if (noDestino.length > 0) {
    // Um único negócio, e ele já está no destino: o card é o próprio.
    if (abertos.length === 1) return { status: "ja_no_destino", origemId: noDestino[0]!.id };
    return { status: "destino_ocupado", origemId: noDestino[0]!.id };
  }

  const alvo = resolveActiveLeadForContact(abertos);
  if (!alvo.routed) {
    return { status: "nao_roteado", error: alvo.reason };
  }

  const origem = abertos.find((linha) => linha.id === alvo.leadId);
  if (origem === undefined) return { status: "sem_negocio" };

  const transferencia = await transfereParaOFunil(
    deps.admin,
    deps.organizationId,
    deps.handlerCtx,
    origem,
    deps.destinoPipelineId,
    deps.destinoStageId,
    "Levado para outro funil pelo roteador de intenção",
  ).catch(
    // A régua LANÇA (#2297, caminho 1): `createLeadHandler` joga o 422
    // `required_fields_missing` para cima, `transfereParaOFunil` não o captura e
    // a exceção subia até o `catch` de `inbound-turn.ts` — que faz certo em não
    // derrubar a resposta ao lead, mas só conseguia registrar em `runLog`. Aqui
    // o negócio de ORIGEM é conhecido, então a recusa vira o MESMO `{ok:false}`
    // de sempre e o aviso da Central nasce junto.
    //
    // SÓ a recusa da régua (#2302): `encerraDemanda` roda DEPOIS do clone e
    // lança por conta própria (motivo inválido, falha de banco). Capturar tudo
    // fazia o aviso dizer "não move nada" com o card já criado no destino —
    // essas falhas voltam ao `catch` de `inbound-turn.ts`, como antes.
    // Resíduo conhecido: a etapa de PERDA da origem com campo exigido também
    // lança `required_fields_missing`, depois do clone, e cai aqui — o código
    // não distingue de onde ele veio.
    (err: unknown): { ok: false; error: string } => {
      if (err instanceof ApiError && err.code === "required_fields_missing") {
        return { ok: false, error: err.code };
      }
      throw err;
    },
  );
  if (!transferencia.ok) {
    await abreAvisoDeDestinoRecusado(deps.admin, {
      organizationId: deps.organizationId,
      leadId: origem.id,
      motivo: transferencia.error,
    });
    return { status: "recusado", error: transferencia.error, origemId: origem.id };
  }
  return {
    status: "transferido",
    origemId: origem.id,
    cloneId: String(transferencia.clone.id ?? ""),
  };
}
