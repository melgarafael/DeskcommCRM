/**
 * O RELATÓRIO DE VENDAS DO DESEMPENHO — a leitura, num lugar só (#4802, item 5:
 * a exportação).
 *
 * ─── Por que este módulo existe ─────────────────────────────────────────────
 *
 * A tela `/app/metrics` (Desempenho) mostra o resultado de vendas por atendente
 * — quantos negócios GANHOS, quantos perdidos, quantas conversas e quanto tempo
 * a primeira resposta levou. Esse número vinha de `fn_attendant_metrics`, lida
 * dentro da rota `/api/v1/metrics/attendants`. Exportar podia ser uma segunda
 * leitura da mesma tabela com um `WHERE` escrito de novo — e o dia em que as
 * duas divergissem ninguém saberia qual está certa, que é a mesma doutrina já
 * escrita em `lib/relatorios/comercial.ts` ("um total somado aqui, de outra
 * fonte, seria um número parecido que não bate com aquele").
 *
 * Por isso a leitura mora AQUI e as duas rotas — a da tela e a do arquivo —
 * chamam esta função: mesma RPC, mesma janela, mesmo `p_owner`, mesma
 * organização vinda do cookie validado. O arquivo não recalcula nada; ele
 * formata o que a tela recebeu.
 *
 * ─── O que este módulo NÃO responde ─────────────────────────────────────────
 *
 * Não há faturamento em R$ por funil/etapa: esse recorte não existe na tela
 * hoje (é o item 4 da mesma issue, declarado fora desta fatia). Somar
 * `crm_leads.value_cents` aqui produziria um "total de vendas" que a tela não
 * mostra — número paralelo, exatamente o que o cabeçalho acima proíbe.
 *
 * Também não há recorte por etiqueta na tela: `p_excluir_etiqueta` existe na
 * RPC e é aceito aqui para a fatia seguinte, mas quem não manda o parâmetro lê
 * o mesmo conjunto que a tela lê.
 *
 * ─── Escopo e permissão ─────────────────────────────────────────────────────
 *
 * A RPC é SECURITY INVOKER: com o client de SESSÃO, a RLS de `crm_leads` e de
 * `conversations` recorta sozinha (agent vê o que é dele; manager+ a
 * organização). As rotas que chamam este módulo decidem o PISO de papel — a da
 * tela aceita agent, a do arquivo exige `manager`, como TODA exportação do
 * produto (`contacts/export`, `audit/export`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A janela padrão do relatório: 30 dias para trás, a mesma das rotas irmãs de
 * métricas (`attendants`, `serie`, `lost`, `funil`). Exportar com outro default
 * faria o arquivo ter um número que a tela não tem.
 */
export const DIAS_DA_JANELA = 30;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Janela semiaberta: `from <= closed_at < to`. */
export interface JanelaDoRelatorio {
  from: Date;
  to: Date;
}

/** Uma etapa do funil como a tela desenha a barra dela. */
export interface EtapaDoFunil {
  stage_id: string;
  stage_name: string;
  position: number;
  count: number;
}

/** A linha de vendas de UM atendente — o que a tabela da tela mostra. */
export interface LinhaDeVendas {
  user_id: string;
  won: number;
  lost: number;
  conversations_handled: number;
  /** `null` = não medida (nenhuma conversa com par válido na janela), nunca 0. */
  avg_first_response_seconds: number | null;
  /** `null` = não medida — 0 diria "respondeu na hora zero". */
  median_first_response_seconds: number | null;
}

/** O relatório inteiro, como a tela o recebe. */
export interface RelatorioDeVendas {
  janela: JanelaDoRelatorio;
  owner_user_id: string | null;
  excluded_tag: string | null;
  excluded_conversations: number;
  funnel: EtapaDoFunil[];
  attendants: LinhaDeVendas[];
}

/**
 * A janela do relatório a partir do que veio na query.
 *
 * `null` significa janela IMPOSSÍVEL (`from` não é anterior a `to`) — quem
 * chama responde 422, como a rota da tela já faz. Aqui não se "conserta" um
 * período invertido: virar o intervalo em silêncio produziria um arquivo com
 * números de um recorte que ninguém pediu.
 */
export function janelaDoRelatorio(
  params: { from?: string | null; to?: string | null } = {},
): JanelaDoRelatorio | null {
  const to = params.to ? new Date(params.to) : new Date();
  const from = params.from
    ? new Date(params.from)
    : new Date(to.getTime() - DIAS_DA_JANELA * MS_POR_DIA);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (from.getTime() >= to.getTime()) return null;
  return { from, to };
}

/** O payload bruto da RPC, antes da normalização. */
interface PayloadDaRpc {
  funnel?: EtapaDoFunil[] | null;
  attendants?: LinhaDeVendas[] | null;
  excluded_tag?: string | null;
  excluded_conversations?: number | null;
}

export interface ParametrosDaLeitura {
  /** A organização ATIVA do cookie validado — nunca a query. */
  orgId: string;
  janela: JanelaDoRelatorio;
  /** Filtro de atendente da tela (manager+). `undefined` = todos. */
  owner_user_id?: string | null;
  /** Recorte por etiqueta do contato (`null` desliga). */
  excluir_etiqueta?: string | null;
}

export type ResultadoDaLeitura =
  { ok: true; relatorio: RelatorioDeVendas } | { ok: false; message: string };

/**
 * Lê o relatório pela MESMA RPC que a tela usa.
 *
 * A normalização é deliberadamente conservadora: linha sem o campo novo
 * (`median_first_response_seconds`, banco anterior à 0754) vira `null` — "não
 * medida", nunca `0`, que mentiria dizendo "respondeu na hora zero" — e lista
 * ausente vira lista vazia. Nada aqui inventa número.
 */
export async function lerRelatorioDeVendas(
  supabase: SupabaseClient,
  params: ParametrosDaLeitura,
): Promise<ResultadoDaLeitura> {
  const { data, error } = await supabase.rpc("fn_attendant_metrics", {
    p_org: params.orgId,
    p_from: params.janela.from.toISOString(),
    p_to: params.janela.to.toISOString(),
    p_owner: params.owner_user_id ?? undefined,
    p_excluir_etiqueta: params.excluir_etiqueta ?? null,
  });
  if (error) return { ok: false, message: error.message };

  const bruto = (data ?? {}) as unknown as PayloadDaRpc;
  return {
    ok: true,
    relatorio: {
      janela: params.janela,
      owner_user_id: params.owner_user_id ?? null,
      excluded_tag: bruto.excluded_tag ?? null,
      excluded_conversations: bruto.excluded_conversations ?? 0,
      funnel: bruto.funnel ?? [],
      attendants: (bruto.attendants ?? []).map((linha) => ({
        ...linha,
        avg_first_response_seconds: linha.avg_first_response_seconds ?? null,
        median_first_response_seconds: linha.median_first_response_seconds ?? null,
      })),
    },
  };
}
