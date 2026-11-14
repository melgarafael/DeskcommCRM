/**
 * #4495 — as primeiras 30 campanhas esperando o próprio ritmo escondiam as
 * seguintes.
 *
 * A rodada lia `order(started_at asc).limit(30)` e só DEPOIS decidia
 * `ocupaONumero`. Trinta campanhas paradas no teto diário delas não ocupam
 * número nenhum, mas consumiam a janela inteira: a 31ª não era lida em tique
 * nenhum, e o operador não conseguia avaliar (nem despachar) o resto da fila.
 *
 * O conserto pagina por `(started_at, id)` e para em três lugares: no teto de
 * números atendidos (o anti-ban de sempre), na página vazia (fim provado) e no
 * orçamento de páginas por rodada — que é o custo máximo por tique.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({ knobs: { timezone: "America/Sao_Paulo" }, numberActivatedAt: null }),
  loadPacingState: async () => {
    throw new Error("a rodada deste teste não chega ao rodízio");
  },
  recordSend: async () => undefined,
}));

import {
  CAMPANHAS_POR_PAGINA,
  NUMEROS_POR_RODADA,
  PAGINAS_POR_RODADA,
  rodarUmaRodadaDeCampanha,
} from "@/lib/campanhas/rodada";

type Linha = Record<string, unknown>;

const AGORA = new Date("2026-10-20T14:00:00.000Z"); // 11h em São Paulo
const HOJE_CEDO = "2026-10-20T12:37:00.000Z"; // 9h37 em São Paulo

/**
 * PostgREST em memória com o que a varredura usa: `eq`, `in`, `gte`, `or`
 * (com `and(...)` aninhado, que é como o cursor composto viaja), `order`,
 * `limit`, `range`, `update` e conta por `count`.
 */
function fakeAdmin(tabelas: Record<string, Linha[]>) {
  const consultas = { campaigns: 0 };

  const condicao = (texto: string) => {
    const primeiro = texto.indexOf(".");
    const segundo = texto.indexOf(".", primeiro + 1);
    const coluna = texto.slice(0, primeiro);
    const operador = texto.slice(primeiro + 1, segundo);
    const valor = texto.slice(segundo + 1);
    switch (operador) {
      case "eq":
        return (l: Linha) => String(l[coluna]) === valor;
      case "gt":
        return (l: Linha) => l[coluna] != null && String(l[coluna]) > valor;
      case "gte":
        return (l: Linha) => l[coluna] != null && String(l[coluna]) >= valor;
      case "lt":
        return (l: Linha) => l[coluna] != null && String(l[coluna]) < valor;
      case "lte":
        return (l: Linha) => l[coluna] != null && String(l[coluna]) <= valor;
      case "is":
        return (l: Linha) => (valor === "null" ? l[coluna] == null : String(l[coluna]) === valor);
      case "in": {
        const valores = valor.replace(/^\(|\)$/g, "").split(",");
        return (l: Linha) => valores.includes(String(l[coluna]));
      }
      default:
        throw new Error(`fake: operador «${operador}» não implementado em «${texto}»`);
    }
  };

  /** `a,b` no nível de cima; `and(x,y)` é um grupo fechado. */
  const disjuncao = (expressao: string): Array<(l: Linha) => boolean> => {
    const partes: string[] = [];
    let profundidade = 0;
    let atual = "";
    for (const caractere of expressao) {
      if (caractere === "(") profundidade += 1;
      if (caractere === ")") profundidade -= 1;
      if (caractere === "," && profundidade === 0) {
        partes.push(atual);
        atual = "";
        continue;
      }
      atual += caractere;
    }
    if (atual !== "") partes.push(atual);
    return partes.map((parte) => {
      const limpa = parte.trim();
      if (limpa.startsWith("and(") && limpa.endsWith(")")) {
        const internas = disjuncao(limpa.slice(4, -1));
        return (l: Linha) => internas.every((f) => f(l));
      }
      return condicao(limpa);
    });
  };

  const de = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    const ordem: Array<{ coluna: string; asc: boolean }> = [];
    let limite: number | null = null;
    let inicio = 0;
    let patch: Linha | null = null;
    /** Só a VARREDURA (`status = running`) conta: a promoção de agendadas também lê `campaigns`. */
    let varredura = false;
    const resolver = () => {
      if (tabela === "campaigns" && varredura) consultas.campaigns += 1;
      let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      if (ordem.length > 0) {
        linhas = [...linhas].sort((a, b) => {
          for (const { coluna, asc } of ordem) {
            const va = String(a[coluna] ?? "");
            const vb = String(b[coluna] ?? "");
            if (va === vb) continue;
            return (asc ? 1 : -1) * (va < vb ? -1 : 1);
          }
          return 0;
        });
      }
      const fim = limite === null ? undefined : inicio + limite;
      linhas = linhas.slice(inicio, fim);
      if (patch) for (const l of linhas) Object.assign(l, patch);
      return { data: linhas, error: null, count: linhas.length };
    };
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get(_alvo, metodo) {
          switch (metodo) {
            case "then":
              return (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok);
            case "maybeSingle":
              return async () => ({ data: resolver().data[0] ?? null, error: null });
            case "update":
              return (p: Linha) => ((patch = p), b);
            case "eq":
              return (coluna: string, valor: unknown) => {
                if (coluna === "organizations.status") {
                  filtros.push((l) => (l.organizations as Linha).status === valor);
                } else {
                  if (coluna === "status" && valor === "running") varredura = true;
                  filtros.push((l) => l[coluna] === valor);
                }
                return b;
              };
            case "in":
              return (coluna: string, valores: unknown[]) => (filtros.push((l) => valores.includes(l[coluna])), b);
            case "or":
              return (expressao: string) => {
                const alternativas = disjuncao(expressao);
                filtros.push((l) => alternativas.some((f) => f(l)));
                return b;
              };
            case "order":
              return (coluna: string, opcoes?: { ascending?: boolean }) => {
                ordem.push({ coluna, asc: opcoes?.ascending !== false });
                return b;
              };
            case "limit":
              return (n: number) => ((limite = n), b);
            case "range":
              return (de: number, ate: number) => ((inicio = de), (limite = ate - de + 1), b);
            default:
              return () => b;
          }
        },
      },
    );
    return b;
  };
  return { admin: { from: de } as never, consultas };
}

