import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_AREAS } from "@/lib/extensions/areas";
import {
  PORTAS_SEM_AREA_NA_ESCRITA,
  PORTAS_SEM_AREA_POR_DESENHO,
  PREFIXOS_DO_MAPA,
  PREFIXOS_DO_MAPA_DE_ESCRITA,
  areaDaPorta,
  estaSemAreaPorDesenho,
  leituraExigeAreaContatos,
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
    ["financeiro/lancamentos", "POST", "financeiro", "escrita"],
    ["financeiro/lancamentos/[id]", "PATCH", "financeiro", "escrita"],
    ["financeiro/lancamentos/[id]", "DELETE", "financeiro", "escrita"],
    ["financeiro/catalogo/[tipo]", "GET", "catalogo", "leitura"],
    ["financeiro/catalogo/[tipo]", "POST", "financeiro", "escrita"],
    ["financeiro/catalogo/[tipo]", "PATCH", "financeiro", "escrita"],
    ["financeiro/catalogo/[tipo]", "DELETE", "financeiro", "escrita"],
    ["honorarios/contratos", "GET", "analise", "leitura"],
    ["honorarios/contratos", "POST", "financeiro", "escrita"],
    ["honorarios/contratos/[id]/parcelas", "GET", "analise", "leitura"],
    ["honorarios/contratos/[id]/parcelas", "POST", "financeiro", "escrita"],
    ["automation-rules", "GET", "funis", "leitura"],
    ["automation-rules", "POST", null, null],
    ["modulos/[modulo]/[objeto]", "GET", null, null],
    ["campaigns/[id]/metrics", "GET", null, null],
    ["channel-sessions/[id]", "GET", null, null],

    // --- areas novas (migration 9316): tarefas, financeiro e as rotas que estavam fora do mapa.
    ["tasks", "GET", "tarefas", "leitura"],
    ["tasks", "POST", "tarefas", "escrita"],
    ["tasks/[id]", "PATCH", "tarefas", "escrita"],
    ["tasks/[id]", "DELETE", "tarefas", "escrita"],
    ["demandas/[id]", "PATCH", "tarefas", "escrita"],
    ["contact-tags", "GET", "contatos", "leitura"],
    ["conversation-tags", "GET", "conversas", "leitura"],
    ["financeiro/comandas/pendentes", "GET", "financeiro", "leitura"],
    ["financeiro/comandas", "GET", "financeiro", "leitura"],
    ["financeiro/comandas", "POST", "financeiro", "escrita"],
    ["financeiro/comandas/[id]", "GET", "financeiro", "leitura"],
    ["financeiro/comandas/[id]", "PATCH", "financeiro", "escrita"],
    ["financeiro/comandas/[id]/itens", "POST", "financeiro", "escrita"],
    ["financeiro/comandas/[id]/itens/[itemId]", "DELETE", "financeiro", "escrita"],
    ["financeiro/fidelidade", "GET", "financeiro", "leitura"],
    ["financeiro/fidelidade", "POST", "financeiro", "escrita"],
    // dinheiro que nao se desfaz e hoje nem aceita token: sem area em qualquer metodo
    ["financeiro/comandas/[id]/finalizar", "POST", null, null],
    ["financeiro/comandas/[id]/estornar", "POST", null, null],
    ["financeiro/comandas/faturar-lote", "POST", null, null],
    ["honorarios/parcelas/[id]/pagar", "POST", null, null],
    ["people", "GET", "contatos", "leitura"],
    ["people", "POST", "contatos", "escrita"],
    ["people/[id]", "GET", "contatos", "leitura"],
    ["people/[id]", "PATCH", "contatos", "escrita"],
    ["company-people", "POST", "contatos", "escrita"],
    ["company-people/[id]", "PATCH", "contatos", "escrita"],
    ["campaign-templates", "GET", "configuracao", "leitura"],
    ["campaign-templates", "POST", "configuracao", "escrita"],
    ["campaign-templates/[id]", "PATCH", "configuracao", "escrita"],
    ["campaign-templates/[id]", "DELETE", "configuracao", "escrita"],
    ["message-template-groups", "GET", "configuracao", "leitura"],
    ["message-template-groups", "POST", "configuracao", "escrita"],
    ["message-template-groups/[id]", "PATCH", "configuracao", "escrita"],
    ["message-template-groups/[id]/ordem", "PUT", "configuracao", "escrita"],
    ["channel-schedules", "GET", "configuracao", "leitura"],
    // a janela pausa canais do WhatsApp; desfazer exige a pausa manual em Conexões: só a leitura tem área
    ["channel-schedules", "POST", null, null],
    ["channel-schedules/[id]", "PATCH", null, null],
    ["channel-schedules/[id]", "DELETE", null, null],
    ["ads/meta/accounts", "GET", "analise", "leitura"],
    ["ads/meta/campaigns", "GET", "analise", "leitura"],
    ["ads/meta/accounts", "POST", null, null], // so leitura
    ["ads/meta/campaigns", "DELETE", null, null],
    ["calls", "GET", "conversas", "leitura"],
    ["calls", "POST", null, null], // ligar para o cliente e falar com o cliente
    ["messages/[id]/media", "GET", "conversas", "leitura"],
    ["messages/[id]/media", "POST", null, null], // so leitura
    ["phone-numbers", "GET", null, null], // a leitura só aceita sessão (não é porta de módulo)
    ["phone-numbers", "POST", null, null], // mexe na conexao do canal
    ["phone-numbers/[id]", "PATCH", null, null],
    // sem area por decisao, com motivo escrito em `areas.ts`
    ["campaign-suppressions", "GET", null, null],
    ["campaign-suppressions", "POST", null, null],
    ["campaign-suppressions/[id]", "DELETE", null, null],
    ["audit", "GET", null, null],
    ["audit/export", "GET", null, null],
    ["imports", "GET", null, null],
    ["imports", "POST", null, null],
    ["imports/[id]", "GET", null, null],
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
    // `contact-tags` e `contacts` sao segmentos diferentes: a etiqueta do contato cai em `contatos` pela
    // propria entrada do mapa, e um nome parecido nao herda nada.
    expect(areaDaPorta(`${B}contact-tags`, "GET")).toEqual({ area: "contatos", modo: "leitura" });
    expect(areaDaPorta(`${B}contact-tagsx`, "GET")).toBeNull();
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
    "financeiro/comandas/[id]/finalizar",
    "financeiro/comandas/[id]/estornar",
    "financeiro/comandas/faturar-lote",
    "honorarios/parcelas/[id]/pagar",
    "campaign-suppressions",
    "campaign-suppressions/[id]",
    "audit",
    "audit/export",
    "imports",
    "imports/[id]",
    "phone-numbers",
    "phone-numbers/[id]",
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

  it("o mapa usa so as 11 areas do vocabulario", () => {
    expect(EXTENSION_AREAS).toHaveLength(11);
    for (const [, area] of [...PREFIXOS_DO_MAPA, ...PREFIXOS_DO_MAPA_DE_ESCRITA]) {
      expect(EXTENSION_AREAS).toContain(area);
    }
  });

  it("o mapa de escrita so vale na escrita: a leitura da mesma porta segue na area do mapa geral", () => {
    for (const [prefixo] of PREFIXOS_DO_MAPA_DE_ESCRITA) {
      const leitura = areaDaPorta(B + prefixo, "GET");
      const escrita = areaDaPorta(B + prefixo, "POST");
      expect(escrita?.area, prefixo).toBe("financeiro");
      expect(leitura?.area, prefixo).not.toBe("financeiro");
    }
  });

  it("cada uma das duas areas novas tem ao menos uma porta no mapa", () => {
    const usadas = new Set<string>(
      [...PREFIXOS_DO_MAPA, ...PREFIXOS_DO_MAPA_DE_ESCRITA].map(([, area]) => area),
    );
    for (const area of ["tarefas", "financeiro"]) {
      expect(usadas.has(area), area).toBe(true);
    }
  });

  it("leitura que traz o contato exige tambem `contatos`: fidelidade, chamadas e arquivo de mensagem", () => {
    expect(leituraExigeAreaContatos(`${B}financeiro/fidelidade`, "GET")).toBe(true);
    expect(leituraExigeAreaContatos(`${B}calls`, "GET")).toBe(true);
    expect(leituraExigeAreaContatos(`${B}messages/[id]/media`, "GET")).toBe(true);
    // a fila de comandas pendentes traz o titulo do agendamento, que pode ter o nome do cliente
    expect(leituraExigeAreaContatos(`${B}financeiro/comandas/pendentes`, "GET")).toBe(true);
    // a escrita nao e leitura; e uma leitura de financeiro sem contato embutido nao exige
    expect(leituraExigeAreaContatos(`${B}financeiro/fidelidade`, "POST")).toBe(false);
    expect(leituraExigeAreaContatos(`${B}financeiro/comandas`, "GET")).toBe(false);
    expect(leituraExigeAreaContatos(`${B}financeiro/comandas/pendentes`, "POST")).toBe(false);
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
    if (a) achados.push(a[1] as string);
    const b = /^\s*caminho:\s*"(\/api\/v1\/[^"]+)"/.exec(linha);
    if (b) achados.push(b[1] as string);
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
