import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { abreCardAdicionalNoFunil } from "@/lib/leads/abre-card-adicional";
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
  /**
   * O contato já tem card num OUTRO funil de produto (e nenhum no de entrada):
   * consórcio e investimentos são produtos distintos, então nasce um segundo
   * card no destino e o do outro produto fica como está (nada é encerrado).
   */
  | "card_adicional"
  /**
   * Todos os cards abertos são de outros produtos, mas o contato JÁ PASSOU pelo
   * destino (ganhou ou perdeu lá): não nasce outro card de venda do mesmo
   * produto a cada mensagem — a regra do ramo sem card aberto (#2799).
   */
  | "ja_passou_pelo_destino"
  /**
   * Contato bloqueado (pediu para parar) ou anonimizado: não ganha card novo.
   * O pedido de parar encerra só os negócios ABERTOS; o ganho que fica é
   * justamente o que o ramo de "cliente que já comprou" lê (#2799).
   */
  | "contato_bloqueado"
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
  /**
   * Os funis de PRODUTO do roteador: o destino de cada uma das suas intenções.
   * Quem tem card em um deles e passa a falar de outro NÃO troca de funil — ganha
   * um card a mais (`card_adicional`). Card em funil que não está aqui é de
   * entrada (Recepção) e segue sendo transferido. Vazio/ausente = o roteamento
   * de sempre: toda troca é transferência.
   */
  funisDeProduto?: string[];
}

/**
 * Os funis de produto de um roteador: o destino de cada intenção sua. Lê sempre
 * do banco, no turno — o roteador é editável e não há cache de processo.
 */
