/**
 * A leitura e a escrita do comportamento da instalação pelo NEXT — Supabase
 * admin, o mesmo caminho do molde `lib/auth/politica-de-cadastro.ts`.
 *
 * Separado de `./comportamento.ts` (que é a regra, importável pelos dois
 * runtimes) porque este arquivo importa `@/lib/env` e o cliente de banco — e
 * `@/lib/env` lança no import quando falta variável obrigatória. O motor do
 * agente é outro processo e tem o irmão `./comportamento-sql.ts`.
 *
 * Usa o admin client porque quem chama já passou por `requirePlatformAdmin()`
 * (ou pela sessão do Server Component): a linha é da INSTALAÇÃO, não de um
 * tenant, e não existe policy de RLS que a isole — ver a migration 0331.
 */
import { pisoDeExigenciaDeAssinaturaNoWebhook } from "@/lib/channels/exigencia-de-assinatura";
import { normalizarChaveDeOrcamento } from "@/lib/agent-engine/edge/llm/orcamento";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  carregarComportamento,
  invalidarComportamento,
  type ComportamentoDaInstalacao,
  type DivulgacaoDePagamento,
} from "./comportamento";

const COLUNAS =
  "orcamento_de_ia, exigir_assinatura_no_webhook, divulgacao_de_pagamento, promessa_semantica";

/**
 * O PISO do Next: o que o `.env` desta instalação declara. Responde quando a
 * linha não existe (instalação que nunca abriu a tela) e quando o processo
 * ainda não conseguiu ler o banco.
 *
 * As duas chaves do motor (`DISCLOSURE_MODE`, `PROMISE_SEMANTIC_ENABLED`) são
 * lidas aqui como `z.string()` cru em `lib/env.ts`, pelo mesmo motivo escrito
 * ao lado de `AI_BUDGET_ENFORCEMENT`: um `z.enum` que lança no import derruba o
 * processo, e derrubar o processo é o oposto do que um kill switch faz. Valor
 * irreconhecível degrada para o default do PRODUTO — que é o que o motor usa.
 */
export function pisoDaInstalacao(): ComportamentoDaInstalacao {
  return {
    orcamento_de_ia: normalizarChaveDeOrcamento(env.AI_BUDGET_ENFORCEMENT),
    exigir_assinatura_no_webhook: pisoDeExigenciaDeAssinaturaNoWebhook(),
    divulgacao_de_pagamento: modoDeDivulgacaoDoEnv(env.DISCLOSURE_MODE),
    promessa_semantica: env.PROMISE_SEMANTIC_ENABLED !== "false",
  };
}

function modoDeDivulgacaoDoEnv(valor: string | undefined): DivulgacaoDePagamento {
  return (valor ?? "").trim().toLowerCase() === "veto" ? "veto" : "inject";
}

/**
 * Lê a linha da instalação e devolve o valor EFETIVO (linha acima, `.env` como
 * piso). NUNCA LANÇA: é chamada no caminho de renderizar a tela e o card de
 * orçamento.
 */
export async function carregarComportamentoDaInstalacao(): Promise<ComportamentoDaInstalacao> {
  return carregarComportamento(async () => {
    const { data, error } = await createAdminClient()
      .from("platform_settings")
      .select(COLUNAS)
      .eq("id", 1)
      // Fora da deduplicação de `fetch` do Next dentro de um render: sem o `signal`,
      // uma 2ª leitura do MESMO render, feita depois de uma escrita ter invalidado o
      // memo, recebe a resposta de ANTES dela e a memoiza. O porquê inteiro está em
      // `lerLinha` de `lib/branding/instalacao.ts` (#1218). Nunca é abortado.
      .abortSignal(new AbortController().signal)
      .maybeSingle();

    // Erro = o banco NÃO falou; a degradação (último valor conhecido) é decisão
    // de `carregarComportamento`. Ausência de linha é outra coisa: é resposta,
    // e o `null` daqui vira o piso — não um erro.
    if (error) throw new Error(`${error.code ?? "?"}: ${error.message}`);
    return data;
  }, pisoDaInstalacao());
}

/**
 * Grava o comportamento inteiro. `upsert` e não `update`: a linha só passa a
 * existir quando alguém configura algo, e é por isso que a leitura trata "sem
 * linha" como o piso.
 *
 * Devolve `false` quando o banco recusou — quem chama transforma isso em
 * mensagem na tela, nunca em silêncio.
 */
export async function gravarComportamentoDaInstalacao(
  valores: ComportamentoDaInstalacao,
  atorUserId: string,
): Promise<boolean> {
  try {
    const { error } = await createAdminClient()
      .from("platform_settings")
      .upsert({ id: 1, ...valores, updated_by: atorUserId }, { onConflict: "id" });

    if (error) {
      logger.error("comportamento da instalação: não deu para gravar", {
        codigo: error.code,
        detalhe: error.message,
      });
      return false;
    }
    invalidarComportamento();
    return true;
  } catch (erro) {
    logger.error("comportamento da instalação: gravação falhou", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}
