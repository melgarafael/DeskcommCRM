/**
 * DE ONDE VEIO a conexão do canal oficial — Embedded Signup ou token colado à mão.
 *
 * ─── Por que isto existe (issue #4074) ──────────────────────────────────────
 *
 * Hoje a única porta para o número oficial é a aba "API Oficial (Meta)": o admin
 * cola `phone_number_id`, `waba_id` e um token de usuário de sistema. A issue
 * #4074 pede a outra porta — a janela da Meta (Embedded Signup) com o app da
 * PRÓPRIA instalação. As duas gravam a MESMA linha de `channel_sessions`, e sem
 * procedência a tela (e quem depura) não consegue distinguir uma da outra: um
 * canal que nasceu de um token que vaza em 60 dias fica idêntico a um que nasceu
 * de um consentimento renovável.
 *
 * ─── O que esta fatia NÃO faz ───────────────────────────────────────────────
 *
 * Não chama a Meta, não troca código por token e não abre a janela: para isso
 * faltam `app_id` e `config_id` do Embedded Signup, que a instalação ainda não
 * tem onde guardar (ver a issue; `lib/channels/meta/app.ts` só conhece App
 * Secret e verify token). O que se prova sem credencial de terceiro é o
 * CONTRATO: a conexão passa a nascer com origem declarada, o caminho manual
 * grava a origem DELE (nunca a que o cliente pedir) e leitura de valor
 * desconhecido falha fechada em vez de rotular errado.
 *
 * ─── Estado inválido não vira rótulo ────────────────────────────────────────
 *
 * `origemGravada` devolve `ok: false` para qualquer valor fora do vocabulário —
 * inclusive caixa alta (`EMBEDDED_SIGNUP`) e string vazia. Chutar "manual"
 * nesses casos esconderia um bug de gravação atrás de uma tela que parece
 * certa. `null`/`undefined` são a exceção NOMEADA: são as linhas anteriores à
 * migration 9328, que só podiam ter nascido do formulário — a inferência é
 * explícita no campo `inferida`, não um default silencioso.
 *
 * ─── Nada de credencial no que sai daqui ────────────────────────────────────
 *
 * As funções recebem `unknown` (a coluna crua, uma linha inteira, o que o
 * chamador tiver) e devolvem objeto de chaves FECHADAS. Valor recusado não é
 * ecoado: um erro que repete o que recebeu transformaria um log de diagnóstico
 * num lugar onde o token aparece. Há teste para as duas coisas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** O vocabulário gravado em `channel_sessions.meta_connection_origin` (9328). */
export const ORIGENS_DA_CONEXAO_OFICIAL = ["embedded_signup", "token_manual"] as const;

export type OrigemDaConexaoOficial = (typeof ORIGENS_DA_CONEXAO_OFICIAL)[number];

/**
 * As duas portas, nomeadas para quem grava. A rota manual usa a constante dela —
 * origem vinda do corpo do request NÃO é aceita em lugar nenhum: procedência que
 * o cliente escolhe não é procedência.
 */
export const ORIGEM_DO_EMBEDDED_SIGNUP: OrigemDaConexaoOficial = "embedded_signup";
export const ORIGEM_DO_TOKEN_MANUAL: OrigemDaConexaoOficial = "token_manual";

export const ROTULOS_DA_ORIGEM: Record<OrigemDaConexaoOficial, string> = {
  embedded_signup: "Embedded Signup da Meta",
  token_manual: "token colado à mão",
};

export type LeituraDaOrigem =
  | {
      ok: true;
      origem: OrigemDaConexaoOficial;
      rotulo: string;
      /** `true` só para linha anterior à coluna — nunca para valor lido. */
      inferida: boolean;
    }
  | { ok: false; motivo: "origem_desconhecida" | "coluna_ausente" | "falha_de_leitura" };

function ehOrigem(valor: unknown): valor is OrigemDaConexaoOficial {
  return (
    typeof valor === "string" &&
    (ORIGENS_DA_CONEXAO_OFICIAL as readonly string[]).includes(valor)
  );
}

/**
 * O que a coluna gravada significa.
 *
 * `null`/`undefined` = linha anterior à 9328 (o canal oficial só existia pelo
 * formulário) — devolvido com `inferida: true` para a tela poder dizer "anterior
 * à 9328" em vez de afirmar uma procedência que ninguém registrou.
 */
