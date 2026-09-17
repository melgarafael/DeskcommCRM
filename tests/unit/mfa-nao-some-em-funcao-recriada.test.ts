/**
 * O PORTÃO DE MFA NÃO SOME QUANDO A FUNÇÃO É RECRIADA.
 *
 * ## O defeito, achado numa triagem (PR #789)
 *
 * Para aceitar uma chave nova em `settings.agenda`, um PR recriou
 * `fn_agenda_settings` — e escreveu o corpo novo a partir da versão ORIGINAL da
 * função, não da que estava em vigor. No caminho perdeu a linha
 *
 *     if not public.fn_session_mfa_proven() then raise exception ...
 *
 * que a migration 0229 tinha acrescentado. `create or replace` troca a
 * definição inteira e não avisa o que sumiu.
 *
 * ⚠️ O ALCANCE PASSA DO TESTE. O apêndice do `supabase/baseline.sql` repetia o
 * mesmo corpo, e o baseline é o que o `update.sh` re-aplica: a atualização
 * REMOVERIA de quem já rodava uma proteção que ele tinha. E a verificação
 * migration↔baseline passava verde, porque o espelho estava fiel — fiel
 * carregando o defeito.
 *
 * ## Por que a cerca é de CLASSE, e não deste caso
 *
 * Porque as irmãs não se parecem por fora. São 14 portões espalhados por
 * funções de agenda, Google, anonimização de contato e conexão de canal, e o
 * próximo PR que recriar qualquer uma delas comete o mesmo erro pelo mesmo
 * motivo — sem nenhuma semelhança textual com este. Consertar por instância é
 * como esse defeito volta.
 *
 * ## A regra, em uma frase
 *
 * Num arquivo aplicado de cima para baixo, a ÚLTIMA definição de uma função é a
 * que vale. Então: se alguma definição anterior de uma função tinha o portão, a
 * última também tem. Vale para o `baseline.sql` (o que o self-hoster aplica) e
 * para a cadeia de `migrations/` em ordem de versão (o que um clone replica).
 *
 * O que esta cerca NÃO faz: ela não exige portão em função nova, e não opina
 * sobre QUAIS funções deveriam tê-lo. Ela só proíbe a perda silenciosa — que é
 * o modo de falha real, porque ninguém remove um portão de propósito e sem
 * dizer.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/mfa-nao-some-em-funcao-recriada.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const BASELINE = join(RAIZ, "supabase", "baseline.sql");
const MIGRATIONS = join(RAIZ, "supabase", "migrations");

/** A prova de sessão que o produto usa como portão dentro de uma função SQL. */
const PORTAO = "fn_session_mfa_proven";

const ABERTURA = /create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(/gi;

interface Definicao {
  funcao: string;
  origem: string;
  /** Ordem de aplicação — é ela que decide quem é a última a valer. */
  posicao: number;
  temPortao: boolean;
}

/**
 * As definições de função de um arquivo SQL, na ordem em que o Postgres as
 * executa. O corpo termina no primeiro `$$;` depois da abertura: parar ali
 * evita capturar o portão da função SEGUINTE e concluir que esta o tem.
 */
function definicoesDe(sql: string, origem: string, base: number): Definicao[] {
  const achados: Definicao[] = [];
  ABERTURA.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ABERTURA.exec(sql)) !== null) {
    const fim = sql.indexOf("$$;", m.index);
    const corpo = sql.slice(m.index, fim === -1 ? sql.length : fim);
    achados.push({
      funcao: m[1]!,
      origem,
      posicao: base + m.index,
      temPortao: corpo.includes(PORTAO),
    });
  }
  return achados;
}

/**
 * As funções que perderam o portão: alguma definição anterior o tinha, e a
 * última — a que vale — não tem.
 */
