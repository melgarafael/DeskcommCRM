/**
 * LEVAR VÁRIOS NEGÓCIOS PARA OUTRO FUNIL — o laço, sem tela e sem rede.
 *
 * ─── Por que NÃO existe rota em lote para isto ─────────────────────────────
 *
 * Levar um negócio para outro funil é `POST /api/v1/leads/[id]/clone`: recria o
 * card no destino, copia os anexos, fecha a origem com o motivo canônico e
 * confere os campos exigidos do funil — regras que moram NAQUELA rota, testadas.
 * Uma rota em lote seria uma segunda cópia de todas elas, e as duas divergiriam
 * na primeira mudança de uma (é o defeito que `transfere-para-o-funil.ts`
 * nomeia). Por isso o lote é a MESMA rota, chamada uma vez por negócio.
 *
 * ─── Um de cada vez, e o resultado é por negócio ───────────────────────────
 *
 *  - SEQUENCIAL: N pedidos simultâneos estourariam o limite de escrita da
 *    organização no meio do lote, e quem leva 40 cards não precisa de 40
 *    conexões abertas;
 *  - a recusa de UM não para os outros: o negócio sem o campo exigido pelo
 *    funil de destino volta com o motivo, e os demais seguem;
 *  - o teto é o MESMO da ação em lote (`MAX_BULK` da `leads/bulk`): 50.
 */

export const MAXIMO_DO_LOTE_ENTRE_FUNIS = 50;

export interface RecusaNoLote {
  leadId: string;
  motivo: string;
}

export interface ResultadoDoLote {
  levados: string[];
  recusados: RecusaNoLote[];
  /** Ids além do teto — não foram tentados, e a tela diz isso. */
  foraDoTeto: string[];
}

/** O motivo legível de uma falha: a mensagem da API, ou um texto genérico. */
export function motivoDaFalha(erro: unknown, generico: string): string {
  if (erro instanceof Error && erro.message.trim() !== "") return erro.message;
  return generico;
}

export async function levarEmLote(entrada: {
  leadIds: readonly string[];
  /** Leva UM negócio; lança quando a rota recusa. */
  levar: (leadId: string) => Promise<unknown>;
  /** Chamado depois de cada negócio, com quantos já foram tentados. */
  aoProgredir?: (feitos: number, total: number) => void;
  /** O texto quando a falha não traz mensagem. */
  motivoGenerico: string;
}): Promise<ResultadoDoLote> {
  const unicos = [...new Set(entrada.leadIds)];
  const lote = unicos.slice(0, MAXIMO_DO_LOTE_ENTRE_FUNIS);
  const resultado: ResultadoDoLote = {
    levados: [],
    recusados: [],
    foraDoTeto: unicos.slice(MAXIMO_DO_LOTE_ENTRE_FUNIS),
  };

  for (const [i, leadId] of lote.entries()) {
    try {
      await entrada.levar(leadId);
      resultado.levados.push(leadId);
    } catch (erro) {
      resultado.recusados.push({ leadId, motivo: motivoDaFalha(erro, entrada.motivoGenerico) });
    }
    entrada.aoProgredir?.(i + 1, lote.length);
  }
  return resultado;
}
