// Toda lição do curso obedece ao contrato e aponta para uma tela que existe no menu do produto.
// Sem isto, uma lição quebrada só aparece quando alguém roda o capturador na VPS.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";

import { Modulo } from "./licao";

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

  it("recusa alvo com duas estratégias (seria ambíguo qual o capturador usa)", () => {
    const passo = { id: "p", titulo: "t", texto: "x", rota: "/app/inbox", clicar: { testid: "a", texto: "b" } };
    const r = Modulo.safeParse({
      id: "m", titulo: "M", tela: "/app/inbox", resumo: "r",
      licoes: [{ id: "l", titulo: "L", objetivo: "o", papel: "admin", passos: [passo] }],
    });
    expect(r.success).toBe(false);
  });
});