const campanha = (id: string, startedAt: string, tetoDiario: number | null, canal = "canal-unico"): Linha => ({
  id,
  organization_id: "org-1",
  channel_session_id: canal,
  name: id,
  message_body: "oi",
  content_version: 1,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: tetoDiario,
  teto_horario: null,
  status: "running",
  started_at: startedAt,
  organizations: { status: "active" },
});

const contato = (id: string, bloqueado = false): Linha => ({
  id,
  name: "Ana",
  display_name: null,
  phone_number: `+5511900${id.replace(/\D/g, "").padStart(6, "0").slice(-6)}`,
  is_blocked: bloqueado,
  is_personal: false,
  is_anonymized: false,
  consent: null,
});

/**
 * A instalação do relato: 30 campanhas antigas, todas no MESMO número e todas
 * com o teto diário de 1 já gasto (1 enviado hoje + 1 pendente), e a 31ª com um
 * contato bloqueado — que só é descoberto se a campanha for LIDA.
 */
function cenarioDaIssue() {
  const esperando = Array.from({ length: 30 }, (_, i) =>
    campanha(`espera${String(i).padStart(2, "0")}`, new Date(Date.parse(HOJE_CEDO) + i * 1000).toISOString(), 1),
  );
  const seguinte = campanha("seguinte", "2026-10-20T13:00:00.000Z", null);
  const destinatarios: Linha[] = esperando.flatMap((c, i) => [
    {
      id: `${c.id}-enviado`,
      campaign_id: c.id,
      status: "sent",
      sent_at: HOJE_CEDO,
      contact_id: `ct-${i}-enviado`,
      contacts: contato(`ct-${i}-enviado`),
    },
    {
      id: `${c.id}-pendente`,
      campaign_id: c.id,
      status: "pending",
      sent_at: null,
      contact_id: `ct-${i}-pendente`,
      contacts: contato(`ct-${i}-pendente`),
    },
  ]);
  const pendenteSeguinte: Linha = {
    id: "r-seguinte",
    campaign_id: seguinte.id,
    status: "pending",
    sent_at: null,
    contact_id: "ct-seguinte",
    contacts: contato("ct-seguinte", true),
  };
  return {
    tabelas: { campaigns: [...esperando, seguinte], campaign_recipients: [...destinatarios, pendenteSeguinte] },
    pendenteSeguinte,
  };
}

