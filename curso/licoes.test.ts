// Toda lição do curso obedece ao contrato e aponta para uma tela que existe no menu do produto.
// Sem isto, uma lição quebrada só aparece quando alguém roda o capturador na VPS.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";

import { Modulo, chaveDoPasso } from "./licao";
import { caixaNaFoto } from "./geometria";
import { menuDoAdmin } from "./menu-do-admin";
import { exigirBancoLocal, validarOrganizacoesExtras } from "./seguranca";

const PASTA = path.join(__dirname, "licoes");
const arquivos = readdirSync(PASTA).filter((f) => f.endsWith(".json"));

describe("lições do curso ilustrado", () => {
  it("não mede um alvo fora da foto e recorta a interseção nas quatro bordas", () => {
    expect(() => caixaNaFoto({ x: 288, y: 1743, width: 71, height: 40 }, 1440, 900)).toThrow("fora da foto");
    expect(() => caixaNaFoto({ x: -100, y: 0, width: 50, height: 10 }, 1440, 900)).toThrow("fora da foto");
    expect(caixaNaFoto({ x: -10, y: -20, width: 50, height: 60 }, 1440, 900)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(caixaNaFoto({ x: 1400, y: 880, width: 60, height: 40 }, 1440, 900)).toEqual({ x: 1400, y: 880, w: 40, h: 20 });
  });

  it("nunca inclui a organização principal nem uma empresa desconhecida na limpeza", () => {
    const exemplo = "a7d00000-0000-4000-8000-000000000001";
    expect(() => validarOrganizacoesExtras("principal", [{ id: exemplo }])).not.toThrow();
    expect(() => validarOrganizacoesExtras(exemplo, [{ id: exemplo }])).toThrow("principal");
    expect(() => validarOrganizacoesExtras("principal", [{ id: "empresa-real" }])).toThrow("fora das sementes");
  });

  it("o Postgres direto também recusa servidores remotos sem expor a senha", () => {
    expect(exigirBancoLocal("postgresql://teste:segredo@127.0.0.1:54322/postgres")).toContain("127.0.0.1");
    expect(() => exigirBancoLocal("postgresql://teste:segredo@db.externo.test/postgres")).toThrow("precisa ser local");
    expect(() => exigirBancoLocal("senha secreta inválida")).toThrow("SUPABASE_DB_URL inválida; conexão recusada");
    expect(() => exigirBancoLocal(undefined)).toThrow("SUPABASE_DB_URL");
  });

  it("recusa a URL local que o parser real do pg redirecionaria para um host remoto", () => {
    const desvio = "postgresql://local@127.0.0.1:5432/course?host=remote.example&port=6543";
    // Construir Client resolve os parâmetros sem chamar connect(), DNS ou rede.
    expect(new URL(desvio).hostname).toBe("127.0.0.1");
    const semGuarda = new pg.Client({ connectionString: desvio });
    expect(semGuarda.host).toBe("remote.example");
    expect(semGuarda.port).toBe(6543);
    expect(() => exigirBancoLocal(desvio)).toThrow("parâmetros de conexão");
    const local = new pg.Client({ connectionString: exigirBancoLocal("postgresql://local@127.0.0.1:5432/course?sslmode=disable") });
    expect(local.host).toBe("127.0.0.1");
    expect(local.port).toBe(5432);
  });

  it.each([
    "host=remote.example", "%68ost=remote.example", "HOST=remote.example", "hostaddr=203.0.113.1",
    "port=6543", "connectionString=postgresql%3A%2F%2Fremote.example%2Fcourse", "service=externo", "servicefile=externo",
  ])("recusa parâmetro de destino, inclusive codificado ou variante: %s", (parametro) => {
    expect(() => exigirBancoLocal(`postgresql://local@localhost:5432/course?${parametro}`)).toThrow("parâmetros de conexão");
  });
  it("existe ao menos um módulo", () => {
    expect(arquivos.length).toBeGreaterThan(0);
  });

  it.each(arquivos)("%s segue o contrato e ensina uma tela do menu", (arquivo) => {
    const modulo = Modulo.parse(JSON.parse(readFileSync(path.join(PASTA, arquivo), "utf8")));
    expect([...NAV_CATALOG.map((d) => d.href), ...menuDoAdmin().map((i) => i.href)]).toContain(modulo.tela);
    expect(`${modulo.id}.json`).toBe(arquivo);
  });

  it("nenhuma foto de um módulo tem o nome da foto de outro (ids de lição se repetem entre módulos)", () => {
    const chaves = arquivos.flatMap((arquivo) => {
      const m = Modulo.parse(JSON.parse(readFileSync(path.join(PASTA, arquivo), "utf8")));
      return m.licoes.flatMap((l) => l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id)));
    });
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it("o menu do Admin é lido do componente (lista vazia = formato mudou)", () => {
    const itens = menuDoAdmin();
    expect(itens.map((i) => i.href)).toContain("/admin/dashboard");
    expect(itens.length).toBeGreaterThan(10);
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
