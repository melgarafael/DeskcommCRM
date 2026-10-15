/**
 * O DIALETO de uma conexão: o ÚNICO caminho por onde o assistente, o MCP externo,
 * a grade e o Testar do prompt leem o banco externo.
 *
 * Ele nasce LIGADO à conexão (pool + regra de fontes liberadas). Por isso a regra
 * de visibilidade é aplicada AQUI, uma vez — nenhuma tool nem rota decide o que
 * é visível, e uma rota nova que use o dialeto herda a regra sem lembrar dela.
 *
 * Esta fatia só tem o dialeto PostgreSQL. A interface existe para que o MySQL
 * (Fatia 4) entre atrás dela sem mudar nenhum chamador.
 */
import type pg from "pg";

import { aplicarAoCatalogo, colunasLiberadas, tabelaLiberada, type RegraDeFontes } from "./fontes";
import { descreverTabela, listarTabelas } from "./introspeccao";
import { lerTabela, type ResultadoDeLeitura } from "./leitura";
import type { PedidoDeLeitura, TabelaExterna } from "./types";

/** A leitura pediu uma tabela que o administrador não liberou. */
export class FonteNaoLiberadaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "FonteNaoLiberadaError";
  }
}

export interface Dialeto {
  /** O catálogo como o assistente e a grade o veem (já com as fontes aplicadas). */
  listarTabelas(): Promise<TabelaExterna[]>;
  /** As colunas liberadas para projeção, filtro e ordenação; `null` = não existe OU não liberada. */
  colunasDaTabela(schema: string, tabela: string): Promise<Set<string> | null>;
  lerTabela(
    pedido: PedidoDeLeitura,
    permitidas: ReadonlySet<string>,
    opcoes?: { limiteMax?: number },
  ): Promise<ResultadoDeLeitura>;
  /** SÓ para a tela de marcação (administrador): o catálogo inteiro, ignorando as fontes. */
  catalogoCompleto(): Promise<TabelaExterna[]>;
}

export function criarDialetoPostgres(pool: pg.Pool, regra: RegraDeFontes): Dialeto {
  return {
    catalogoCompleto: () => listarTabelas(pool),

    listarTabelas: async () => aplicarAoCatalogo(regra, await listarTabelas(pool)),

    colunasDaTabela: async (schema, tabela) => {
      // Fora da lista nem chega a consultar o banco de origem.
      if (!tabelaLiberada(regra, schema, tabela)) return null;
      return colunasLiberadas(regra, await descreverTabela(pool, schema, tabela));
    },

    lerTabela: async (pedido, permitidas, opcoes) => {
      if (!tabelaLiberada(regra, pedido.schema, pedido.tabela)) {
        throw new FonteNaoLiberadaError("fonte_nao_liberada");
      }
      if (regra.modo === "list") {
        // Sem coluna nenhuma visível não há o que ler — e a projeção vazia viraria `*`.
        if (permitidas.size === 0) throw new FonteNaoLiberadaError("sem_colunas_liberadas");
        // Em `list` a projeção é SEMPRE explícita: nunca `select *` numa fonte com colunas restritas.
        const colunas = pedido.colunas.length === 0 ? [...permitidas] : pedido.colunas;
        return lerTabela(pool, { ...pedido, colunas }, permitidas, opcoes);
      }
      return lerTabela(pool, pedido, permitidas, opcoes);
    },
  };
}