function perdas(definicoes: Definicao[]): Array<{ funcao: string; tinhaEm: string; perdeuEm: string }> {
  const porFuncao = new Map<string, Definicao[]>();
  for (const d of definicoes) {
    (porFuncao.get(d.funcao) ?? porFuncao.set(d.funcao, []).get(d.funcao)!).push(d);
  }

  const saida: Array<{ funcao: string; tinhaEm: string; perdeuEm: string }> = [];
  for (const [funcao, lista] of porFuncao) {
    const ordenadas = [...lista].sort((a, b) => a.posicao - b.posicao);
    const ultima = ordenadas[ordenadas.length - 1]!;
    if (ultima.temPortao) continue;
    const anteriorComPortao = ordenadas.slice(0, -1).find((d) => d.temPortao);
    if (!anteriorComPortao) continue;
    saida.push({ funcao, tinhaEm: anteriorComPortao.origem, perdeuEm: ultima.origem });
  }
  return saida.sort((a, b) => a.funcao.localeCompare(b.funcao));
}

function relatar(lista: ReturnType<typeof perdas>): string {
  return lista
    .map(
      (p) =>
        `  public.${p.funcao}: tinha o portão em ${p.tinhaEm} e a definição que VALE (${p.perdeuEm}) não tem`,
    )
    .join("\n");
}

const baseline = readFileSync(BASELINE, "utf-8");
const definicoesDoBaseline = definicoesDe(baseline, "supabase/baseline.sql", 0);

/** Os arquivos de migration na ordem em que um clone os aplica. */
const arquivosDeMigration = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const definicoesDasMigrations = arquivosDeMigration.flatMap((arquivo, i) =>
  definicoesDe(
    readFileSync(join(MIGRATIONS, arquivo), "utf-8"),
    `supabase/migrations/${arquivo}`,
    // Cada arquivo ocupa uma faixa própria: a ordem entre arquivos é a da
    // versão, e dentro do arquivo é a do texto.
    (i + 1) * 10_000_000,
  ),
);

describe("recriar uma função não apaga o portão de MFA dela", () => {
  it("o instrumento enxerga: há portões a perder nos dois artefatos", () => {
    // CONTROLE DE VACUIDADE. Sem ele, um regex quebrado (ou um rename de
    // `fn_session_mfa_proven`) faria os dois casos abaixo passarem medindo o
    // conjunto vazio — e "nenhuma perda" leria exatamente como "tudo certo".
    expect(
      definicoesDoBaseline.filter((d) => d.temPortao).length,
      "a sonda não achou portão NENHUM no baseline: ou o parser quebrou, ou o portão mudou de nome — em qualquer dos casos esta cerca está medindo o vazio",
    ).toBeGreaterThan(5);
    expect(
      definicoesDasMigrations.filter((d) => d.temPortao).length,
      "a sonda não achou portão nenhum nas migrations: mesma cegueira, no artefato que o clone replica",
    ).toBeGreaterThan(0);
    // E que há função REALMENTE recriada — senão a regra nunca é exercida.
    const recriadas = new Set(
      definicoesDoBaseline
        .filter((d, _, todas) => todas.filter((o) => o.funcao === d.funcao).length > 1)
        .map((d) => d.funcao),
    );
    expect(recriadas.size).toBeGreaterThan(0);
  });

  it("no baseline.sql — é ele que o update.sh re-aplica em quem já instalou", () => {
    const lista = perdas(definicoesDoBaseline);
    expect(
      lista,
      "uma função que tinha portão de MFA perdeu-o na definição que vale. Isto NÃO é só um teste: o `update.sh` re-aplica este arquivo, então a atualização REMOVE de quem já rodava uma proteção que ele tinha — e o espelho migration↔baseline continua fiel, carregando o defeito.\n" +
        relatar(lista) +
        "\nConserte DERIVANDO da definição em vigor em vez de reescrever a partir da original.",
    ).toEqual([]);
  });

  it("na cadeia de migrations — é ela que um clone replica em ordem", () => {
    const lista = perdas(definicoesDasMigrations);
    expect(
      lista,
      "uma migration recriou uma função e deixou cair o portão de MFA que outra migration anterior tinha posto:\n" +
        relatar(lista) +
        "\nA forward-fix é derivar da versão em vigor — `create or replace` troca a definição inteira e não avisa o que sumiu.",
    ).toEqual([]);
  });
});
