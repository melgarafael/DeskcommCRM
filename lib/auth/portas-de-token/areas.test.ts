import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_AREAS } from "@/lib/extensions/areas";
import {
  PORTAS_SEM_AREA_NA_ESCRITA,
  PORTAS_SEM_AREA_POR_DESENHO,
  PREFIXOS_DO_MAPA,
  areaDaPorta,
  estaSemAreaPorDesenho,
} from "./areas";

const B = "/api/v1/";
const METODOS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("areaDaPorta: casos concretos", () => {
  const casos: [string, string, string | null, string | null][] = [
    ["contacts", "GET", "contatos", "leitura"],
    ["contacts", "POST", "contatos", "escrita"],
    ["contacts/[id]", "PATCH", "contatos", "escrita"],
    ["contacts/[id]", "DELETE", null, null], // LGPD
    ["contacts/[id]/unblock", "POST", null, null],
    ["contacts/bulk", "DELETE", null, null],
    ["contacts/bulk", "POST", "contatos", "escrita"],
    // `pipelines/[id]/forecast` é funis: o plano põe "previsão" em funis.
    ["pipelines/[id]/forecast", "GET", "funis", "leitura"],
    // leads dentro do funil pertencem a negocios, não a funis.
    ["pipelines/[id]/leads", "GET", "negocios", "leitura"],
    ["pipelines/[id]/board", "GET", "negocios", "leitura"],
    ["pipelines/[id]/stages", "POST", "funis", "escrita"],
    ["leads/[id]/move", "POST", "negocios", "escrita"],
    ["leads/[id]/conversion/retry", "POST", null, null],
    ["conversations/[id]/notes", "POST", "conversas", "escrita"],
    ["conversations/[id]/claim", "POST", null, null],
    ["messages/[id]/hide", "POST", "conversas", "escrita"],
    ["messages", "POST", null, null],
    ["messages/[id]", "POST", null, null],
    ["messages/[id]/forward", "POST", null, null],
    ["agenda/horarios-livres", "GET", "agenda", "leitura"],
    ["agenda/aviso", "PATCH", null, null],
    ["ai/skills", "GET", "agentes_ia", "leitura"],
    ["ai/skills/[name]", "PATCH", "agentes_ia", "escrita"],
    ["ai/providers", "GET", null, null],
    ["ai/replies/[id]", "POST", null, null],
    ["ai/followups/enrollments", "POST", null, null],
    ["ai/followups/enrollments", "GET", "agentes_ia", "leitura"],
    ["ai/followups/enrollments/[id]/pause", "POST", "agentes_ia", "escrita"],
    ["products", "GET", "catalogo", "leitura"],
    ["message-templates/[id]", "DELETE", "catalogo", "escrita"],
    ["settings/routing", "PATCH", "configuracao", "escrita"],
    ["ai/budget", "PUT", null, null],
    ["ai/budget", "GET", "agentes_ia", "leitura"],
    ["contacts/merge", "POST", null, null],
    ["ai/knowledge/reindex-all", "POST", null, null],
    ["settings/api-tokens", "GET", null, null],
    ["settings/api-tokens/[id]", "DELETE", null, null],
    ["settings/assinatura", "GET", null, null],
    ["team/assignable", "GET", "configuracao", "leitura"],
    ["team/assignable", "POST", null, null],
    ["team/invite", "POST", null, null],
    ["team/[user_id]/role", "PATCH", null, null],
    ["attendants/sectors", "POST", "configuracao", "escrita"],
    ["attendants/presence", "PATCH", null, null],
    ["metrics/funil", "GET", "analise", "leitura"],
    ["reports/financeiro", "GET", "analise", "leitura"],
    ["financeiro/lancamentos", "GET", "analise", "leitura"],
    ["financeiro/lancamentos", "POST", null, null],
    ["financeiro/lancamentos/[id]", "DELETE", null, null],
    ["financeiro/catalogo/[tipo]", "GET", "catalogo", "leitura"],
    ["financeiro/catalogo/[tipo]", "POST", null, null],
    ["financeiro/comandas", "GET", null, null],
    ["honorarios/contratos", "GET", "analise", "leitura"],
    ["honorarios/contratos", "POST", null, null],
    ["automation-rules", "GET", "funis", "leitura"],
    ["automation-rules", "POST", null, null],
    ["modulos/[modulo]/[objeto]", "GET", null, null],
    ["campaigns/[id]/metrics", "GET", null, null],
    ["channel-sessions/[id]", "GET", null, null],
  ];

  for (const [caminho, metodo, area, modo] of casos) {
    it(`${metodo} ${caminho} => ${area ?? "sem area"}${modo ? `/${modo}` : ""}`, () => {
      const r = areaDaPorta(B + caminho, metodo);
      if (area === null) expect(r).toBeNull();
      else expect(r).toEqual({ area, modo });
    });
  }
});

