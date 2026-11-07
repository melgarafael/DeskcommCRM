/**
 * A leitura e a escrita do MOLDE DE IA da instalação pelo Next
 * (`platform_settings.molde_de_ia_org_id`, migration 9096).
 *
 * Sem memo, de propósito, e por isso sem o irmão de `./comportamento.ts`: quem
 * USA o molde é o gatilho do banco no instante em que uma empresa nasce, e ele
 * lê a coluna direto. Do lado do Next só há a tela de Recursos opcionais e a
 * gravação dela — uma leitura por render, nenhum processo que precise lembrar
 * do valor entre requisições.
 *
 * Cliente de serviço: a linha é da INSTALAÇÃO (`platform_settings` não tem
 * policy) e o resumo lê as funções de OUTRA organização. Quem chama já passou
 * por `requirePlatformAdmin()` — o layout de `/admin` ou a server action.
 *
 * Nada aqui lança: quem chama é o render da tela, e "não deu para ler" vira
 * `undefined`/`null` com aviso no log, nunca 500 na tela onde a pessoa
 * corrigiria o problema.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resumirMolde,
  type EmpresaParaMolde,
  type FuncaoDoMolde,
  type LlmDoMolde,
  type ResumoDoMolde,
} from "@/lib/ai/molde-de-ia";
import { logger } from "@/lib/logger";
import { ehOperante, STATUS_OPERANTE } from "@/lib/organizacao/operante";

/**
 * O molde em vigor. `null` = nenhum (cada empresa nasce com o padrão do
 * produto); `undefined` = o banco não respondeu.
 */
export async function lerMoldeDeIa(db: SupabaseClient): Promise<string | null | undefined> {
  try {
    const { data, error } = await db
      .from("platform_settings")
      .select("molde_de_ia_org_id")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      logger.warn("molde de IA: não deu para ler a instalação", { codigo: error.code, detalhe: error.message });
      return undefined;
    }
    const valor = (data as { molde_de_ia_org_id?: unknown } | null)?.molde_de_ia_org_id;
    return typeof valor === "string" ? valor : null;
  } catch (erro) {
    logger.warn("molde de IA: leitura falhou", { detalhe: erro instanceof Error ? erro.message : String(erro) });
    return undefined;
  }
}

/**
 * As empresas ATIVAS, que são as que a tela oferece como molde, mais o molde em
 * vigor se ele tiver sido suspenso depois de escolhido. `null` = a leitura
 * falhou e a tela não oferece lista inventada.
 */
export async function empresasParaMolde(
  db: SupabaseClient,
  moldeAtual: string | null,
): Promise<EmpresaParaMolde[] | null> {
  try {
    const { data, error } = await db
      .from("organizations")
      .select("id, display_name, status")
      .or(moldeAtual ? `status.eq.${STATUS_OPERANTE},id.eq.${moldeAtual}` : `status.eq.${STATUS_OPERANTE}`)
      .order("display_name");
    if (error) {
      logger.warn("molde de IA: não deu para listar as empresas", { codigo: error.code, detalhe: error.message });
      return null;
    }
    // `org` no nome de propósito: é o nome da ORGANIZAÇÃO, com cadeia própria — não o
    // rótulo de contato que `tests/unit/rotulo-do-contato.test.ts` proíbe remontar.
    return ((data ?? []) as { id: string; display_name: string | null; status: string }[]).map((org) => ({
      id: org.id,
      nome: org.display_name?.trim() || org.id,
      ativa: ehOperante(org.status),
    }));
  } catch (erro) {
    logger.warn("molde de IA: listagem falhou", { detalhe: erro instanceof Error ? erro.message : String(erro) });
    return null;
  }
}

/**
 * O que uma empresa nova receberia deste molde — a mesma regra do gatilho
 * (`lib/ai/molde-de-ia.ts`), sobre as funções e o padrão gravados AGORA.
 * `null` = a empresa não existe ou a leitura falhou.
 */
export async function resumoDoMoldeNoBanco(db: SupabaseClient, orgId: string): Promise<ResumoDoMolde | null> {
  try {
    const [funcoes, org] = await Promise.all([
      db
        .from("ai_purpose_bindings")
        .select("purpose, provider, model_id, base_url, is_enabled")
        .eq("organization_id", orgId),
      db.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    ]);
    if (funcoes.error || org.error || !org.data) {
      if (funcoes.error || org.error) {
        logger.warn("molde de IA: não deu para ler o molde", {
          codigo: funcoes.error?.code ?? org.error?.code,
        });
      }
      return null;
    }
    const llm = (org.data.settings as { llm?: LlmDoMolde } | null)?.llm ?? null;
    return resumirMolde((funcoes.data ?? []) as FuncaoDoMolde[], llm);
  } catch (erro) {
    logger.warn("molde de IA: resumo falhou", { detalhe: erro instanceof Error ? erro.message : String(erro) });
    return null;
  }
}

/**
 * Grava o molde. `upsert` e não `update`: a linha da instalação só passa a
 * existir quando alguém configura algo (mesma escolha de
 * `gravarComportamentoDaInstalacao`). Só a coluna do molde vai no corpo — o
 * PostgREST funde as colunas citadas, e as outras escolhas da instalação ficam
 * como estão.
 */
export async function gravarMoldeDeIa(
  db: SupabaseClient,
  moldeId: string | null,
  atorUserId: string,
): Promise<boolean> {
  try {
    const { error } = await db
      .from("platform_settings")
      .upsert({ id: 1, molde_de_ia_org_id: moldeId, updated_by: atorUserId }, { onConflict: "id" });
    if (error) {
      logger.error("molde de IA: não deu para gravar", { codigo: error.code, detalhe: error.message });
      return false;
    }
    return true;
  } catch (erro) {
    logger.error("molde de IA: gravação falhou", { detalhe: erro instanceof Error ? erro.message : String(erro) });
    return false;
  }
}
