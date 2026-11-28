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

import { createLeadHandler, type PersistirCriacaoDeLead } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

import {
  copiarAnexosDoClone,
  copiarObjetoPeloAdmin,
  type CopiarObjetoDoStorage,
  type ResultadoDaCopiaDeAnexos,
} from "./anexos-do-clone";
import { montaPayloadDoClone, type EtapaDoFunil, type OrigemParaClonar } from "./clonar-para-funil";

export interface CloneComAnexos {
  clone: Record<string, unknown>;
  anexos: { copiados: number; falhas: number };
  /**
   * `true` quando a cópia aberta deste negócio já existia no funil e foi
   * devolvida no lugar de uma segunda (#5281). Os anexos dela NÃO são tocados
   * aqui (a contagem vem zerada): quem chama repõe com
   * `reporAnexosNaCopiaExistente`, que respeita o dono, e descreve o recibo como
   * "já existia", não como "criado".
   */
  reaproveitada: boolean;
}

/**
 * A cópia aberta deste negócio no funil — a MESMA busca de
 * `fn_levar_negocio_para_funil` (a regra que o índice único
 * `crm_leads_clone_aberto_no_funil_uidx` faz valer no banco, #5281).
 */
async function copiaAbertaNoFunil(
  db: SupabaseClient,
  organizationId: string,
  pipelineId: string,
  origemId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("crm_leads")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .eq("source_metadata->clonado_de->>lead_id", origemId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Repõe os anexos num card de destino que ESTA execução não criou — só quando o
 * dono é o mesmo da origem (#4544). Quem vê um negócio é decidido pelo
 * `owner_user_id`; com o mesmo dono, a cópia pelo cliente de serviço não
 * entrega documento a ninguém novo. Dono diferente devolve `null`.
 */
export async function reporAnexosNaCopiaExistente(
  db: SupabaseClient,
  organizationId: string,
  origem: { id: string; owner_user_id?: string | null },
  copia: Record<string, unknown>,
  copiarObjeto?: CopiarObjetoDoStorage,
): Promise<ResultadoDaCopiaDeAnexos | null> {
  const donoDaCopia = (copia.owner_user_id as string | null | undefined) ?? null;
  if (donoDaCopia !== (origem.owner_user_id ?? null)) return null;
  return copiarAnexosDoClone(
    db,
    { organizationId, origemLeadId: origem.id, destinoLeadId: String(copia.id ?? "") },
    copiarObjeto,
  );
}

/** A recusa do índice único, levada para fora do `createLeadHandler` antes de ele virar 500. */
class CopiaAbertaJaExiste extends Error {
  constructor(readonly copia: Record<string, unknown>) {
    super("copia_aberta_ja_existe");
  }
}

export interface OpcoesDoClone {
  /**
   * Ajustes no payload do clone DEPOIS do `montaPayloadDoClone` — hoje só o
   * `lead.won`, que anula `retomado_de_lead_id` (a continuação do pós-venda não
   * é uma nova TENTATIVA do mesmo negócio).
   */
  ajustes?: Record<string, unknown>;
  persistir?: PersistirCriacaoDeLead;
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
  // Sem `persistir` (a automação e o roteador de intenção, fora da transação da
  // rota), quem decide "uma cópia aberta por origem e destino" é o índice único.
  // O `23505` dele quer dizer que outra escrita gravou a cópia primeiro: a
  // resposta é essa cópia, nunca um erro, nem uma segunda. A rota passa o seu
  // próprio `persistir`, e a regra lá é a da transação.
  const persistir: PersistirCriacaoDeLead = opcoes.persistir ?? (async (linha) => {
    const resultado = await db.from("crm_leads").insert(linha).select("*").single();
    if (resultado.error?.code === "23505") {
      const copia = await copiaAbertaNoFunil(db, ctx.organization_id, etapa.pipeline_id, origem.id);
      if (copia) throw new CopiaAbertaJaExiste(copia);
    }
    return { data: resultado.data, error: resultado.error };
  });
  let clone: Record<string, unknown>;
  try {
    clone = await createLeadHandler(db, ctx, payload, { persistir });
  } catch (erro) {
    if (!(erro instanceof CopiaAbertaJaExiste)) throw erro;
    return { clone: erro.copia, anexos: { copiados: 0, falhas: 0 }, reaproveitada: true };
  }
  const anexos = await copiarAnexosDoClone(
    db,
    {
      organizationId: ctx.organization_id,
      origemLeadId: origem.id,
      destinoLeadId: String(clone.id),
    },
    opcoes.copiarObjeto ?? copiarObjetoPeloAdmin(),
  );
  return { clone, anexos, reaproveitada: false };
}