export function origemGravada(valor: unknown): LeituraDaOrigem {
  if (valor === null || valor === undefined) {
    return {
      ok: true,
      origem: ORIGEM_DO_TOKEN_MANUAL,
      rotulo: ROTULOS_DA_ORIGEM[ORIGEM_DO_TOKEN_MANUAL],
      inferida: true,
    };
  }
  if (!ehOrigem(valor)) return { ok: false, motivo: "origem_desconhecida" };
  return { ok: true, origem: valor, rotulo: ROTULOS_DA_ORIGEM[valor], inferida: false };
}

/**
 * O patch de UPDATE da coluna — e a recusa de qualquer coisa fora do vocabulário.
 *
 * Existe para que a próxima porta (Embedded Signup) não possa gravar um literal
 * inventado sem que o teste fique vermelho. Não recebe token nem código: se
 * alguém passar a linha inteira, só a chave da origem é lida.
 */
export function patchDaOrigem(
  origem: unknown,
): { ok: true; patch: { meta_connection_origin: OrigemDaConexaoOficial } } | { ok: false; motivo: "origem_invalida" } {
  if (!ehOrigem(origem)) return { ok: false, motivo: "origem_invalida" };
  return { ok: true, patch: { meta_connection_origin: origem } };
}

/**
 * Grava a origem na sessão que ACABOU de ser conectada.
 *
 * Não lança, e não derruba a conexão: a linha já está gravada e o canal funciona
 * sem esta coluna. Num banco anterior à 9328 o PostgREST devolve 42703 e o
 * desfecho é `coluna_ausente` — é o piso de rollback do repo (código novo sobre
 * schema velho), não um erro do operador.
 *
 * `organization_id` no filtro não é decoração: o client é service role e bypassa
 * RLS; a varredura `tests/unit/canal-consulta-por-organizacao.test.ts` reprova
 * consulta a `channel_sessions` sem ele.
 */
export async function registrarOrigemDaConexao(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; origem: unknown },
): Promise<{ gravada: boolean; motivo?: "origem_invalida" | "coluna_ausente" | "falha" }> {
  const { organizationId, channelSessionId } = input;
  if (!organizationId || !channelSessionId) return { gravada: false, motivo: "falha" };

  const patch = patchDaOrigem(input.origem);
  if (!patch.ok) return { gravada: false, motivo: patch.motivo };

  try {
    const { error } = await admin
      .from("channel_sessions")
      .update(patch.patch)
      .eq("organization_id", organizationId)
      .eq("id", channelSessionId);
    if (!error) return { gravada: true };
    // Coluna ausente neste banco (migration 9328 não aplicada). No UPDATE o
    // PostgREST recusa pelo cache de schema, com PGRST204, antes de o Postgres
    // ver a instrução; 42703 é o que volta quando ela chega ao banco. Os dois
    // são o mesmo fato (precedente: COLUNA_AUSENTE em lib/channels/archived.ts).
    const codigo = (error as { code?: string }).code;
    if (codigo === "42703" || codigo === "PGRST204") {
      return { gravada: false, motivo: "coluna_ausente" };
    }
    logger.warn("[meta.origem] não gravou a origem da conexão", {
      codigo: (error as { code?: string }).code ?? null,
    });
    return { gravada: false, motivo: "falha" };
  } catch (err) {
    logger.warn("[meta.origem] falha ao gravar a origem da conexão", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { gravada: false, motivo: "falha" };
  }
}

/**
 * Lê a origem da sessão para a tela.
 *
 * Consulta PRÓPRIA e só com a coluna da origem: um banco anterior à 9328
 * responderia 42703 num select que a citasse junto do resto, e a tela perderia o
 * canal inteiro (número, WABA, URL de webhook) por causa de um EXTRA. Mesmo
 * recorte de `lerDesfechoDoWebhook` na rota.
 *
 * Nunca devolve a linha crua — o objeto de saída tem três chaves, e o token
 * cifrado que vier no dublê/na linha não tem por onde sair.
 */
export async function lerOrigemDaConexao(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string },
): Promise<LeituraDaOrigem> {
  const { organizationId, channelSessionId } = input;
  if (!organizationId || !channelSessionId) return { ok: false, motivo: "falha_de_leitura" };

  try {
    const { data, error } = await admin
      .from("channel_sessions")
      .select("meta_connection_origin")
      .eq("organization_id", organizationId)
      .eq("id", channelSessionId)
      .maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === "42703") {
        return { ok: false, motivo: "coluna_ausente" };
      }
      return { ok: false, motivo: "falha_de_leitura" };
    }
    return origemGravada((data as { meta_connection_origin?: unknown } | null)?.meta_connection_origin);
  } catch {
    // Leitura desta coluna nunca quebra a tela do canal.
    return { ok: false, motivo: "falha_de_leitura" };
  }
}
