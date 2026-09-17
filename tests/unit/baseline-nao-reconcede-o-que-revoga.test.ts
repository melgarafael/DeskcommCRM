import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O CORPO DO BASELINE NÃO RECONCEDE O QUE O APÊNDICE REVOGA.
 *
 * Irmão de `baseline-nao-constroi-o-que-derruba.test.ts`, no eixo de PERMISSÃO.
 * O `baseline.sql` é aplicado inteiro em todo `update.sh`, em autocommit. Um
 * `GRANT` no corpo do dump devolve um EXECUTE que o apêndice revoga adiante:
 * enquanto o arquivo corre, o banco fica com uma permissão a mais do que terá no
 * fim. `CREATE OR REPLACE` não altera ACL, então GRANT é a única forma de a
 * aplicação afrouxar permissão no meio do caminho.
 *
 * A regra: nenhum `grant … on function … to anon|authenticated` no CORPO (antes do
 * primeiro rótulo de apêndice) pode ser revogado adiante sem reconcessão. Ou o
 * corpo não concede, ou o revoke vem antes. O estado final é o mesmo nos dois
 * casos — quem prova isso em banco é
 * `tests/invariants/update-nao-reabre-permissao.test.ts`.
 *
 * ## Por que a assinatura precisa ser normalizada, e não comparada como texto
 *
 * O `pg_dump` emite o NOME do argumento junto do tipo
 * (`("p_org_id" "uuid", …)`), e o apêndice escreve só o tipo (`(uuid, …)`). Uma
 * primeira versão desta régua comparava o texto cru e devolveu ZERO achado sobre
 * um arquivo que tinha três — o silêncio parecia aprovação. Por isso o teste
 * derruba nome de argumento, aspas, precisão e alias de tipo antes de casar.
 */
const SQL = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");

/** Palavras que fazem parte de um TIPO (o que sobra na frente delas é nome de argumento). */
const PALAVRAS_DE_TIPO = new Set(
  ("uuid text jsonb json boolean bool integer int int4 int8 bigint smallint numeric real double precision " +
    "timestamp timestamptz with without time zone date interval bytea character varying varchar vector citext " +
    "inet record void anyelement trigger tsvector oid name regclass xml money float float8 serial array")
    .split(" "),
);

const ALIAS: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  bool: "boolean",
  timestamptz: "timestamp with time zone",
  varchar: "character varying",
  float8: "double precision",
};

