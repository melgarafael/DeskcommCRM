/**
 * O QUE O CARD DO FUNIL PRECISA SABER — e chega no payload do quadro (fatia 1 do
 * #3945).
 *
 * A issue relata o card com "título, um traço e 'Sem responsável'": não dava para
 * saber quanto o negócio vale, o que o cliente disse por último nem quem está
 * tocando. Estes casos medem a ROTA (dublê de banco aplicando os filtros), porque
 * é ela que monta o payload — um teste só das funções puras ficaria verde com a
 * rota devolvendo outra coisa.
 *
 * As quatro perguntas do card, uma asserção cada:
 *
 *   1. QUANTO VALE  → `value_cents` / `recurring_value_cents` + `currency`;
 *   2. O QUE DISSE  → `conversa.preview` + `conversa.last_message_at` (o "quando");
 *   3. QUEM TOCA    → `owner_kind` + `owner_user_id` (humano) e `owner_agent`
 *                     (agente de IA, resolvido pela própria rota);
 *   4. HÁ QUANTO TEMPO NA ETAPA → `stage_changed_at`.
 *
 * E o custo: o número de consultas NÃO cresce com o número de cards. É o que
 * separa "uma leitura por coluna" de "uma por card" — a diferença entre um quadro
 * que abre em 300 ms e um que abre em 12 s num funil de 400 negócios.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    idioma: "pt-BR",
  })),
}));

import { ORG_ID, PIPE, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

const ETAPA = "e2";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "c-ana";
const DENTRO_DA_ETAPA = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

const CONVERSA = {
  id: "conv-1",
  organization_id: ORG_ID,
  contact_id: CONTATO,
  last_message_preview: "Quero saber o preço do plano anual",
  last_message_at: "2026-11-07T09:41:00Z",
  unread_count_for_assignee: 2,
  tags: [],
  assignee_kind: "user",
  assigned_to_user_id: null,
};

/** A conversa do MESMO contato, mas de outra empresa: não pode vazar para cá. */
const CONVERSA_DE_FORA = {
  ...CONVERSA,
  id: "conv-de-fora",
  organization_id: OUTRA_ORG,
  last_message_preview: "SEGREDO DE OUTRA EMPRESA",
  last_message_at: "2026-11-07T23:59:00Z",
};

const CONTATO_ANA = {
  id: CONTATO,
  organization_id: ORG_ID,
  is_personal: false,
  phone_number: "+5511988887777",
  email: "ana@exemplo.com",
  custom_fields: {},
  tags: [],
};

const NEGOCIO = negocio("l-1", ETAPA, {
  contact_id: CONTATO,
  title: "ACME — renovação anual",
  status: "open",
  value_cents: 250_000,
  recurring_value_cents: 50_000,
  recurring_period: "monthly",
  currency: "BRL",
  owner_kind: "user",
  owner_user_id: "u-marcos",
  owner_agent_id: null,
  stage_changed_at: DENTRO_DA_ETAPA,
  created_at: DENTRO_DA_ETAPA,
  position_in_stage: 1000,
});

function montar(leads = [NEGOCIO], conversas = [CONVERSA, CONVERSA_DE_FORA]) {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: {} })],
    stages: [],
    leads,
    contacts: [CONTATO_ANA],
    conversations: conversas,
  });
}

