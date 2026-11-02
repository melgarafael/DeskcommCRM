/**
 * OUVIDORIA — A LEITURA DA MANIFESTAÇÃO (#3611, fatia 1).
 *
 * ─── Por que a leitura mora em arquivo próprio, e não junto do registro ─────
 *
 * Porque as duas têm REGRAS DIFERENTES, e juntá-las convidaria a próxima pessoa
 * a aplicar a régua de uma na outra:
 *
 *   registro → exige o módulo LIGADO e roda sem sessão (o `organization_id` vem
 *              do canal, e a única cerca de tenancy é o predicado escrito à mão);
 *   leitura  → NÃO exige o módulo ligado e roda COM sessão: desligar a porta de
 *              entrada não pode apagar nem trancar o acervo — a empresa que
 *              desliga o módulo continua devendo resposta a quem já tem
 *              protocolo, e o histórico tem de continuar legível para quem é
 *              autorizado. O que fecha a leitura é papel (`admin`), medido na
 *              ação (`app/actions/ouvidoria/ler-manifestacao.ts`) e na RLS.
 *
 * ─── Duas cercas, e a ordem importa ─────────────────────────────────────────
 *
 * 1. AQUI: `organization_id` entra no predicado de TODA leitura, sempre. Num
 *    cliente de serviço a RLS não separa nada; um `.eq("id", …)` sem a
 *    organização devolveria a manifestação do vizinho, e o vazamento não teria
 *    sintoma nenhum na tela.
 * 2. A RLS da 9030 (`fn_user_org_ids()` E `fn_role_at_least(…, 'admin')`) barra
 *    de novo, no banco, o que passar pela camada de cima.
 *
 * "Não encontrada" é a resposta ÚNICA para id que não existe, id de outra
 * organização e id malformado: distinguir os três contaria ao vizinho que a
 * manifestação existe — e manifestação é o dado mais sensível do produto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";

import type { CanalDaOuvidoria, StatusDaOuvidoria } from "./registro";

export interface ManifestacaoLida {
  id: string;
  protocolo: string;
  canal: CanalDaOuvidoria;
  texto: string;
  contactId: string | null;
  status: StatusDaOuvidoria;
  createdAt: string;
  updatedAt: string;
}

export type ResultadoDaLeitura =
  | { ok: true; manifestacao: ManifestacaoLida }
  | { ok: false; erro: "nao_encontrada" | "erro_ao_ler" };

export interface DepsDaLeitura {
  supabase: SupabaseClient;
  /** A organização ATIVA da sessão — nunca id de argumento. */
  organizationId: string;
}

const COLUNAS = "id, protocolo, canal, texto, contact_id, status, created_at, updated_at";

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Uma manifestação da organização, ou `nao_encontrada`. Nunca lança. */
export async function lerManifestacao(
  deps: DepsDaLeitura,
  id: unknown,
): Promise<ResultadoDaLeitura> {
  const lido = z.uuid().safeParse(id);
  // Id que não é id não pode existir: a resposta é a mesma de "não é sua".
  if (!lido.success) return { ok: false, erro: "nao_encontrada" };

  const { data, error } = await deps.supabase
    .from("ouvidoria_manifestacoes")
    .select(COLUNAS)
    .eq("organization_id", deps.organizationId)
    .eq("id", lido.data)
    .maybeSingle();

  if (error) {
    logger.warn("[ouvidoria] leitura da manifestação falhou", {
      organization_id: deps.organizationId,
      error: error.message,
    });
    return { ok: false, erro: "erro_ao_ler" };
  }

  const linha = objeto(data);
  if (!linha) return { ok: false, erro: "nao_encontrada" };

  return {
    ok: true,
    manifestacao: {
      id: String(linha.id),
      protocolo: String(linha.protocolo),
      canal: linha.canal as CanalDaOuvidoria,
      texto: String(linha.texto),
      contactId: linha.contact_id === null || linha.contact_id === undefined ? null : String(linha.contact_id),
      status: linha.status as StatusDaOuvidoria,
      createdAt: String(linha.created_at),
      updatedAt: String(linha.updated_at),
    },
  };
}