describe("areaDaPorta: lado seguro", () => {
  it("modelo desconhecido recusa", () => {
    expect(areaDaPorta(`${B}coisa-nova`, "GET")).toBeNull();
    expect(areaDaPorta(`${B}coisa-nova/[id]`, "POST")).toBeNull();
  });
  it("prefixo por segmento, nao por texto: contact-tags nao e contacts", () => {
    expect(areaDaPorta(`${B}contact-tags`, "GET")).toBeNull();
    expect(areaDaPorta(`${B}contactsx`, "GET")).toBeNull();
  });
  it("formato fora de /api/v1 e metodo desconhecido recusam", () => {
    expect(areaDaPorta("/contacts", "GET")).toBeNull();
    expect(areaDaPorta(`${B}contacts`, "TRACE")).toBeNull();
  });
  it("irmao literal de um segmento dinamico nao herda a recusa do id", () => {
    expect(estaSemAreaPorDesenho(`${B}team/assignable`, "GET")).toBe(false);
    expect(estaSemAreaPorDesenho(`${B}team/[user_id]`, "GET")).toBe(true);
  });
  it("metodo em minusculas e normalizado", () => {
    expect(areaDaPorta(`${B}contacts`, "get")).toEqual({ area: "contatos", modo: "leitura" });
  });
});

describe("a lista sem area tem precedencia e nunca ganha area", () => {
  const NUNCA = [
    "settings/api-tokens",
    "settings/api-tokens/[id]",
    "settings/assinatura",
    "settings/art15",
    "team/invite",
    "team/invites/[id]",
    "team/[user_id]/role",
    "team/[user_id]/revoke",
    "ai/providers",
    "ai/providers/[provider]/models",
    "ai/credentials",
    "channels",
    "channels/[id]/conectar",
    "external-db/connections",
    "external-db/connections/[id]",
    "messages",
    "campaigns/[id]/iniciar",
    "modulos",
    "modulos/instalar",
    "extensions",
    "extensions/[id]/consentimento",
    "admin/qualquer",
    "cron/qualquer",
    "webhooks/qualquer",
    "lgpd/export",
    "mcp",
    "auth/login",
  ];
  for (const caminho of NUNCA) {
    it(`${caminho}: nenhum metodo ganha area`, () => {
      for (const m of METODOS) {
        // `messages` só é recusada por entrada exata; os demais por prefixo.
        expect(areaDaPorta(B + caminho, m), `${m} ${caminho}`).toBeNull();
      }
    });
  }

  it("rota que casa no mapa e na lista sem area e sem area", () => {
    // `ai` e prefixo do mapa; `ai/providers` esta na lista sem area.
    expect(PREFIXOS_DO_MAPA.some(([p]) => p === "ai")).toBe(true);
    expect(areaDaPorta(`${B}ai/providers`, "GET")).toBeNull();
    // `settings` e prefixo do mapa; `settings/api-tokens` esta na lista.
    expect(areaDaPorta(`${B}settings/api-tokens`, "GET")).toBeNull();
  });

  it("consistencia: nenhum prefixo sem area (todos os metodos) e coberto por area", () => {
    for (const p of PORTAS_SEM_AREA_POR_DESENHO) {
      const modelo = B + p;
      for (const m of METODOS) {
        expect(areaDaPorta(modelo, m), `${m} ${p}`).toBeNull();
      }
    }
  });

  it("consistencia: prefixo sem area na escrita nao ganha area de escrita", () => {
    for (const p of PORTAS_SEM_AREA_NA_ESCRITA) {
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(areaDaPorta(`${B}${p}`, m), `${m} ${p}`).toBeNull();
      }
    }
  });

  it("consistencia: nenhuma entrada do mapa e igual a uma entrada sem area", () => {
    const sem = new Set(PORTAS_SEM_AREA_POR_DESENHO);
    for (const [prefixo] of PREFIXOS_DO_MAPA) {
      expect(sem.has(prefixo), prefixo).toBe(false);
    }
  });

  it("o mapa usa so as 9 areas do vocabulario", () => {
    for (const [, area] of PREFIXOS_DO_MAPA) {
      expect(EXTENSION_AREAS).toContain(area);
    }
  });
});

