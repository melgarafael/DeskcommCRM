import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { LEITORES_DA_DESCRICAO } from "@/lib/messaging/media/leitura-adiada";

/**
 * TODO LEITOR DA DESCRIÇÃO DE MÍDIA ESTÁ MAPEADO NO PREDICADO DA TRAVA.
 *
 * Com `MEDIA_VISION_WITHOUT_READER=defer` (o padrão), a foto de uma empresa sem
 * leitor (`haLeitorDaDescricao`) fica sem descrição até aparecer quem a leia. O
 * predicado só é neutro enquanto cobre TODO lugar que lê a descrição. Um leitor
 * novo de `media_derived_text` que não seja agente com "ver as fotos" ligado
 * (que cobre o caso, o fluxo e a inscrição dele), inscrição sem agente, token,
 * anúncio, modo external ou venda pelo canal receberia `[image]` em silêncio. Esta cerca reprova o arquivo novo até alguém dizer, em
 * `LEITORES_DA_DESCRICAO`, qual componente o cobre — ou somá-lo ao predicado.
 *
 * Leitor em SQL (função, view, coluna gerada) também conta: o `baseline.sql` é
 * varrido à parte, e hoje toda menção à coluna lá é criá-la ou zerá-la. O que a
 * cerca NÃO vê é quem lê a linha inteira sem nomear a coluna (`select *`,
 * `row_to_json(m)`).
 */
const RAIZ = join(__dirname, "..", "..");
const RAIZES = ["lib", "app", "workers", "components", "hooks"];

function arquivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

// Formas que mencionam a coluna sem expor o texto a ninguém.
const FORMAS_SQL_QUE_NAO_LEEM = [
  /add column if not exists media_derived_text text/,
  /media_derived_text\s*=\s*null/,
  /media_derived_text is not null/, // o filtro da cura que a zera
];

function leitoresEmSql(sql: string): string[] {
  return sql
    .split("\n")
    .map((linha, i) => ({ codigo: linha.replace(/--.*$/, ""), n: i + 1 }))
    .filter(({ codigo }) => codigo.includes("media_derived_text"))
    .filter(({ codigo }) => !FORMAS_SQL_QUE_NAO_LEEM.some((f) => f.test(codigo)))
    .map(({ codigo, n }) => `baseline.sql:${n}: ${codigo.trim()}`);
}

describe("leitores da descrição de mídia × predicado da trava", () => {
  const achados = RAIZES.flatMap((r) => arquivos(join(RAIZ, r)))
    .filter((p) => !p.endsWith("database.types.ts"))
    .filter((p) => readFileSync(p, "utf8").includes("media_derived_text"))
    .map((p) => relative(RAIZ, p).split("\\").join("/"))
    .sort();

  it("a varredura enxerga leitores (controle positivo)", () => {
    expect(achados).toContain("lib/agent-engine/edge/crm/get-lead-context.ts");
  });

  it("o mapa é exatamente o conjunto de arquivos que tocam a coluna", () => {
    const mapeados = Object.keys(LEITORES_DA_DESCRICAO).sort();
    expect(
      achados,
      "Arquivo novo lê media_derived_text sem entrada em LEITORES_DA_DESCRICAO " +
        "(lib/messaging/media/leitura-adiada.ts), ou a entrada ficou para um arquivo que não lê mais. " +
        "Diga qual componente de haLeitorDaDescricao cobre o leitor novo; se nenhum cobre, some-o ao predicado.",
    ).toEqual(mapeados);
  });

  it("baseline.sql: nenhum leitor em SQL fora do mapa", () => {
    const sql = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
    expect(sql, "a varredura do SQL não enxerga a coluna (controle positivo)").toContain(
      "add column if not exists media_derived_text text",
    );
    expect(
      leitoresEmSql(sql),
      "Função, view ou coluna gerada do baseline lê media_derived_text. Diga em LEITORES_DA_DESCRICAO " +
        "qual componente de haLeitorDaDescricao a cobre (ou some-a ao predicado) e acrescente a forma aqui.",
    ).toEqual([]);
  });

  it("controle: um leitor em SQL é acusado", () => {
    expect(leitoresEmSql("create view v as select m.media_derived_text from public.messages m;")).toHaveLength(1);
    expect(leitoresEmSql("  -- comentário que cita media_derived_text\nupdate m set media_derived_text = null;")).toEqual([]);
  });
});
