/**
 * A LISTAGEM DA AGENDA PELO PERÍODO — o que a porta de integração pediu na #1744.
 *
 * ## Por que este arquivo existe
 *
 * `crm_list_appointments` foi feita para a IA ACHAR um compromisso, não para um
 * calendário externo ler a semana. Faltavam quatro coisas, e nenhuma delas
 * tinha teste: o período `de`/`ate` na porta, o teto da janela, o `dia` que
 * cortava em UTC (em São Paulo o compromisso das 22h sumia da lista do próprio
 * dia) e a paginação — eram 50 itens e o fim.
 *
 * Aqui se mede a REGRA (`lib/agenda/consulta.ts`), não a tool: rota REST e
 * ferramenta MCP chamam esta mesma função, então é onde a régua é uma só. A
 * camada da tool tem teste próprio (`mcp-lista-agendamentos-periodo.test.ts`).
 *
 * ## O dublê do banco
 *
 * Chain-recorder: cada `from()` registra as chamadas daquela consulta, então o
 * teste afirma o FILTRO QUE FOI MONTADO (o instante exato do `gte`, a string do
 * cursor) em vez de apenas "não explodiu". É a única forma de prover que o dia
 * mudou de fuso — o comportamento está no valor passado ao banco, não no
 * retorno.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { codificarCursorDaLista, listaAgendamentos } from "@/lib/agenda/consulta";

const ORG = "22222222-2222-4222-8222-222222222222";

interface Chamada {
  metodo: string;
  args: unknown[];
}
interface Consulta {
  tabela: string;
  chamadas: Chamada[];
}

interface Opcoes {
  /** Linhas que `calendar_appointments` devolve. */
  linhas?: Array<Record<string, unknown>>;
  /** `organizations.timezone`. `null`/ausente = a organização não declarou. */
  fuso?: string | null;
  /** `crm_lead_links` — o vínculo compromisso→negócio. */
  vinculos?: Array<{ lead_id: string; target_id: string }>;
}

function db(opts: Opcoes = {}) {
  const consultas: Consulta[] = [];

  const from = (tabela: string) => {
    const c: Consulta = { tabela, chamadas: [] };
    consultas.push(c);
    const b: Record<string, unknown> = {};
    const encadeia =
      (metodo: string) =>
      (...args: unknown[]) => {
        c.chamadas.push({ metodo, args });
        return b;
      };
    for (const m of ["select", "eq", "in", "order", "limit", "gte", "lt", "lte", "or"]) {
      b[m] = encadeia(m);
    }
    b.maybeSingle = async () => {
      c.chamadas.push({ metodo: "maybeSingle", args: [] });
      if (tabela === "organizations") {
        const tz = opts.fuso;
        return { data: tz ? { timezone: tz } : null, error: null };
      }
      return { data: null, error: null };
    };
    // Mesmo truque dos dublês do repo: o objeto é thenable, e `await` nele
    // resolve conforme a tabela. A execução é REGISTRADA — é assim que um
    // teste distingue "montou a consulta" de "leu o banco".
    b.then = (ok: (v: unknown) => unknown) => {
      c.chamadas.push({ metodo: "execucao", args: [] });
      if (tabela === "crm_lead_links") {
        return Promise.resolve(ok({ data: opts.vinculos ?? [], error: null }));
      }
      if (tabela === "calendar_appointments") {
        return Promise.resolve(ok({ data: opts.linhas ?? [], error: null }));
      }
      return Promise.resolve(ok({ data: [], error: null }));
    };
    return b;
  };

  return { consultas, supabase: { from } as unknown as SupabaseClient };
}

const chamadasDe = (consultas: Consulta[], tabela: string): Chamada[] =>
  consultas.filter((c) => c.tabela === tabela).flatMap((c) => c.chamadas);

/** O valor do N-ésimo `gte("starts_at", …)` da consulta de compromissos. */
const limites = (consultas: Consulta[], metodo: "gte" | "lt") =>
  chamadasDe(consultas, "calendar_appointments")
    .filter((c) => c.metodo === metodo)
    .map((c) => c.args[1]);