// ---------------------------------------------------------------------------
// VARREDURA: toda porta tem area (em ao menos um metodo) ou esta sem area por desenho.
// ---------------------------------------------------------------------------

const AQUI = dirname(fileURLToPath(import.meta.url));
const ARQUIVOS = ["configuracao.ts", "operacao.ts", "leitura.ts"];

function modelosDe(texto: string): string[] {
  const achados: string[] = [];
  for (const linha of texto.split("\n")) {
    const a = /^\s*"(\/api\/v1\/[^"]+)",?\s*$/.exec(linha);
    if (a) achados.push(a[1]);
    const b = /^\s*caminho:\s*"(\/api\/v1\/[^"]+)"/.exec(linha);
    if (b) achados.push(b[1]);
  }
  return achados;
}

function lerModelos(pasta: string): string[] | null {
  if (!ARQUIVOS.every((f) => existsSync(join(pasta, f)))) return null;
  return ARQUIVOS.flatMap((f) => modelosDe(readFileSync(join(pasta, f), "utf8")));
}

function varrer(modelos: string[]): { semArea: string[]; comArea: string[] } {
  const semArea: string[] = [];
  const comArea: string[] = [];
  for (const modelo of modelos) {
    const r = METODOS.map((m) => areaDaPorta(modelo, m));
    if (r.every((x) => x === null)) semArea.push(modelo);
    else comArea.push(modelo);
  }
  return { semArea, comArea };
}

function classificada(modelo: string): boolean {
  // Classificada = tem area em algum metodo OU TODOS os metodos estao na lista sem area.
  const algumaArea = METODOS.some((m) => areaDaPorta(modelo, m) !== null);
  const todasSem = METODOS.every((m) => estaSemAreaPorDesenho(modelo, m));
  return algumaArea || todasSem;
}

// Varredura das portas da PROPRIA branch: so roda quando a fase R entrar aqui
// (nesta branch `configuracao.ts`, `operacao.ts` e `leitura.ts` ainda nao existem).
const modelosLocais = lerModelos(AQUI);
describe.skipIf(modelosLocais === null)("varredura: portas desta branch", () => {
  it("toda porta tem area ou esta em PORTAS_SEM_AREA_POR_DESENHO", () => {
    const orfas = (modelosLocais ?? []).filter((m) => !classificada(m));
    expect(orfas).toEqual([]);
  });
});

// Segunda versao: le o TEXTO das tres listas da pasta irma (branch da fase R) para
// conferir agora. Pula se a pasta irma nao existir (CI limpo).
const IRMA = join(AQUI, "..", "..", "..", "..", "token-nas-rotas-conv", "lib", "auth", "portas-de-token");
const modelosDaIrma = lerModelos(IRMA);
describe.skipIf(modelosDaIrma === null)("varredura: portas lidas da pasta irma (fase R)", () => {
  it("toda porta tem area ou esta em PORTAS_SEM_AREA_POR_DESENHO", () => {
    const orfas = (modelosDaIrma ?? []).filter((m) => !classificada(m));
    expect(orfas).toEqual([]);
  });

  it("imprime as portas sem area e as com area (para conferencia humana)", () => {
    const { semArea, comArea } = varrer(modelosDaIrma ?? []);
    process.stdout.write(`\nPORTAS SEM AREA (${semArea.length}):\n${semArea.join("\n")}\n`);
    process.stdout.write(`\nPORTAS COM AREA (${comArea.length}):\n`);
    for (const m of comArea) {
      const leit = areaDaPorta(m, "GET");
      const escr = areaDaPorta(m, "POST");
      process.stdout.write(`${m}  leitura=${leit?.area ?? "-"} escrita=${escr?.area ?? "-"}\n`);
    }
    expect(semArea.length + comArea.length).toBe((modelosDaIrma ?? []).length);
  });
});
