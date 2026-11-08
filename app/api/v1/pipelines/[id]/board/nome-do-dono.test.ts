/**
 * #3945 (fatia 2) — O NOME DO RESPONSÁVEL HUMANO NO CARD DO FUNIL, sem uma
 * consulta por card e sem uma chamada ao GoTrue por dono.
 *
 * O quadro já trazia `owner_kind`, `owner_user_id` e o agente resolvido; o NOME
 * da pessoa vinha só da tela, por `/api/v1/team/assignable` — e aquela rota paga
 * `admin.auth.admin.getUserById` UMA VEZ POR MEMBRO
 * (`app/api/v1/team/assignable/route.ts:54-62`). Trazer o nome para o payload
 * pelo mesmo caminho custaria uma requisição HTTP ao GoTrue por dono do quadro.
 *
 * O que estes casos medem, na rota de verdade (dublê que APLICA os filtros):
 *
 *  1. o card do dono humano traz `owner_user_name`;
 *  2. **contagem**: 2 negócios e 12 negócios com donos distintos custam o MESMO
 *     número de consultas — uma leitura de `conversations`, não uma por card;
 *  3. **nenhum GoTrue**: o caminho `nomesDosAtendentes`/`createAdminClient` não
 *     é chamado (o dublê dele explode se for);
 *  4. **isolamento**: nome de pessoa de outra organização nunca aparece;
 *  5. sem cópia do nome, `owner_user_name` vem `null` e o card cai no rótulo
 *     anterior — nunca "undefined", nunca e-mail cru.
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
/**
 * O CAMINHO PROIBIDO. Se a rota (ou qualquer helper que ela chame) resolver o
 * nome pelo GoTrue, estoura aqui e o teste falha dizendo por quê — em vez de
 * passar devagar, que é como um N+1 de HTTP entra em produção.
 */
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(() => {
    throw new Error("GoTrue por dono: proibido no quadro (#3945)");
  }),
  nomesDosAtendentesCom: vi.fn(() => {
    throw new Error("GoTrue por dono: proibido no quadro (#3945)");
  }),
  membrosDaOrganizacao: vi.fn(() => {
    throw new Error("GoTrue por dono: proibido no quadro (#3945)");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("service role no quadro: proibido (#3945)");
  }),
}));

import { resolveLeadOwner } from "@/lib/kanban/owner";
import type { Lead } from "@/lib/types/leads";
import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  etapa,
  funilRow,
  makeDb,
  negocio,
  type LeadRow,
  type Registro,
} from "@/tests/helpers/stages-db-double";

const STAGE = "e1";

/** Um negócio ABERTO com dono humano. `status` é obrigatório: o quadro lê com
 * `.neq("status", "archived")`, e `NULL <> 'archived'` não é verdadeiro no
 * Postgres — sem o `open` a linha nem chega ao quadro (e o teste mediria o
 * dublê, não o nome). */
function doDono(id: string, userId: string, position: number): LeadRow {
  return negocio(id, STAGE, {
    status: "open",
    owner_kind: "user",
    owner_user_id: userId,
    position_in_stage: position,
  });
}

/** A cópia do nome na conversa atribuída (migration 0202) — a fonte sem GoTrue. */
function conversaDoDono(userId: string, nome: string | null, org = ORG_ID) {
  return {
    id: `c-${userId}-${org}-${nome ?? "sem-nome"}`,
    organization_id: org,
    contact_id: null,
    assigned_to_user_id: userId,
    assigned_to_user_name: nome,
    last_message_at: null,
    last_message_preview: null,
    unread_count_for_assignee: 0,
    tags: [],
  };
}

function dbDoQuadro(leads: LeadRow[], conversations: Array<Record<string, unknown>> = []): Registro {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: { fields: [], lost_reasons: [] } })],
    stages: [etapa({ id: STAGE, name: "Novo" })],
    leads,
    conversations,
  });
}

interface CorpoDoQuadro {
  data?: { leads: Array<{ id: string; owner_user_name?: string | null }> };
}