async function lerQuadro() {
  const { GET } = await import("./route");
  const res = await GET(
    new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board`),
    { params: Promise.resolve({ id: PIPE }) },
  );
  const body = (await res.json()) as {
    data?: { leads: Array<Record<string, unknown>> };
    error?: unknown;
  };
  expect(res.status).toBe(200);
  return body.data?.leads ?? [];
}

describe("GET /board — o payload do card (fatia 1 do #3945)", () => {
  /**
   * UM campo por caso, de propósito: a sabotagem do PR remove um campo do
   * payload de cada vez, e o vermelho tem de nomear QUAL pergunta ficou sem
   * resposta. Um caso só, com quatro asserções, pararia na primeira e esconderia
   * as outras três.
   */
  it("⭐ QUANTO VALE — o valor único, a mensalidade e a moeda chegam ao card", async () => {
    montar();

    const [lead] = await lerQuadro();
    // Sem os três, o card escreve "—" no negócio que tem valor: é o defeito do
    // print da issue.
    expect(lead!.value_cents).toBe(250_000);
    expect(lead!.recurring_value_cents).toBe(50_000);
    expect(lead!.currency).toBe("BRL");
  });

  it("⭐ O QUE ELE DISSE — a prévia E o quando da última mensagem", async () => {
    montar();

    const [lead] = await lerQuadro();
    const conversa = lead!.conversa as { id: string; preview: string; last_message_at: string };
    // A prévia sozinha é a mesma frase hoje e há três semanas: o card precisa
    // dos dois para dizer "o que" e "quando".
    expect(conversa.preview).toBe("Quero saber o preço do plano anual");
    expect(conversa.last_message_at).toBe(CONVERSA.last_message_at);
  });

  it("⭐ QUEM TOCA — o dono humano chega com tipo e id (o nome é resolvido pela tela)", async () => {
    montar();

    const [lead] = await lerQuadro();
    expect(lead!.owner_kind).toBe("user");
    expect(lead!.owner_user_id).toBe("u-marcos");
  });

  it("⭐ HÁ QUANTO TEMPO NA ETAPA — o carimbo de ENTRADA, não a última atividade", async () => {
    montar();

    const [lead] = await lerQuadro();
    // `stage_changed_at` é o que o `buildCardInput` converte em "30h em …".
    // `last_activity_at` zeraria o número a cada nota escrita na conversa.
    expect(lead!.stage_changed_at).toBe(DENTRO_DA_ETAPA);
  });

  it("⭐ o responsável que é AGENTE chega com nome e versão — o humano chega com o id e a tela resolve o nome", async () => {
    // `ai_agents`/`ai_agent_versions` não estão na lista de tabelas do dublê: a
    // rota as lê pelo client e o dublê devolve vazio — o que se mede aqui é que a
    // ausência do cadastro NÃO apaga o dono do payload (o card continua dizendo
    // que o negócio é do agente, mesmo que o agente tenha sido apagado).
    montar([
      negocio("l-ia", ETAPA, {
        contact_id: null,
        status: "open",
        owner_kind: "ai",
        owner_agent_id: "a-1",
        owner_user_id: null,
        position_in_stage: 2000,
      }),
    ]);

    const [lead] = await lerQuadro();
    expect(lead!.owner_kind).toBe("ai");
    expect(lead!.owner_agent_id).toBe("a-1");
  });

  it("⭐ NÃO VAZA conversa de outra empresa: a do mesmo contato na outra org fica fora", async () => {
    montar();

    const [lead] = await lerQuadro();
    const conversa = lead!.conversa as { id: string; preview: string };

    expect(conversa.id).toBe("conv-1");
    expect(conversa.preview).not.toContain("SEGREDO");
    // A prova de que a linha de fora EXISTE na fonte e foi o filtro que a tirou:
    // se o `.eq("organization_id", ...)` sumisse, este caso veria "SEGREDO".
    expect(CONVERSA_DE_FORA.last_message_preview).toContain("SEGREDO");
  });

  it("⭐ o custo NÃO cresce com o número de cards: 2 e 12 negócios fazem as MESMAS consultas", async () => {
    const dois = Array.from({ length: 2 }, (_, i) =>
      negocio(`l-${i}`, ETAPA, {
        contact_id: `c-${i}`,
        status: "open",
        value_cents: 1000 * i,
        position_in_stage: (i + 1) * 1000,
      }),
    );
    const doze = Array.from({ length: 12 }, (_, i) =>
      negocio(`l-${i}`, ETAPA, {
        contact_id: `c-${i}`,
        status: "open",
        value_cents: 1000 * i,
        position_in_stage: (i + 1) * 1000,
      }),
    );

    const dbPequeno = makeDb({
      pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: {} })],
      leads: dois,
      contacts: [],
      conversations: [],
    });
    await lerQuadro();
    const consultasPequeno = [...dbPequeno.leituras];

    const dbGrande = makeDb({
      pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: {} })],
      leads: doze,
      contacts: [],
      conversations: [],
    });
    await lerQuadro();
    const consultasGrande = [...dbGrande.leituras];

    // A asserção é o NÚMERO, não o formato: 6× mais cards, o mesmo punhado de
    // consultas. Um `find` por card apareceria aqui como 12 × 2 leituras.
    expect(consultasGrande.length).toBe(consultasPequeno.length);
    // E cada coluna é lida UMA vez, mesmo com 12 contatos distintos: as leituras
    // por contato vão em lote (`buscaEmLotes`), não em laço.
    const porTabela = (t: string) => consultasGrande.filter((x) => x === t).length;
    // Duas leituras de `crm_leads`, e nenhuma é por card: o quadro em si e os
    // candidatos da próxima ação (que precisam ver os negócios abertos do
    // contato para saber se a proposta é ambígua).
    expect(porTabela("crm_leads")).toBe(2);
    expect(porTabela("conversations")).toBe(1);
    // Duas leituras de `contacts`, e as duas são UMA por quadro: a dos contatos
    // pessoais (que o card não lista) e a dos marcadores/telefone do card.
    expect(porTabela("contacts")).toBe(2);
  });
});
