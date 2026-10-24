// Toda lição do curso obedece ao contrato e aponta para uma tela que existe no menu do produto.
// Sem isto, uma lição quebrada só aparece quando alguém roda o capturador na VPS.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";

import { Modulo, chaveDoPasso } from "./licao";

const PASTA = path.join(__dirname, "licoes");
const arquivos = readdirSync(PASTA).filter((f) => f.endsWith(".json"));

describe("lições do curso ilustrado", () => {
  it("existe ao menos um módulo", () => {
    expect(arquivos.length).toBeGreaterThan(0);
  });

  it.each(arquivos)("%s segue o contrato e ensina uma tela do menu", (arquivo) => {
    const modulo = Modulo.parse(JSON.parse(readFileSync(path.join(PASTA, arquivo), "utf8")));
    expect(NAV_CATALOG.map((d) => d.href)).toContain(modulo.tela);
    expect(`${modulo.id}.json`).toBe(arquivo);
  });

  it("nenhuma foto de um módulo tem o nome da foto de outro (ids de lição se repetem entre módulos)", () => {
    const chaves = arquivos.flatMap((arquivo) => {
      const m = Modulo.parse(JSON.parse(readFileSync(path.join(PASTA, arquivo), "utf8")));
      return m.licoes.flatMap((l) => l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id)));
    });
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it("recusa alvo com duas estratégias (seria ambíguo qual o capturador usa)", () => {
    const passo = { id: "p", titulo: "t", texto: "x", rota: "/app/inbox", clicar: { testid: "a", texto: "b" } };
    const r = Modulo.safeParse({
      id: "m", titulo: "M", tela: "/app/inbox", resumo: "r",
      licoes: [{ id: "l", titulo: "L", objetivo: "o", papel: "admin", passos: [passo] }],
    });
    expect(r.success).toBe(false);
  });
});