async function leQuadro(): Promise<{ status: number; leads: NonNullable<CorpoDoQuadro["data"]>["leads"] }> {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board`), {
    params: Promise.resolve({ id: PIPE }),
  });
  const body = (await res.json()) as CorpoDoQuadro;
  return { status: res.status, leads: body.data?.leads ?? [] };
}

const nomeDo = (leads: Array<{ id: string; owner_user_name?: string | null }>, id: string) =>
  leads.find((l) => l.id === id)?.owner_user_name;

describe("GET /board — o nome do responsável humano (#3945, fatia 2)", () => {
  it("⭐ o card do dono humano traz o NOME no payload — resolvido no servidor", async () => {
    dbDoQuadro(
      [doDono("n-1", "u-ana", 10), doDono("n-2", "u-beto", 20)],
      [conversaDoDono("u-ana", "Ana   Souza"), conversaDoDono("u-beto", "Beto Lima")],
    );

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    // Espaço interno colapsado: o nome vem de um `<input>` sem máscara.
    expect(nomeDo(leads, "n-1")).toBe("Ana Souza");
    expect(nomeDo(leads, "n-2")).toBe("Beto Lima");
    // O dono continua sendo HUMANO e identificado — o nome é aditivo.
    expect(leads.find((l) => l.id === "n-1")).toMatchObject({ owner_user_name: "Ana Souza" });
  });

  it("⭐ 2 e 12 negócios custam o MESMO número de consultas (sem N+1)", async () => {
    const dois = [
      doDono("n-1", "u-1", 10),
      doDono("n-2", "u-2", 20),
    ];
    const doze = Array.from({ length: 12 }, (_, i) => doDono(`n-${i + 1}`, `u-${i + 1}`, (i + 1) * 10));
    const nomes = Array.from({ length: 12 }, (_, i) => conversaDoDono(`u-${i + 1}`, `Pessoa ${i + 1}`));

    const pequeno = dbDoQuadro(dois, nomes);
    await leQuadro();
    const grande = dbDoQuadro(doze, nomes);
    const { leads } = await leQuadro();

    expect(nomeDo(leads, "n-12")).toBe("Pessoa 12");
    // A igualdade é a garantia: o custo não cresce com o número de cards.
    expect(grande.leituras.length).toBe(pequeno.leituras.length);
    // E a leitura do nome é UMA — nem por card, nem por dono.
    expect(grande.leituras.filter((t) => t === "conversations")).toHaveLength(1);
    expect(pequeno.leituras.filter((t) => t === "conversations")).toHaveLength(1);
  });

  it("⭐ o quadro não chama o GoTrue nem o service role para descobrir o nome", async () => {
    const admin = await import("@/lib/supabase/admin");
    dbDoQuadro([doDono("n-1", "u-ana", 10)], [conversaDoDono("u-ana", "Ana Souza")]);

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    expect(nomeDo(leads, "n-1")).toBe("Ana Souza");
    // Chamar qualquer um dos dois estouraria dentro do dublê acima; a asserção
    // explícita é para a leitura do vermelho dizer QUEM foi chamado.
    expect(admin.createAdminClient).not.toHaveBeenCalled();
  });

  it("⭐ sem cópia do nome: `null` e o card cai no rótulo anterior — nunca undefined", async () => {
    dbDoQuadro([doDono("n-1", "u-carla", 10), doDono("n-2", "u-ana", 20)], [
      conversaDoDono("u-ana", "Ana Souza"),
    ]);

    const { leads } = await leQuadro();

    expect(nomeDo(leads, "n-1")).toBeNull();
    expect(nomeDo(leads, "n-2")).toBe("Ana Souza");
    // Sem nome no payload, o mapa do time (comportamento anterior) ainda resolve;
    // e sem NENHUM dos dois, o badge diz "Responsável" — nunca "undefined".
    const semCopia = leads.find((l) => l.id === "n-1") as unknown as Lead;
    expect(resolveLeadOwner(semCopia, new Map([["u-carla", "Carla Dias"]])).name).toBe("Carla Dias");
    expect(resolveLeadOwner(semCopia, undefined).name).toBeNull();
  });

  it("⭐ o nome de OUTRA organização não aparece no quadro", async () => {
    dbDoQuadro(
      [
        doDono("n-ana", "u-ana", 10),
        doDono("n-carla", "u-carla", 20),
        doDono("n-duda", "u-duda", 30),
      ],
      [
        // A mesma pessoa, mas a cópia que existe é da OUTRA organização.
        conversaDoDono("u-ana", "Ana de Outra Org", OUTRA_ORG),
        // Alguém que só tem conversa na outra organização.
        conversaDoDono("u-carla", "Carla Externa", OUTRA_ORG),
        // O controle: a cópia da organização do quadro.
        conversaDoDono("u-duda", "Duda Real"),
      ],
    );

    const { status, leads } = await leQuadro();

    expect(status).toBe(200);
    expect(nomeDo(leads, "n-duda")).toBe("Duda Real");
    expect(nomeDo(leads, "n-carla")).toBeNull();
    expect(JSON.stringify(leads)).not.toContain("Outra Org");
    expect(JSON.stringify(leads)).not.toContain("Carla Externa");
  });

  it("e-mail cru na cópia NÃO vira nome no card (LGPD)", async () => {
    dbDoQuadro([doDono("n-1", "u-ana", 10)], [conversaDoDono("u-ana", "ana@exemplo.com")]);

    const { leads } = await leQuadro();

    expect(nomeDo(leads, "n-1")).toBeNull();
    expect(JSON.stringify(leads)).not.toContain("ana@exemplo.com");
  });

  it("quadro sem dono humano não lê `conversations` para nome (nada a resolver)", async () => {
    const semDono = makeDb({
      pipelines: [funilRow({ id: PIPE, name: "Pedidos", settings: { fields: [], lost_reasons: [] } })],
      stages: [etapa({ id: STAGE, name: "Novo" })],
      leads: [negocio("n-1", STAGE, { status: "open", position_in_stage: 10 })],
    });

    const { status } = await leQuadro();

    expect(status).toBe(200);
    expect(semDono.leituras).not.toContain("conversations");
  });
});
