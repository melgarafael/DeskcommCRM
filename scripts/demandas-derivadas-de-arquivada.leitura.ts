/**
 * A LEITURA do diagnóstico de demandas derivadas de conversa arquivada (#2992)
 * — módulo PURO: sem I/O de banco, sem `process.exit`, sem import de terceiro.
 *
 * ## Por que a regra NÃO mora aqui
 *
 * As três categorias (legítima, ambígua, derivada limpa) são decididas no SQL
 * (`supabase/diagnostico/demandas-derivadas-de-arquivada.sql`), e aqui só se lê
 * o que o banco devolveu. Duas cópias da mesma régua — uma em SQL e outra em
 * TypeScript — é a "segunda lista mantida à mão": a primeira que envelhecer
 * mente calada, e um diagnóstico que mente é pior que nenhum. Quem prova a
 * régua é o banco de teste (`tests/invariants/…`), rodando o arquivo .sql de
 * verdade.
 *
 * ## O que este módulo GARANTE, então
 *
 * Três coisas que o SQL não pode garantir sozinho, e que são falhas de
 * instrumento — o modo verde-por-não-medir:
 *
 *  1. **Somente-leitura.** O termo do arquivo é conferido antes de rodar: verbo
 *     de escrita fora de comentário faz o script RECUSAR em vez de executar.
 *     "Nenhum update/delete" é promessa do código, não da boa intenção de quem
 *     editar o .sql depois.
 *  2. **Forma do resultado.** Zero linhas é uma medição válida ("não há
 *     resíduo") ou um resultado quebrado, e as duas se parecem. A conferência
 *     das COLUNAS separa as duas: se o conjunto veio sem `categoria`, o zero
 *     não vale nada e isto lança.
 *  3. **Categoria desconhecida não vira contagem.** Linha com categoria fora
 *     das três aparece como erro, nunca distribuída em um balde qualquer.
 *
 * ## O que ele deliberadamente NÃO faz
 *
 * Não soma "resíduo provável" nem agrupa ambígua com limpa para dar um número
 * maior. O relatório entrega as três separadas porque a decisão de produto
 * depende de qual é qual.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** As três categorias, na ordem em que o relatório as mostra. */
export const CATEGORIAS = ["derivada_limpa", "ambigua", "legitima"] as const;

export type Categoria = (typeof CATEGORIAS)[number];

/**
 * Colunas que o resultado PRECISA ter. A ordem não importa: sem `categoria`
 * não há o que contar, e sem `organization_id` a contagem por instalação vira
 * uma linha só — o relatório afirmaria "uma instalação" para qualquer N.
 */
export const COLUNAS_EXIGIDAS = [
  "categoria",
  "motivo",
  "organization_id",
  "demanda_id",
  "aberta_em",
  "conversas",
  "canais",
  "no_card",
  "mensagens",
  "checkpoints",
  "tarefas",
] as const;

/** Uma linha do diagnóstico, já validada. */
export interface LinhaClassificada {
  readonly categoria: Categoria;
  readonly motivo: string;
  readonly organization_id: string;
  readonly demanda_id: string;
  /** Quando o backfill a abriu. `Date`, ISO ou null quando o banco não devolveu. */
  readonly aberta_em: Date | null;
  readonly conversas: number;
  readonly canais: number;
  readonly no_card: boolean;
  readonly mensagens: number;
  readonly checkpoints: number;
  readonly tarefas: number;
}

/** Contagem por categoria dentro de uma organização. */
export interface ContagemPorOrganizacao {
  readonly organization_id: string;
  readonly demandas: number;
  readonly porCategoria: Readonly<Record<Categoria, number>>;
}

export interface Resumo {
  readonly total: number;
  readonly porCategoria: Readonly<Record<Categoria, number>>;
  readonly porOrganizacao: readonly ContagemPorOrganizacao[];
  /** Menor `aberta_em` entre as candidatas; null quando não há nenhuma. */
  readonly mais_antiga: Date | null;
  readonly mais_recente: Date | null;
}

/** O arquivo de consulta, com o hash que identifica a versão que rodou. */
export interface Consulta {
  readonly sql: string;
  readonly sha256: string;
}

/**
 * O que só aparece em comentário é conversa, não comando. Tira `--` até o fim
 * da linha e `/* … *\/` inteiro antes de procurar verbo de escrita — as
 * próprias explicações desta casa citam `on delete set null`, e um detector
 * que morde comentário reprova consulta honesta.
 */
function semComentarios(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .toLowerCase();
}

