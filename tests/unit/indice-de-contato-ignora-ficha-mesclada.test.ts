import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { relativoEmBarraNormal } from "./helpers/caminho";

/**
 * TODO ÍNDICE ÚNICO DE IDENTIDADE EM `public.contacts` IGNORA A FICHA MESCLADA.
 *
 * Juntar duas fichas de contato não apaga a perdedora: ela fica com
 * `is_merged_into` apontando para a vencedora. Índice único que não ignora a
 * ficha morta a deixa SEGURANDO a identidade — o telefone, o e-mail, o CPF ou a
 * identidade de canal continuam ocupados por quem já não existe, e a busca
 * por aquele dado não reencontra a pessoa que está viva. É por isso que os
 * outros índices de identidade de `contacts` trazem `where is_merged_into is
 * null`: quem foi juntado sai da disputa.
 *
 * O corpus já segue a regra em 74 pontos do `baseline.sql` (medido em
 * 19/09/2026: `grep -c 'is_merged_into is null' supabase/baseline.sql`);
 * faltava quem a cobrasse de quem chega. Foi assim que o índice que o PR #963
 * traz para a identidade social nasceu sem a guarda — o único de todos — e
 * ninguém viu, porque não havia gate olhando para isso: `test:db` aplica o
 * baseline, e o índice novo ainda não está nele.
 *
 * A varredura lê os DOIS artefatos: a cadeia (`supabase/migrations/*.sql`, que
 * o Supabase CLI aplica) e o `baseline.sql` (o que o `install.sh`/`update.sh`
 * do self-host aplica). Cobrir só um deixaria metade do público sem controle —
 * mesma razão do teste irmão `apendice-do-baseline-nao-diverge-da-cadeia`.
 *
 * Ela é estática e ANTES DO BANCO de propósito: pega o defeito na origem, no
 * PR em que o índice nasce, sem depender de Docker nem de banco instalado.
 *
 * Escopo declarado: cobre `create unique index` — a forma que o corpus usa.
 * `alter table ... add constraint unique` ficaria de fora; se aparecer, este é
 * o lugar de alargar.
 */
const RAIZ = join(process.cwd(), "supabase");
const CADEIA = join(RAIZ, "migrations");
const BASELINE = join(RAIZ, "baseline.sql");

type Indice = {
  arquivo: string;
  linha: number;
  nome: string;
  ignoraMesclado: boolean;
};

/**
 * Comentário é prosa; o que se mede é o que o Postgres executa. Sem isto, uma
 * migration que cite o próprio defeito num comentário (`-- create unique index
 * ...`) nasceria vermelha sem defeito nenhum — e gate que acusa a prosa é gate
 * que se aprende a ignorar.
 */
function semComentarios(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/**
 * A DECLARAÇÃO INTEIRA, não a linha.
 *
 * O índice em questão nasce partido em duas linhas (`create unique index if not
 * exists <nome>` e, na seguinte, `on public.contacts (...)`). Varredura linha a
 * linha concluiria "não é índice de contacts" e ficaria VERDE por não ter
 * olhado — o modo de falha que esta cerca existe para não ter.
 */
function declaracoes(sql: string): { texto: string; linha: number }[] {
  const linhas = semComentarios(sql).split("\n");
  const achadas: { texto: string; linha: number }[] = [];
  for (let i = 0; i < linhas.length; i++) {
    const primeira = linhas[i] ?? "";
    if (!/^\s*create\s+unique\s+index\b/i.test(primeira)) continue;
    let texto = primeira;
    let fim = i;
    while (!texto.includes(";") && fim + 1 < linhas.length) {
      fim++;
      texto += " " + (linhas[fim] ?? "");
    }
    achadas.push({ texto, linha: i + 1 });
    i = fim;
  }
  return achadas;
}

/**
 * Aspas e caixa são escolha de quem escreveu: o `pg_dump` despeja
 * `"public"."contacts"` em maiúsculas e a mão humana escreve `public.contacts`.
 * O Postgres executa o mesmo.
 */
function normalizar(texto: string): string {
  return texto.toLowerCase().replace(/"/g, "").replace(/\s+/g, " ").trim();
}

export function varrer(nomeDoArquivo: string, sql: string): Indice[] {
  return declaracoes(sql).flatMap(({ texto, linha }) => {
    const n = normalizar(texto);
    if (!/\bon public\.contacts\b/.test(n)) return [];
    return [
      {
        arquivo: nomeDoArquivo,
        linha,
        nome: /create unique index(?: if not exists)? ([a-z0-9_]+)/.exec(n)?.[1] ?? "(sem nome)",
        ignoraMesclado: n.includes("is_merged_into is null"),
      },
    ];
  });
}

const ARQUIVOS = [
  ...readdirSync(CADEIA)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(CADEIA, f)),
  BASELINE,
];

const CORPUS = ARQUIVOS.flatMap((caminho) =>
  varrer(relativoEmBarraNormal(process.cwd(), caminho), readFileSync(caminho, "utf8")),
);

describe("índice único de identidade em public.contacts", () => {
  it("ignora a ficha mesclada — na cadeia e no baseline", () => {
    const semGuarda = CORPUS.filter((i) => !i.ignoraMesclado).map(
      (i) => `${i.arquivo}:${i.linha} — ${i.nome} cria índice único sem "where is_merged_into is null"`,
    );
    expect(semGuarda).toEqual([]);
  });

  it("enxerga o corpus que existe — varredura que não acha nada é varredura que não olhou", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(5);
    expect(CORPUS.some((i) => i.arquivo.includes("migrations/"))).toBe(true);
    expect(CORPUS.some((i) => i.arquivo.endsWith("baseline.sql"))).toBe(true);
  });

  it("acusa o defeito e absolve o conserto", () => {
    const defeito =
      "create unique index if not exists contacts_org_social_identity_unique\n  on public.contacts (organization_id, social_identity);\n";
    const conserto =
      "create unique index if not exists contacts_org_social_identity_unique\n  on public.contacts (organization_id, social_identity)\n  where is_merged_into is null;\n";
    // O mesmo índice como o `pg_dump` o despeja: guarda na MESMA linha, em
    // maiúsculas e entre aspas.
    const despejo =
      'CREATE UNIQUE INDEX IF NOT EXISTS "uniq_contacts_org_phone" ON "public"."contacts" USING "btree" ("organization_id", "phone_number") WHERE (("phone_number" IS NOT NULL) AND ("is_merged_into" IS NULL));\n';

    const noDefeito = varrer("defeito.sql", defeito);
    expect(noDefeito.map((i) => i.nome)).toEqual(["contacts_org_social_identity_unique"]);
    expect(noDefeito.map((i) => i.ignoraMesclado)).toEqual([false]);

    expect(varrer("conserto.sql", conserto).map((i) => i.ignoraMesclado)).toEqual([true]);
    expect(varrer("despejo.sql", despejo).map((i) => i.ignoraMesclado)).toEqual([true]);

    expect(varrer("prosa.sql", `-- ${defeito}`)).toEqual([]);
    expect(varrer("outro_alvo.sql", "create unique index if not exists x on public.contacts_arquivo (organization_id);")).toEqual(
      [],
    );
  });
});
