import type { RegraDeFontes } from "../../fontes";
import { criarDialetoDeLeitura, type Dialeto } from "../../dialeto";
import type { ConexaoExterna } from "../../types";
import { obterPoolMysql } from "./conexao";
import { descreverTabelaMysql, listarTabelasMysql } from "./introspeccao";
import { lerTabelaMysql } from "./leitura";

export function criarDialetoMysql(conexao: ConexaoExterna, regra: RegraDeFontes): Dialeto {
  const pool = obterPoolMysql(conexao);
  const banco = conexao.database;
  return criarDialetoDeLeitura(
    {
      listarTabelas: () => listarTabelasMysql(pool, banco),
      descreverTabela: (schema, tabela) => descreverTabelaMysql(pool, banco, schema, tabela),
      lerTabela: (pedido, permitidas, opcoes) => lerTabelaMysql(pool, banco, pedido, permitidas, opcoes),
    },
    regra,
  );
}