export async function funisDeProdutoDoRoteador(
  admin: SupabaseClient,
  organizationId: string,
  routerId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from("ai_router_members")
    .select("pipeline_id")
    .eq("organization_id", organizationId)
    .eq("router_id", routerId)
    .not("pipeline_id", "is", null);
  // Sem a lista, o comportamento cai no de antes (transferir): nunca abre card
  // por engano porque uma leitura falhou.
  if (error) return [];
  const ids = ((data ?? []) as Array<{ pipeline_id: string | null }>).map((m) => m.pipeline_id);
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/**
 * Leva o card do contato para o funil que a intenção do roteador declarou (#2155).
 *
 * O roteador escolhia o AGENTE e o card ficava no funil de entrada: o agente do
 * produto não escrevia nele. Quando o card está num funil de ENTRADA, o destino é
 * aplicado com a MESMA transferência das regras de automação
 * (`transfereParaOFunil`: clona no destino e encerra a origem como
 * transferência) — duas implementações de "trocar de funil" divergiriam na
 * primeira mudança de uma delas.
 *
 * Quando o contato só tem card em funis de PRODUTO (ou nenhum aberto, mas um
 * ganho em outro produto), nada é transferido: o destino ganha um card a mais
 * (`card_adicional`, #2799) e o do outro produto segue vivo.
 *
 * Seis recusas são silenciosas e propositalmente não são erro: card já no
 * destino (idempotente em toda mensagem seguinte), destino já com negócio aberto
 * (não duplica o card do cliente), sem negócio aberto, alvo ambíguo, contato que
 * já passou pelo destino (`ja_passou_pelo_destino`: ganho ou perdido lá não
 * ganha outro) e contato bloqueado ou anonimizado (`contato_bloqueado`: não
 * ganha card novo) — o que este caminho pode causar de visível ao cliente final
 * é mover ou abrir o card errado.
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
  const funisDeProduto = deps.funisDeProduto ?? [];
  if (abertos.length === 0) {
    // Sem card aberto: o cliente que JÁ FECHOU um produto e agora fala de outro
    // ganha o card do novo (o consórcio ganho não deixa o investimento sem card).
    const ganho = await negocioGanhoEmOutroProduto(deps, funisDeProduto);
    if (ganho === null) return { status: "sem_negocio" };
    return abreAdicional(deps, ganho);
  }

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

  // Todos os cards abertos estão em funis de PRODUTO (e nenhum no destino): é o
  // cliente de um produto falando de outro. Não é troca de funil — o card do
  // outro produto segue vivo e o destino ganha o seu.
  const emEntrada = abertos.filter((linha) => !funisDeProduto.includes(linha.pipeline_id));
  if (emEntrada.length === 0) {
    // Nenhum card aberto no destino (filtrado acima); qualquer linha lá é um
    // negócio já fechado — quem já passou pelo destino não ganha outro.
    const { data: noDestinoFechado, error: destinoErr } = await deps.admin
      .from("crm_leads")
      .select("id")
      .eq("organization_id", deps.organizationId)
      .eq("contact_id", deps.contactId)
      .eq("pipeline_id", deps.destinoPipelineId)
      .limit(1);
    if (destinoErr) return { status: "recusado", error: destinoErr.message };
    const fechado = ((noDestinoFechado ?? []) as Array<{ id: string }>)[0];
    if (fechado !== undefined) return { status: "ja_passou_pelo_destino", origemId: fechado.id };
    return abreAdicional(deps, maisRecente(abertos));
  }

  const alvo = resolveActiveLeadForContact(emEntrada);
  if (!alvo.routed) {
    return { status: "nao_roteado", error: alvo.reason };
  }

  const origem = emEntrada.find((linha) => linha.id === alvo.leadId);
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

function maisRecente<T extends LeadCandidate>(linhas: T[]): T {
  const instante = (l: LeadCandidate) => {
    const t = new Date(l.last_activity_at ?? l.created_at).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  return [...linhas].sort((a, b) => instante(b) - instante(a))[0]!;
}

/**
 * O negócio GANHO mais recente do contato em outro funil de produto — só quando
 * ele não tem card nenhum (de qualquer status) no funil de destino. Quem já
 * passou pelo destino (ganhou ou perdeu lá) não ganha card novo a cada mensagem
 * sobre o mesmo produto.
 */
async function negocioGanhoEmOutroProduto(
  deps: DestinoDaIntencaoDeps,
  funisDeProduto: string[],
): Promise<(OrigemDaTransferencia & LeadCandidate) | null> {
  if (funisDeProduto.length === 0) return null;
  const { data, error } = await deps.admin
    .from("crm_leads")
    .select(`${COLUNAS_DA_ORIGEM}, last_activity_at`)
    .eq("organization_id", deps.organizationId)
    .eq("contact_id", deps.contactId)
    .in("pipeline_id", funisDeProduto);
  if (error) return null;

  const linhas = ((data ?? []) as unknown as OrigemDaTransferencia[]).map(
    (linha) => linha as OrigemDaTransferencia & LeadCandidate,
  );
  if (linhas.some((linha) => linha.pipeline_id === deps.destinoPipelineId)) return null;
  const ganhos = linhas.filter((linha) => linha.status === "won");
  return ganhos.length === 0 ? null : maisRecente(ganhos);
}

/** Abre o card do destino ao lado do `base`, que não é tocado. */
async function abreAdicional(
  deps: DestinoDaIntencaoDeps,
  base: OrigemDaTransferencia,
): Promise<ResultadoDoDestino> {
  // Os dois ramos que ABREM card são novos (#2799): antes deles, contato sem
  // negócio aberto não ganhava nada. Bloqueado ou anonimizado continua assim.
  // Leitura que falha ou contato que não aparece: não abre (falha fechada).
  const { data: contato, error: contatoErr } = await deps.admin
    .from("contacts")
    .select("is_blocked, is_anonymized")
    .eq("organization_id", deps.organizationId)
    .eq("id", deps.contactId)
    .maybeSingle();
  if (contatoErr) return { status: "recusado", error: contatoErr.message, origemId: base.id };
  const flags = contato as { is_blocked: boolean; is_anonymized: boolean } | null;
  if (flags === null || flags.is_blocked || flags.is_anonymized) {
    return { status: "contato_bloqueado", origemId: base.id };
  }

  const aberto = await abreCardAdicionalNoFunil(
    deps.admin,
    deps.organizationId,
    deps.handlerCtx,
    base,
    deps.destinoPipelineId,
    deps.destinoStageId,
  ).catch((err: unknown): { ok: false; error: string } => {
    // A régua de campos obrigatórios da etapa de destino: a mesma recusa e o
    // mesmo aviso da transferência. Qualquer outra falha volta ao `catch` do turno.
    if (err instanceof ApiError && err.code === "required_fields_missing") {
      return { ok: false, error: err.code };
    }
    throw err;
  });
  if (!aberto.ok) {
    await abreAvisoDeDestinoRecusado(deps.admin, {
      organizationId: deps.organizationId,
      leadId: base.id,
      motivo: aberto.error,
    });
    return { status: "recusado", error: aberto.error, origemId: base.id };
  }
  return { status: "card_adicional", origemId: base.id, cloneId: String(aberto.card.id ?? "") };
}
