/**
 * A MÉTRICA DO OPERADOR TEM A DIMENSÃO DO AGENTE QUE A TELA MOSTRA.
 *
 * ## O que este arquivo protege
 *
 * O invariante 7 (`docs/doctrine/sistema-vivo.md`) não pede que o desfecho seja
 * gravado — pede que ele **volte e mude a decisão seguinte**. O painel do papel
 * Operador (`PainelDoOperador`) é o consumidor declarado dessa volta, e ele vive
 * dentro de `/app/ai/agents/[id]`: a página de **um** agente. A frase
 * *"tinha algo a registrar e nenhuma capacidade marcada — o que resolve é marcar
 * abaixo"* manda agir no `ToolPicker` daquele agente e de mais nenhum.
 *
 * Uma métrica agregada por organização na página de um agente aponta uma ação
 * concreta e errada: numa organização com dois agentes, o painel de A manda
 * mexer nas capacidades de A por causa de turnos de B. E *"se ele parar de agir,
 * alguém vê"* (spec 16 §7) fica falsa por agente.
 *
 * ## A armadilha do conserto ingênuo — falha-em-verde
 *
 * Filtrar por agente **só no leitor** é pior que não filtrar: `event_log` não tem
 * coluna de agente, e o payload que o Operador gravava não levava `agent_id`. Um
 * filtro sobre chave que ninguém escreve casa zero linha, e o painel diria
 * *"Nenhuma conversa passou por aqui"* para sempre. Por isso o último bloco faz a
 * ida e volta: grava pelo EMISSOR real (`registrarDesfecho`) e lê pela rota.
 *
 * ## Por que o dublê aplica os filtros de verdade
 *
 * Um mock que devolvesse contagem fixa mediria que a rota chama `.eq()`, não que
 * ela **conta certo**. O dublê avalia cada filtro contra as linhas, com a
 * semântica de SQL que importa aqui: comparação com NULL não casa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";
import { registrarDesfecho } from "@/lib/agent-engine/agent/operator-turn";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { GET } from "@/app/api/v1/ai/operator-metrics/route";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "bbbbbbbb-0000-4000-8000-000000000001";
const AGENTE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENTE_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const AGENTE_DE_OUTRA_ORG = "bbbbbbbb-0000-4000-8000-00000000000c";

type Linha = Record<string, unknown>;

const AGENTES: Linha[] = [
  { id: AGENTE_A, organization_id: ORG },
  { id: AGENTE_B, organization_id: ORG },
  { id: AGENTE_DE_OUTRA_ORG, organization_id: OUTRA_ORG },
];

/** Uma linha de `event_log` como o Operador a grava, com o agente declarado. */
function turno(agente: string, extra: Record<string, unknown> = {}): Linha {
  return {
    id: `${agente}-${Math.random()}`,
    organization_id: ORG,
    event_type: "agent.operator_turn",
    created_at: new Date().toISOString(),
    payload: {
      desfecho: "agiu",
      agent_id: agente,
      ferramentas_chamadas: [] as string[],
      promessas_declaradas: 0,
      promessa_assumida_por: null,
      promessa_sem_dono_porque: null,
      ...extra,
    },
  };
}

/** Resolve `col`, `payload->>chave` e `payload->chave->>0` como o Postgres faria. */
function valorDe(linha: Linha, caminho: string): string | null {
  const partes = caminho.split(/->>?/).filter((p) => p.length > 0);
  let atual: unknown = linha[partes[0]!];
  for (const parte of partes.slice(1)) {
    if (atual === undefined || atual === null) return null;
    const chave = /^\d+$/.test(parte) ? Number(parte) : parte;
    atual = (atual as Record<string | number, unknown>)[chave];
  }
  if (atual === undefined || atual === null) return null;
  return typeof atual === "object" ? JSON.stringify(atual) : String(atual);
}

type Filtro = (l: Linha) => boolean;

/** Dublê do client de sessão: `ai_agents` (maybeSingle) e `event_log` (contagem). */
function fazerDb(eventos: Linha[]) {
  const from = (tabela: string) => {
    const filtros: Filtro[] = [];
    const casadas = () =>
      (tabela === "event_log" ? eventos : tabela === "ai_agents" ? AGENTES : []).filter((l) =>
        filtros.every((f) => f(l)),
      );
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filtros.push((l) => valorDe(l, col) === String(val));
        return chain;
      },
      gte: (col: string, val: unknown) => {
        filtros.push((l) => {
          const v = valorDe(l, col);
          return v !== null && v >= String(val);
        });
        return chain;
      },
      not: (col: string, op: string, val: unknown) => {
        filtros.push((l) => {
          const v = valorDe(l, col);
          if (op === "is" && val === null) return v !== null;
          if (op === "eq") return v !== null && v !== String(val);
          throw new Error(`operador não suportado no dublê: not(${col}, ${op})`);
        });
        return chain;
      },
      maybeSingle: async () => ({ data: casadas()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ count: casadas().length, error: null }).then(res),
    };
    return chain;
  };
  return { from };
}