export function assinatura(nome: string, args: string): string {
  const tipos = args
    .replace(/"/g, " ")
    .split(",")
    .map((arg) => {
      const toks = arg.trim().split(/\s+/).filter(Boolean);
      while (toks.length > 1 && !PALAVRAS_DE_TIPO.has(toks[0]!.toLowerCase())) toks.shift();
      if (toks.length > 1 && ["in", "out", "inout", "variadic"].includes(toks[0]!.toLowerCase())) toks.shift();
      const t = toks.join(" ").toLowerCase().replace(/\s*\(\s*\d+(\s*,\s*\d+)?\s*\)/, "");
      return ALIAS[t] ?? t;
    })
    .filter(Boolean);
  return `${nome.toLowerCase()}(${tipos.join(", ")})`;
}

interface Evento {
  pos: number;
  tipo: "grant" | "revoke";
  funcao: string;
  papeis: string[];
}

const PAPEIS_DE_CLIENTE = ["anon", "authenticated"];

function eventos(sql: string): Evento[] {
  const achados: Evento[] = [];
  const formas: Array<[Evento["tipo"], RegExp]> = [
    [
      "grant",
      /grant\s+(?:all|execute)[^;]*?\s+on\s+function\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?\s*\(([^)]*)\)\s*to\s+([^;]+);/gis,
    ],
    [
      "revoke",
      /revoke\s+(?:all|execute)[^;]*?\s+on\s+function\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?\s*\(([^)]*)\)\s*from\s+([^;]+);/gis,
    ],
  ];
  for (const [tipo, rx] of formas) {
    for (const m of sql.matchAll(rx)) {
      achados.push({
        pos: m.index!,
        tipo,
        funcao: assinatura(m[1]!, m[2]!),
        papeis: m[3]!.split(",").map((p) => p.trim().replace(/"/g, "").toLowerCase()),
      });
    }
  }
  return achados.sort((a, b) => a.pos - b.pos);
}

const linhaDe = (sql: string, pos: number) => sql.slice(0, pos).split("\n").length;

/** Primeiro rótulo de apêndice: daí para baixo é escrito à mão; acima é o dump. */
function inicioDoApendice(sql: string): number {
  const m = /^-- ---- .* \(migration \d+\) ----/m.exec(sql);
  if (!m) throw new Error("fronteira corpo/apêndice não encontrada");
  return m.index!;
}

/** `[funcao→papel]` concedidos no CORPO e revogados adiante sem reconcessão. */
export function reconcessoesDoCorpo(sql: string): string[] {
  const corpo = inicioDoApendice(sql);
  const concedidoEm = new Map<string, number>();
  const reaberturas: Array<[string, number, number]> = [];
  for (const e of eventos(sql)) {
    for (const papel of e.papeis) {
      if (!PAPEIS_DE_CLIENTE.includes(papel)) continue;
      const chave = `${e.funcao} -> ${papel}`;
      if (e.tipo === "grant") concedidoEm.set(chave, e.pos);
      else {
        const grant = concedidoEm.get(chave);
        if (grant !== undefined) reaberturas.push([chave, grant, e.pos]);
        concedidoEm.delete(chave);
      }
    }
  }
  return reaberturas
    .filter(([chave, grant]) => grant < corpo && !concedidoEm.has(chave))
    .map(
      ([chave, grant, revoke]) =>
        `${chave}: GRANT na linha ${linhaDe(sql, grant)} (corpo), REVOKE na ${linhaDe(sql, revoke)}`,
    );
}

/** Controle do instrumento: as três formas do arquivo real, e as que NÃO são defeito. */
const SINTETICO = `
GRANT ALL ON FUNCTION "public"."fn_reaberta"("p_org_id" "uuid", "p_quando" "timestamp with time zone") TO "anon";
GRANT ALL ON FUNCTION "public"."fn_so_service"("p_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."fn_fica_aberta"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_reconcedida"("p_id" "uuid") TO "authenticated";

-- ---- apêndice (migration 9999) ----
revoke execute on function public.fn_reaberta(uuid, timestamp with time zone) from public, anon;
revoke execute on function public.fn_reconcedida(uuid) from authenticated;
grant execute on function public.fn_reconcedida(uuid) to authenticated;
`;

describe("o instrumento, contra as formas do arquivo", () => {
  it("a assinatura ignora nome de argumento, aspas e alias de tipo", () => {
    // É o defeito que fez a primeira versão desta régua devolver zero: o dump
    // escreve o nome do argumento, o apêndice não.
    expect(assinatura("fn_x", '"p_org_id" "uuid", "p_quando" "timestamptz"')).toBe(
      "fn_x(uuid, timestamp with time zone)",
    );
    expect(assinatura("fn_x", "uuid, timestamptz")).toBe("fn_x(uuid, timestamp with time zone)");
    expect(assinatura("fn_x", '"p_txt" "character varying"(120)')).toBe("fn_x(character varying)");
  });

  it("acha a concessão do corpo que o apêndice revoga, e poupa as que não são defeito", () => {
    const achados = reconcessoesDoCorpo(SINTETICO);
    expect(achados).toEqual([expect.stringMatching(/^fn_reaberta\(uuid, timestamp with time zone\) -> anon: /)]);
    // service_role não é papel de cliente; quem não é revogado não entra; e
    // reconceder depois do revoke devolve o estado, então não é reabertura.
    expect(achados.join(" ")).not.toContain("fn_so_service");
    expect(achados.join(" ")).not.toContain("fn_fica_aberta");
    expect(achados.join(" ")).not.toContain("fn_reconcedida");
  });
});

describe("baseline.sql não reconcede o que ele mesmo revoga", () => {
  it("o instrumento está vivo no arquivo real: acha grants e revokes de função", () => {
    const evs = eventos(SQL);
    expect(evs.filter((e) => e.tipo === "grant").length, "nenhum grant de função — o parser mudou?").toBeGreaterThan(50);
    expect(evs.filter((e) => e.tipo === "revoke").length, "nenhum revoke de função — o parser mudou?").toBeGreaterThan(50);
  });

  it("nenhuma concessão do corpo a anon/authenticated é revogada adiante", () => {
    expect(
      reconcessoesDoCorpo(SQL),
      "O corpo devolve um EXECUTE que o apêndice tira: num clone já apertado, a atualização REABRE a função " +
        "até o revoke chegar. Tire o GRANT do corpo (o estado final não muda) ou traga o revoke para antes.\n",
    ).toEqual([]);
  });
});