describe("a janela de `de`/`ate` (issue #1744)", () => {
  it("⭐ acima do máximo recusa, com o número na mensagem — e NÃO consulta o banco", async () => {
    // É a única coisa que separa "varre a semana" de "varre o ano por erro de
    // digitação". 01/01 a 01/04 são 90 dias, o teto é 62.
    const { supabase, consultas } = db();

    const r = await listaAgendamentos(supabase, ORG, {
      de: "2026-01-01T00:00:00Z",
      ate: "2026-04-01T00:00:00Z",
      limite: 20,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("janela_invalida");
    // A recusa ENSINA o teto para o operador…
    expect(r.motivoParaOperador).toContain("62");
    // …e diz o que FAZER na face do cliente (DECISÃO 20), sem nomear campo.
    expect(r.motivoParaCliente).toMatch(/Divida/i);
    // A face do cliente não nomeia campo nem apelido técnico (DECISÃO 20).
    expect(r.motivoParaCliente).not.toContain("`");
    // Recusar ANTES de qualquer leitura é o que torna o teto barato.
    expect(consultas).toEqual([]);
  });

  it("a janela de 62 dias é ACEITA — o teto é do teto, não de um passe menor", async () => {
    const { supabase, consultas } = db({ linhas: [] });

    const r = await listaAgendamentos(supabase, ORG, {
      de: "2026-01-01T00:00:00Z",
      ate: "2026-03-04T00:00:00Z", // 62 dias
      limite: 20,
    });

    expect(r.ok).toBe(true);
    expect(chamadasDe(consultas, "calendar_appointments").length).toBeGreaterThan(0);
  });

  it("período invertido é recusa, não lista vazia", async () => {
    // Vazio diria "não há nada marcado" quando a pergunta é que não se sustenta.
    const { supabase } = db();

    const r = await listaAgendamentos(supabase, ORG, {
      de: "2026-03-01T00:00:00Z",
      ate: "2026-01-01T00:00:00Z",
      limite: 20,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("janela_invalida");
    expect(r.motivoParaOperador).toContain("ate");
  });

  it("só `de` (sem `ate`) é recusa de período incompleto, não `sem_alvo`", async () => {
    // `sem_alvo` mandaria o modelo perguntar "de quem ou de que dia" — fora do
    // assunto: o chamador já disse QUANDO, só não disse até quando.
    const { supabase } = db();

    const r = await listaAgendamentos(supabase, ORG, { de: "2026-09-01T00:00:00Z", limite: 20 });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("janela_invalida");
    expect(r.codigo).not.toBe("sem_alvo");
  });

  it("⭐ com os dois, a organização INTEIRA é listada — nenhum outro recorte é pedido", async () => {
    // O `sem_alvo` existia justamente para impedir a varredura geral; com
    // `de`+`ate` a varredura é o PEDIDO, e recusá-la deixaria um calendário
    // externo sem como desenhar a semana.
    const { supabase, consultas } = db({ linhas: [] });

    const r = await listaAgendamentos(supabase, ORG, {
      de: "2026-09-01T00:00:00Z",
      ate: "2026-09-08T00:00:00Z",
      limite: 50,
    });

    expect(r.ok).toBe(true);
    // E o recorte chega ao banco como instante, dos dois lados.
    expect(limites(consultas, "gte")).toContain("2026-09-01T00:00:00Z");
    expect(limites(consultas, "lt")).toContain("2026-09-08T00:00:00Z");
    // Sem filtro de contato/lead/responsável: é a agenda de todo mundo.
    const eqs = chamadasDe(consultas, "calendar_appointments").filter((c) => c.metodo === "eq");
    expect(eqs.map((c) => c.args[0])).toEqual(["organization_id"]);
  });
});

describe("o `dia` é do fuso da ORGANIZAÇÃO (issue #1744)", () => {
  it("⭐ 12/09 em São Paulo recorta de 03:00Z a 03:00Z — o das 22h não some mais", async () => {
    // O defeito medido no código antigo: o corte em UTC fazia três horas do dia
    // 11 entrarem e as três últimas do 12 caírem fora. Um compromisso às 22h de
    // São Paulo era 01:00Z do dia seguinte — fora da lista do próprio dia.
    const { supabase, consultas } = db({ fuso: "America/Sao_Paulo", linhas: [] });

    const r = await listaAgendamentos(supabase, ORG, { dia: "2026-09-12", limite: 20 });

    expect(r.ok).toBe(true);
    expect(limites(consultas, "gte")).toEqual(["2026-09-12T03:00:00.000Z"]);
    expect(limites(consultas, "lt")).toEqual(["2026-09-13T03:00:00.000Z"]);
  });

  it("fuso de offset POSITIVO também fecha certo (Japão, +9)", async () => {
    // O mesmo corte, do outro lado: quem tem offset positivo tem o dia começando
    // na VÉSPERA em UTC. Só provar São Paulo deixaria metade do mundo sem teste.
    const { supabase, consultas } = db({ fuso: "Asia/Tokyo", linhas: [] });

    await listaAgendamentos(supabase, ORG, { dia: "2026-09-12", limite: 20 });

    expect(limites(consultas, "gte")).toEqual(["2026-09-11T15:00:00.000Z"]);
    expect(limites(consultas, "lt")).toEqual(["2026-09-12T15:00:00.000Z"]);
  });

  it("organização SEM fuso declarado cai no corte antigo, em UTC — degradação declarada", async () => {
    // Adivinhar seria pior que o defeito conhecido: `de`/`ate` é o recorte
    // exato para quem precisa dele, e o comportamento legado continua íntegro.
    const { supabase, consultas } = db({ fuso: null, linhas: [] });

    await listaAgendamentos(supabase, ORG, { dia: "2026-09-12", limite: 20 });

    expect(limites(consultas, "gte")).toEqual(["2026-09-12T00:00:00Z"]);
    expect(limites(consultas, "lt")).toEqual(["2026-09-12T23:59:59.999Z"]);
  });

  it("o fuso só é lido quando `dia` vem — quem pede período não paga a consulta", async () => {
    const { supabase, consultas } = db({ fuso: "America/Sao_Paulo", linhas: [] });

    await listaAgendamentos(supabase, ORG, {
      de: "2026-09-01T00:00:00Z",
      ate: "2026-09-08T00:00:00Z",
      limite: 20,
    });

    expect(chamadasDe(consultas, "organizations")).toEqual([]);
  });
});

describe("a paginação por cursor `depois_de` (issue #1744)", () => {
  const INICIO = "2026-09-12T15:00:00.000Z";
  const ID = "9a1f0000-0000-4000-8000-000000000001";

  it("⭐ o cursor vira o predicado (starts_at, id) — com o desempate, senão empatados repetem", async () => {
    const { supabase, consultas } = db({ linhas: [] });

    const r = await listaAgendamentos(supabase, ORG, {
      de: "2026-09-01T00:00:00Z",
      ate: "2026-09-08T00:00:00Z",
      depoisDe: codificarCursorDaLista({ inicio: INICIO, id: ID }),
      limite: 20,
    });

    expect(r.ok).toBe(true);
    const ors = chamadasDe(consultas, "calendar_appointments").filter((c) => c.metodo === "or");
    expect(ors).toHaveLength(1);
    expect(ors[0]!.args[0]).toBe(
      `starts_at.gt.${INICIO},and(starts_at.eq.${INICIO},id.gt.${ID})`,
    );
  });

  it("a ordenação leva o `id` como segunda chave — sem ela o cursor não determina nada", async () => {
    const { supabase, consultas } = db({ linhas: [] });

    await listaAgendamentos(supabase, ORG, { contactId: ID, limite: 20 });

    const orders = chamadasDe(consultas, "calendar_appointments").filter(
      (c) => c.metodo === "order",
    );
    expect(orders.map((c) => c.args[0])).toEqual(["starts_at", "id"]);
  });

  it("cursor que esta listagem não emitiu é recusa `cursor_invalido`, não exceção", async () => {
    const { supabase, consultas } = db({ linhas: [] });

    const r = await listaAgendamentos(supabase, ORG, {
      contactId: ID,
      depoisDe: "isto-nao-e-cursor",
      limite: 20,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("cursor_invalido");
    // A consulta foi MONTADA mas nunca EXECUTADA — a leitura não aconteceu.
    expect(chamadasDe(consultas, "calendar_appointments").filter((c) => c.metodo === "execucao")).toEqual([]);
  });

  it("⭐ `proximo` nasce de `limite + 1` — há mais página, e o cursor aponta para o último VISTO", async () => {
    const { supabase } = db({
      linhas: [
        { id: ID, starts_at: INICIO, title: "Consulta", ends_at: INICIO, time_zone: "America/Sao_Paulo", status: "confirmed", revision: 1 },
        { id: "9a1f0000-0000-4000-8000-000000000002", starts_at: "2026-09-12T16:00:00.000Z", title: "Retorno", ends_at: "2026-09-12T16:30:00.000Z", time_zone: "America/Sao_Paulo", status: "confirmed", revision: 1 },
      ],
    });

    const r = await listaAgendamentos(supabase, ORG, { contactId: ID, limite: 1 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A página entrega no máximo `limite`…
    expect(r.agendamentos).toHaveLength(1);
    expect(r.agendamentos[0]!.id).toBe(ID);
    // …e o cursor aponta para o ÚLTIMO ITEM DA PÁGINA, não para o descartado:
    // é ele que a próxima chamada deve recomeçar DEPOIS.
    expect(r.proximo).toBeTruthy();
    expect(JSON.parse(Buffer.from(String(r.proximo), "base64url").toString("utf8"))).toEqual({
      inicio: INICIO,
      id: ID,
    });
  });

  it("quando a página ESGOTA, `proximo` é `null` — o integrante para de perguntar", async () => {
    const { supabase } = db({
      linhas: [
        { id: ID, starts_at: INICIO, title: "Consulta", ends_at: INICIO, time_zone: "America/Sao_Paulo", status: "confirmed", revision: 1 },
      ],
    });

    const r = await listaAgendamentos(supabase, ORG, { contactId: ID, limite: 1 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proximo).toBeNull();
  });
});

describe("o que a resposta traz para um calendário desenhar (issue #1744)", () => {
  const linha = {
    id: "9a1f0000-0000-4000-8000-0000000000aa",
    title: "Consulta inicial",
    starts_at: "2026-09-12T15:00:00.000Z",
    ends_at: "2026-09-12T15:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    revision: 1,
    meeting_state: "none",
    meeting_url: null,
    owner_user_id: "11111111-1111-4111-8111-111111111111",
    contact_id: "22222222-2222-4222-8222-222222222222",
    contacts: { name: "Maria", display_name: "Maria Silva" },
    location_kind: "in_person",
    location_details: "Sala 2",
    calendar_event_types: { id: "t-1", name: "Consulta", slug: "consulta" },
  };

  it("⭐ item com contato, tipo e local — o que o calendário mostra", async () => {
    const { supabase } = db({ linhas: [linha] });

    const r = await listaAgendamentos(supabase, ORG, { de: "2026-09-01T00:00:00Z", ate: "2026-09-08T00:00:00Z", limite: 20 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.agendamentos[0]!;
    // O nome do contato vem do helper (`nomeDoContato`), não de string montada —
    // e segue a ordem DELE: `name` (o que a pessoa escolheu) antes de
    // `display_name` (o pushName do aparelho).
    expect(item.contatoNome).toBe("Maria");
    expect(item.tipo).toEqual({ slug: "consulta", nome: "Consulta" });
    expect(item.local).toEqual({ tipo: "in_person", descricao: "Sala 2" });
    expect(item.leadIds).toEqual([]);
  });

  it("compromisso SEM tipo (bloqueio do Google) devolve `tipo: null`, nunca um inventado", async () => {
    const { supabase } = db({ linhas: [{ ...linha, calendar_event_types: null, location_kind: null, location_details: null }] });

    const r = await listaAgendamentos(supabase, ORG, { de: "2026-09-01T00:00:00Z", ate: "2026-09-08T00:00:00Z", limite: 20 });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agendamentos[0]!.tipo).toBeNull();
    expect(r.agendamentos[0]!.local).toEqual({ tipo: null, descricao: null });
  });

  it("⭐ o vínculo com o negócio vem quando PEDIDO, e a consulta extra acontece", async () => {
    const { supabase, consultas } = db({
      linhas: [linha],
      vinculos: [{ lead_id: "33333333-3333-4333-8333-333333333333", target_id: linha.id }],
    });

    const r = await listaAgendamentos(supabase, ORG, {
      de: "2026-09-01T00:00:00Z",
      ate: "2026-09-08T00:00:00Z",
      comLeadIds: true,
      limite: 20,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agendamentos[0]!.leadIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(chamadasDe(consultas, "crm_lead_links").length).toBeGreaterThan(0);
  });

  it("quem NÃO pede o vínculo (a grade da tela) não paga a consulta extra", async () => {
    // Custo medido e opt-in: uma segunda ida ao banco por página, para um
    // campo que a tela não publica.
    const { supabase, consultas } = db({ linhas: [linha] });

    await listaAgendamentos(supabase, ORG, {
      de: "2026-09-01T00:00:00Z",
      ate: "2026-09-08T00:00:00Z",
      limite: 20,
    });

    expect(chamadasDe(consultas, "crm_lead_links")).toEqual([]);
  });

  it("CONTROLE: sem nenhuma consulta o teste acima passaria por vacuidade — há linhas de verdade", async () => {
    // Rede contra falso verde: se o dublê devolvesse `[]`, os casos de cima
    // falhariam, mas este prova que o caminho feliz existe.
    const { supabase } = db({ linhas: [linha] });
    const r = await listaAgendamentos(supabase, ORG, { de: "2026-09-01T00:00:00Z", ate: "2026-09-08T00:00:00Z", limite: 20 });
    expect(r.ok && r.agendamentos.length).toBeGreaterThan(0);
  });
});