/**
 * Verbos que mudam estado. `select`/`with`/`explain` passam; qualquer um destes
 * faz o script recusar o arquivo — inclusive `copy`, que escreve em arquivo, e
 * `call`/`do`, que executam bloco.
 */
const VERBOS_DE_ESCRITA =
  /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|merge|call|do|vacuum|analyze|refresh|reindex|cluster|comment\s+on)\b/;

/** O que o detector achou, se achou — null quando o termo é somente-leitura. */
export function verboDeEscrita(sql: string): string | null {
  const achado = VERBOS_DE_ESCRITA.exec(semComentarios(sql));
  return achado === null ? null : achado[0];
}

/**
 * Lança quando o termo tem escrita. A mensagem nomeia o verbo: "recusado" sem
 * o porquê manda a pessoa procurar no arquivo inteiro.
 */
export function conferirSomenteLeitura(sql: string): void {
  const verbo = verboDeEscrita(sql);
  if (verbo !== null) {
    throw new Error(
      `a consulta de diagnóstico contém '${verbo}' fora de comentário — ` +
        "este artefato é SOMENTE-LEITURA (#2992: preservar as linhas, sem encerrar nem apagar)",
    );
  }
}

/** Lê o .sql do disco e devolve o texto com o hash da versão. */
export function lerConsultaDeArquivo(caminho: string): Consulta {
  const sql = readFileSync(caminho, "utf8");
  if (sql.trim() === "") {
    throw new Error(`consulta vazia em ${caminho} — arquivo truncado não mede nada`);
  }
  return { sql, sha256: createHash("sha256").update(sql).digest("hex") };
}

/**
 * Confere que o conjunto de resultado tem as colunas exigidas. É o controle de
 * vacuidade deste instrumento: sem ele, "0 demandas" e "a consulta devolveu
 * outra coisa" imprimiriam a mesma tela.
 */
export function conferirColunas(nomes: readonly string[]): void {
  const presentes = new Set(nomes);
  const faltando = COLUNAS_EXIGIDAS.filter((coluna) => !presentes.has(coluna));
  if (faltando.length > 0) {
    throw new Error(
      `o resultado não tem as colunas ${faltando.join(", ")} — ` +
        "a contagem sairia de um conjunto que não foi o diagnóstico",
    );
  }
}

function lerNumero(valor: unknown, campo: string, demanda: string): number {
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n)) {
    throw new Error(`coluna ${campo} não numérica (${String(valor)}) na demanda ${demanda}`);
  }
  return n;
}

function lerData(valor: unknown): Date | null {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  const data = new Date(String(valor));
  return Number.isNaN(data.getTime()) ? null : data;
}

function lerBooleano(valor: unknown): boolean {
  return valor === true || valor === "t" || valor === "true";
}

/**
 * Valida e tipa as linhas cruas do banco. Categoria fora das três LANÇA: um
 * `case` do SQL que passe a devolver outro rótulo não pode entrar na conta como
 * se fosse resíduo.
 */
export function lerLinhas(cruas: readonly Readonly<Record<string, unknown>>[]): LinhaClassificada[] {
  return cruas.map((crua) => {
    const categoria = String(crua.categoria);
    if (!(CATEGORIAS as readonly string[]).includes(categoria)) {
      throw new Error(
        `categoria desconhecida '${categoria}' — o diagnóstico só conhece ${CATEGORIAS.join(", ")}`,
      );
    }
    const demanda_id = crua.demanda_id === null || crua.demanda_id === undefined ? "" : String(crua.demanda_id);
    const organization_id =
      crua.organization_id === null || crua.organization_id === undefined ? "" : String(crua.organization_id);
    if (demanda_id === "" || organization_id === "") {
      throw new Error("linha sem demanda_id ou sem organization_id — contagem por instalação ficaria cega");
    }
    return {
      categoria: categoria as Categoria,
      motivo: String(crua.motivo ?? "sem_motivo"),
      organization_id,
      demanda_id,
      aberta_em: lerData(crua.aberta_em),
      conversas: lerNumero(crua.conversas, "conversas", demanda_id),
      canais: lerNumero(crua.canais, "canais", demanda_id),
      no_card: lerBooleano(crua.no_card),
      mensagens: lerNumero(crua.mensagens, "mensagens", demanda_id),
      checkpoints: lerNumero(crua.checkpoints, "checkpoints", demanda_id),
      tarefas: lerNumero(crua.tarefas, "tarefas", demanda_id),
    };
  });
}

function zeroPorCategoria(): Record<Categoria, number> {
  return { derivada_limpa: 0, ambigua: 0, legitima: 0 };
}

/**
 * Agrega por categoria e por organização. Organização com ZERO em todas as
 * categorias não aparece — ela não tem candidata, e uma linha de zeros faria
 * o relatório crescer com o cadastro inteiro.
 */