describe("varredura da rodada além da primeira janela (#4495)", () => {
  it("⭐ as 30 primeiras paradas no próprio ritmo não impedem a avaliação da 31ª", async () => {
    const { tabelas, pendenteSeguinte } = cenarioDaIssue();
    const { admin } = fakeAdmin(tabelas);

    const r = await rodarUmaRodadaDeCampanha(admin, AGORA);

    // As 30 esperam o teto diário DELAS (e continuam sem ocupar número)…
    expect(r.detalhe.match(/ritmo:teto_diario/g)).toHaveLength(30);
    expect(r.enviadas).toBe(0);
    // …e a 31ª é avaliada: o contato bloqueado é revalidado e vira `opted_out`.
    expect(r.detalhe).toContain("seguinte:pulado:opt_out");
    expect(pendenteSeguinte.status).toBe("opted_out");
    expect(r.pulados).toBe(1);
  });

  it("⭐ a varredura para no teto de números: primeira página cheia, nenhuma leitura a mais", async () => {
    const quantas = CAMPANHAS_POR_PAGINA + 3;
    const campanhas = Array.from({ length: quantas }, (_, i) =>
      campanha(`c${String(i).padStart(2, "0")}`, new Date(Date.parse(HOJE_CEDO) + i * 1000).toISOString(), null, `canal-${i}`),
    );
    const destinatarios: Linha[] = campanhas.map((c, i) => ({
      id: `r-${i}`,
      campaign_id: c.id,
      status: "pending",
      sent_at: null,
      contact_id: `ct-${i}`,
      contacts: contato(`ct-${i}`, true),
    }));
    const { admin, consultas } = fakeAdmin({ campaigns: campanhas, campaign_recipients: destinatarios });

    const r = await rodarUmaRodadaDeCampanha(admin, AGORA);

    // Um número por campanha e contato bloqueado: cada uma OCUPA o número dela.
    expect(r.pulados).toBe(NUMEROS_POR_RODADA);
    expect(r.detalhe.match(/pulado:opt_out/g)).toHaveLength(NUMEROS_POR_RODADA);
    // O teto é de números atendidos: paginar não pode furar o anti-ban.
    expect(consultas.campaigns).toBe(1);
  });

  it("⭐ o orçamento de páginas é o custo máximo por tique, e a rodada diz que varreu até o limite", async () => {
    const quantas = CAMPANHAS_POR_PAGINA * PAGINAS_POR_RODADA + 5;
    const campanhas = Array.from({ length: quantas }, (_, i) =>
      campanha(`e${String(i).padStart(3, "0")}`, new Date(Date.parse(HOJE_CEDO) + i * 1000).toISOString(), 1),
    );
    const destinatarios: Linha[] = campanhas.flatMap((c, i) => [
      { id: `${c.id}-enviado`, campaign_id: c.id, status: "sent", sent_at: HOJE_CEDO, contact_id: `ct-${i}-e`, contacts: contato(`ct-${i}-e`) },
      { id: `${c.id}-pendente`, campaign_id: c.id, status: "pending", sent_at: null, contact_id: `ct-${i}-p`, contacts: contato(`ct-${i}-p`) },
    ]);
    const { admin, consultas } = fakeAdmin({ campaigns: campanhas, campaign_recipients: destinatarios });

    const r = await rodarUmaRodadaDeCampanha(admin, AGORA);

    expect(consultas.campaigns).toBe(PAGINAS_POR_RODADA);
    expect(r.detalhe.match(/ritmo:teto_diario/g)).toHaveLength(CAMPANHAS_POR_PAGINA * PAGINAS_POR_RODADA);
    expect(r.detalhe).toContain("varredura:orcamento");
  });
});
