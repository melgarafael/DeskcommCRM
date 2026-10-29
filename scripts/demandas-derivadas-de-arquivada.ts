/**
 * Diagnóstico SOMENTE-LEITURA das demandas abertas derivadas de conversa
 * arquivada (#2992).
 *
 * ## O que este script faz
 *
 * Roda `supabase/diagnostico/demandas-derivadas-de-arquivada.sql` numa transação
 * `read only` e imprime a contagem por categoria — derivada limpa, ambígua,
 * legítima — no total e por organização. Não encerra, não apaga, não inventa
 * desfecho: a issue pede medir antes de escolher, e a escolha não é deste
 * arquivo.
 *
 * ## Por que `read only` e não só "eu prometo que não escrevo"
 *
 * `begin transaction read only` faz o BANCO recusar escrita — não o script.
 * Se o .sql for editado um dia para encerrar em massa, esta consulta falha com
 * erro do Postgres em vez de rodar; e `conferirSomenteLeitura` recusa antes de
 * abrir conexão, para o erro chegar sem tocar em banco nenhum.
 *
 * ## Uso
 *
 *   DATABASE_URL='postgres://…' npx tsx scripts/demandas-derivadas-de-arquivada.ts
 *
 *   --sql <caminho>   consulta alternativa (o padrão é o arquivo da casa)
 *
 * stdout: TSV `categoria<TAB>organizacao<TAB>demandas`, mais as linhas TOTAL.
 * stderr: o relatório legível. Sem `console.log` de prosa no stdout, como pede
 * `scripts/README.md` — o que sai no stdout é consumível por pipe.
 *
 * ## Papel do banco
 *
 * Precisa enxergar TODAS as organizações (postgres local, ou `service_role` no
 * Supabase). Com RLS e um papel de usuário, a consulta devolve só a
 * organização de quem chamou: um zero desses não é medição, e o relatório
 * diz isso quando o número de organizações é 1 — não para adivinhar, mas para
 * ninguém citar o número fora de contexto.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

import {
  conferirColunas,
  conferirSomenteLeitura,
  formatarRelatorio,
  formatarTsv,
  lerConsultaDeArquivo,
  lerLinhas,
  resumir,
} from "./demandas-derivadas-de-arquivada.leitura";

const CONSULTA_PADRAO = join("supabase", "diagnostico", "demandas-derivadas-de-arquivada.sql");

function morrer(mensagem: string): never {
  console.error(`erro: ${mensagem}`);
  process.exit(2);
}

function argumento(nome: string): string | null {
  const indice = process.argv.indexOf(nome);
  if (indice < 0) return null;
  const valor = process.argv[indice + 1];
  if (valor === undefined || valor.startsWith("--")) morrer(`${nome} exige um valor`);
  return valor;
}

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "";
if (url === "") {
  morrer("defina DATABASE_URL (ou SUPABASE_DB_URL) com a conexão do banco a medir");
}

const caminho = argumento("--sql") ?? CONSULTA_PADRAO;
if (!existsSync(caminho)) {
  morrer(
    `consulta não encontrada em '${caminho}' — rode da raiz do repositório ` +
      "ou passe --sql <caminho>",
  );
}

const consulta = lerConsultaDeArquivo(caminho);
// ANTES da conexão: termo com escrita não chega a rodar.
conferirSomenteLeitura(consulta.sql);

const cliente = new pg.Client({ connectionString: url });

async function medir(): Promise<void> {
  await cliente.connect();
  try {
    // O PONTO: o banco recusa qualquer escrita nesta transação.
    await cliente.query("begin transaction read only");
    await cliente.query("set local statement_timeout = '120s'");
    const resultado = await cliente.query(consulta.sql);
    conferirColunas(resultado.fields.map((campo) => campo.name));
    const resumo = resumir(lerLinhas(resultado.rows as ReadonlyArray<Record<string, unknown>>));
    console.log(formatarTsv(resumo));
    console.error(formatarRelatorio(resumo, consulta));
    if (resumo.porOrganizacao.length === 1) {
      console.error(
        "\naviso: uma única organização no resultado — se você conectou com papel sujeito a RLS,\n" +
          "        este número é só a sua organização, não a instalação inteira.",
      );
    }
  } finally {
    // Rollback explícito: nada desta sessão fica, nem por acidente.
    await cliente.query("rollback").catch(() => undefined);
    await cliente.end().catch(() => undefined);
  }
}

medir().catch((erro: unknown) => {
  console.error(`erro: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
});