export function resumir(linhas: readonly LinhaClassificada[]): Resumo {
  const porCategoria = zeroPorCategoria();
  const porOrganizacao = new Map<string, { demandas: number; porCategoria: Record<Categoria, number> }>();
  let maisAntiga: Date | null = null;
  let maisRecente: Date | null = null;

  for (const linha of linhas) {
    porCategoria[linha.categoria] += 1;

    const atual = porOrganizacao.get(linha.organization_id) ?? {
      demandas: 0,
      porCategoria: zeroPorCategoria(),
    };
    atual.demandas += 1;
    atual.porCategoria[linha.categoria] += 1;
    porOrganizacao.set(linha.organization_id, atual);

    if (linha.aberta_em !== null) {
      if (maisAntiga === null || linha.aberta_em < maisAntiga) maisAntiga = linha.aberta_em;
      if (maisRecente === null || linha.aberta_em > maisRecente) maisRecente = linha.aberta_em;
    }
  }

  return {
    total: linhas.length,
    porCategoria,
    porOrganizacao: [...porOrganizacao.entries()]
      .map(([organization_id, valor]) => ({
        organization_id,
        demandas: valor.demandas,
        porCategoria: valor.porCategoria,
      }))
      .sort((a, b) => b.demandas - a.demandas || a.organization_id.localeCompare(b.organization_id)),
    mais_antiga: maisAntiga,
    mais_recente: maisRecente,
  };
}

/**
 * Saída de stdout: uma linha por (categoria, organização), tabulada, mais a
 * linha TOTAL. Deliberadamente sem enfeite — é o formato que um `cut`/`awk`
 * consome depois, e o texto para gente sai em stderr.
 */
export function formatarTsv(resumo: Resumo): string {
  const linhas = ["categoria\torganizacao\tdemandas"];
  for (const organizacao of resumo.porOrganizacao) {
    for (const categoria of CATEGORIAS) {
      const quantidade = organizacao.porCategoria[categoria];
      if (quantidade > 0) {
        linhas.push(`${categoria}\t${organizacao.organization_id}\t${quantidade}`);
      }
    }
  }
  for (const categoria of CATEGORIAS) {
    linhas.push(`${categoria}\tTOTAL\t${resumo.porCategoria[categoria]}`);
  }
  linhas.push(`total\tTOTAL\t${resumo.total}`);
  return linhas.join("\n");
}

const ROTULO: Readonly<Record<Categoria, string>> = {
  derivada_limpa: "derivada limpa (resíduo do backfill)",
  ambigua: "ambígua (precisa de decisão)",
  legitima: "legítima (não é resíduo)",
};

function dataCurta(data: Date | null): string {
  return data === null ? "—" : data.toISOString().slice(0, 10);
}

/**
 * O relatório para olho humano (stderr). Diz o que cada número É e o que ele
 * NÃO autoriza — porque um relatório que só conta convida a agir sobre ele.
 */
export function formatarRelatorio(resumo: Resumo, consulta: Consulta): string {
  const linhas: string[] = [];
  linhas.push("Diagnóstico #2992 — demandas abertas derivadas de conversa arquivada");
  linhas.push(`consulta sha256 ${consulta.sha256.slice(0, 16)}… · somente-leitura (transação read only)`);
  linhas.push("");
  linhas.push(`candidatas: ${resumo.total} · organizações: ${resumo.porOrganizacao.length}`);
  if (resumo.total > 0) {
    linhas.push(`abertas entre ${dataCurta(resumo.mais_antiga)} e ${dataCurta(resumo.mais_recente)}`);
  }
  linhas.push("");
  for (const categoria of CATEGORIAS) {
    linhas.push(`  ${String(resumo.porCategoria[categoria]).padStart(6)}  ${ROTULO[categoria]}`);
  }
  if (resumo.porOrganizacao.length > 0) {
    linhas.push("");
    linhas.push("por organização:");
    for (const organizacao of resumo.porOrganizacao) {
      const partes = CATEGORIAS.filter((categoria) => organizacao.porCategoria[categoria] > 0).map(
        (categoria) => `${categoria}=${organizacao.porCategoria[categoria]}`,
      );
      linhas.push(`  ${organizacao.organization_id}  ${partes.join(" ")}`);
    }
  }
  linhas.push("");
  linhas.push("Nada foi escrito: o diagnóstico é read-only e este script não encerra, não apaga");
  linhas.push("e não inventa desfecho. O destino das linhas é decisão de produto (#2992).");
  return linhas.join("\n");
}