async function pedir(eventos: Linha[], query: string) {
  vi.mocked(createClient).mockResolvedValue(fazerDb(eventos) as never);
  const resp = await GET(new Request(`http://localhost/api/v1/ai/operator-metrics${query}`));
  const corpo = (await resp.json()) as {
    data?: { turnos: number; agiu: number; quisAgirENaoPode: number };
    error?: { code: string };
  };
  return { status: resp.status, corpo };
}

async function medir(eventos: Linha[], agente: string) {
  const { status, corpo } = await pedir(eventos, `?agent_id=${agente}`);
  expect(status, "a rota precisa responder 200 para um gerente").toBe(200);
  return corpo.data!;
}

beforeEach(() => vi.mocked(createClient).mockReset());

describe("a volta do papel Operador é do agente que a tela mostra (invariante 7)", () => {
  it("turnos de OUTRO agente não entram na contagem do agente aberto", async () => {
    const linhas = [turno(AGENTE_A), turno(AGENTE_A), turno(AGENTE_B), turno(AGENTE_B), turno(AGENTE_B)];
    const m = await medir(linhas, AGENTE_A);
    expect(m.turnos, "a contagem somou turnos de outro agente").toBe(2);
  });

  it("'quis agir e não pôde' é do agente aberto — é o número que manda mexer na configuração DELE", async () => {
    const semMao = { promessas_declaradas: 1, promessa_sem_dono_porque: "operador_sem_ferramentas" };
    const linhas = [turno(AGENTE_A), turno(AGENTE_B, semMao), turno(AGENTE_B, semMao)];
    const m = await medir(linhas, AGENTE_A);
    expect(m.quisAgirENaoPode, "contou falta de capacidade de outro agente").toBe(0);
  });

  it("'se ele parar de agir, alguém vê' — A parado com B trabalhando mostra A parado", async () => {
    const agiu = { ferramentas_chamadas: ["crm_schedule_followup"] };
    const linhas = [turno(AGENTE_A), turno(AGENTE_B, agiu), turno(AGENTE_B, agiu)];
    const m = await medir(linhas, AGENTE_A);
    expect(m.turnos).toBe(1);
    expect(m.agiu, "creditou a A a ação de outro agente").toBe(0);
  });

  it("sem `agent_id` a rota segue devolvendo o agregado da organização", async () => {
    const { status, corpo } = await pedir([turno(AGENTE_A), turno(AGENTE_B)], "");
    expect(status).toBe(200);
    expect(corpo.data!.turnos).toBe(2);
  });
});

describe("o agente pedido tem de ser da organização da sessão", () => {
  it("agente de OUTRA organização responde 404, não 'zero turnos'", async () => {
    const { status, corpo } = await pedir([turno(AGENTE_A)], `?agent_id=${AGENTE_DE_OUTRA_ORG}`);
    expect(status).toBe(404);
    expect(corpo.error?.code).toBe("not_found");
  });

  it("id que não é uuid é recusado antes de chegar ao banco", async () => {
    const { status } = await pedir([], "?agent_id=nao-e-uuid");
    expect(status).toBe(422);
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });
});

describe("ida e volta: o que o EMISSOR grava é o que o LEITOR filtra", () => {
  /** Grava pelo `registrarDesfecho` real e devolve a linha como o `event_log` a guardaria. */
  async function gravarPeloEmissor(agente: string): Promise<Linha> {
    const inserts: unknown[][] = [];
    const pool = { query: vi.fn(async (_sql: string, params: unknown[]) => void inserts.push(params)) };
    const log = { info: vi.fn(), warn: vi.fn() };
    await registrarDesfecho(
      pool as never,
      {
        tenantId: ORG,
        leadId: "lead-1",
        jobId: "job-1",
        originJobId: "job-0",
        conversationId: "conv-1",
        agentId: agente,
        desfecho: { tipo: "agiu", ferramentas: 1 },
        promessasDeclaradas: 0,
        dono: null,
        ferramentasChamadas: ["crm_update_lead"],
        houveCheckpoint: null,
      },
      log,
    );
    expect(log.warn, "o insert do desfecho falhou no dublê").not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    const [organizationId, , payload] = inserts[0]!;
    return {
      id: "emitida",
      organization_id: organizationId,
      event_type: "agent.operator_turn",
      created_at: new Date().toISOString(),
      payload: JSON.parse(payload as string),
    };
  }

  it("turno gravado pelo Operador para A aparece no painel de A — e não no de B", async () => {
    // Zero no painel de A denuncia filtro fantasma: o leitor filtrando uma chave
    // que o emissor não escreve.
    const linha = await gravarPeloEmissor(AGENTE_A);
    const deA = await medir([linha], AGENTE_A);
    expect(deA.turnos, "o filtro por agente não casa a chave que o Operador grava").toBe(1);
    expect(deA.agiu).toBe(1);
    const deB = await medir([linha], AGENTE_B);
    expect(deB.turnos).toBe(0);
  });
});
