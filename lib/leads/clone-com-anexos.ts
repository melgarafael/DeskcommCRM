/**
 * A CRIAÇÃO DO CARD NO OUTRO FUNIL — com os anexos (#4544).
 *
 * Trocar de funil são DUAS operações no produto: criar a linha nova em
 * `crm_leads` (via `createLeadHandler`, a mesma porta de toda criação) e copiar
 * o que estava pendurado no card de origem. Até aqui os três chamadores faziam
 * só a primeira — o `/clone` da tela, a continuação do `lead.won` e a
 * transferência do `lead.tag_added` — e cada um tinha a sua própria cópia do
 * `createLeadHandler(...montaPayloadDoClone(...))`.
 *
 * Três cópias da mesma chamada é como o defeito volta na próxima: quem
 * acrescentar um quarto caminho de troca de funil não vai lembrar do anexo.
 * Esta função é o passo único: cria o clone e copia os anexos na ORDEM certa —
 * o anexo precisa do id do card novo, que só existe depois do INSERT.
 *
 * Devolve o clone e a contagem da cópia, para quem chama poder mostrar (ou
 * registrar) o que ficou para trás.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

import { copiarAnexosDoClone, copiarObjetoPeloAdmin, type CopiarObjetoDoStorage } from "./anexos-do-clone";
import { montaPayloadDoClone, type EtapaDoFunil, type OrigemParaClonar } from "./clonar-para-funil";

export interface CloneComAnexos {
  clone: Record<string, unknown>;
  anexos: { copiados: number; falhas: number };
}

export interface OpcoesDoClone {
  /**
   * Ajustes no payload do clone DEPOIS do `montaPayloadDoClone` — hoje só o
   * `lead.won`, que anula `retomado_de_lead_id` (a continuação do pós-venda não
   * é uma nova TENTATIVA do mesmo negócio).
   */
  ajustes?: Record<string, unknown>;
  /** Injetado no teste; em produção a cópia é sempre pelo cliente de serviço. */
  copiarObjeto?: CopiarObjetoDoStorage;
}

export async function criarCloneNoFunil(
  db: SupabaseClient,
  ctx: HandlerCtx,
  origem: OrigemParaClonar,
  etapa: EtapaDoFunil,
  opcoes: OpcoesDoClone = {},
): Promise<CloneComAnexos> {
  const payload = { ...montaPayloadDoClone(origem, etapa), ...(opcoes.ajustes ?? {}) };
  const clone = await createLeadHandler(db, ctx, payload);
  const anexos = await copiarAnexosDoClone(
    db,
    {
      organizationId: ctx.organization_id,
      origemLeadId: origem.id,
      destinoLeadId: String(clone.id),
    },
    opcoes.copiarObjeto ?? copiarObjetoPeloAdmin(),
  );
  return { clone, anexos };
}
