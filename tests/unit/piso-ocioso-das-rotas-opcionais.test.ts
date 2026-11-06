/**
 * AS ROTAS DOS RECURSOS OPCIONAIS SAEM PELO PORTÃO (#3731, fatia do piso
 * ocioso dos crons) — medido rota por rota, com contagem.
 *
 * O que estas rotas tinham em comum: todas são de recurso que a organização
 * PODE não ter (agenda conectada, aviso ligado, automação de aniversário,
 * contato sem foto/nome/telefone, proposta enviada, negócio aberto, agente de
 * IA). Numa instalação que não ligou o recurso, cada batida ia ao PostgREST
 * para receber a lista vazia — e é essa cota que o `PGRST002` estoura.
 *
 * Para CADA rota, dois casos:
 *
 *   desligado → `pulado: "recurso_ocioso"`, ZERO `from()`/`rpc()` no cliente
 *               admin e ZERO `pool.query` (nenhuma leitura, nem a do portão:
 *               o retrato é semeado);
 *   ligado    → a rota segue o caminho normal e consulta a tabela dela. Sem
 *               este lado, "economizar" poderia ser só "desligar o cron".
 *
 * O portão é o REAL (`lib/cron/piso-ocioso.ts`), semeado com `semearRetrato` —
 * mock de módulo vaza entre arquivos da suíte. O relógio, o cache e a
 * invalidação ficam em `lib/cron/piso-ocioso.test.ts`; a cerca de quem declara
 * os passos abaixo do portão, em `tests/unit/cron-passa-pelo-portao.test.ts`.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerRetrato, RECURSOS_DO_CRON, type RecursoDoCron, semearRetrato } from "@/lib/cron/piso-ocioso";

const estado = vi.hoisted(() => ({
  /** Toda tabela tocada por `from()` — a prova de "não tocou o PostgREST". */
  consultas: {} as Record<string, number>,
  rpcs: [] as string[],
  /** Toda chamada ao pool `pg` — o portão também passa por aqui. */
  queriesNoPool: 0,
}));

function cadeia(tabela: string): Record<string, unknown> {
  estado.consultas[tabela] = (estado.consultas[tabela] ?? 0) + 1;
  const passo: Record<string, unknown> = {};
  for (const verbo of [
    "select", "eq", "neq", "in", "is", "not", "or", "lt", "lte", "gt", "gte",
    "order", "limit", "update", "delete",
  ]) {
    passo[verbo] = () => cadeia(tabela);
  }
  passo.maybeSingle = async () => ({ data: null, error: null });
  passo.single = async () => ({ data: null, error: null });
  passo.insert = async () => ({ data: null, error: null });
  passo.upsert = async () => ({ data: null, error: null });
  // Cadeia "aguardável": qualquer `await` sobre ela resolve com o vazio.
  passo.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
  return passo;
}

const clienteFalso = {
  from: (tabela: string) => cadeia(tabela),
  rpc: (fn: string) => {
    estado.rpcs.push(fn);
    return Promise.resolve({ data: {}, error: null });
  },
};

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({
    query: async () => {
      estado.queriesNoPool += 1;
      return { rows: [], rowCount: 0 };
    },
  }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
// A renovação da agenda para na configuração do app OAuth antes de tocar o
// banco; aqui ela "existe" para o caminho normal chegar na consulta.
vi.mock("@/lib/agenda/google/config", () => ({
  configuracaoDoGoogle: async () => ({ clientId: "teste", clientSecret: "teste" }),
}));

interface Caso {
  rota: string;
  /** O recurso do portão que a rota consulta. */
  recurso: RecursoDoCron;
  /** A tabela que o caminho normal lê primeiro. */
  tabela: string;
}

const CASOS: Caso[] = [
  { rota: "agenda-expira-pendentes", recurso: "agenda_pendentes", tabela: "calendar_appointments" },
  { rota: "agenda-google-refresh", recurso: "agenda_google_renovacao", tabela: "calendar_connections" },
  { rota: "agenda-resumo-do-dia", recurso: "aviso_de_agendamento", tabela: "config_aviso_de_agendamento" },
  { rota: "contact-avatars", recurso: "avatares_de_contato", tabela: "contacts" },
  { rota: "contact-birthdays", recurso: "aniversario_do_contato", tabela: "automation_rules" },
  { rota: "contact-names", recurso: "nomes_da_agenda", tabela: "contacts" },
  { rota: "contact-phones", recurso: "telefones_opacos", tabela: "contacts" },
  { rota: "kb-conversations-batch", recurso: "agentes_de_ia", tabela: "ai_agents" },
  { rota: "proposal-expiry", recurso: "propostas_a_vencer", tabela: "crm_proposals" },
  { rota: "risk-watcher", recurso: "leads_abertos", tabela: "crm_leads" },
];

const tudo = (valor: boolean) =>
  Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, valor])) as Record<RecursoDoCron, boolean>;

async function chamar(rota: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const mod = (await import(`@/app/api/v1/cron/${rota}/route`)) as {
    GET: (r: NextRequest) => Promise<Response>;
  };
  const res = await mod.GET(new NextRequest(`http://localhost/api/v1/cron/${rota}`));
  const corpo = (await res.json()) as { data?: Record<string, unknown> };
  return { status: res.status, data: corpo.data ?? {} };
}

beforeEach(() => {
  estado.consultas = {};
  estado.rpcs = [];
  estado.queriesNoPool = 0;
  esquecerRetrato();
});

afterEach(() => {
  esquecerRetrato();
});

describe.each(CASOS)("cron $rota (recurso $recurso)", ({ rota, recurso, tabela }) => {
  it("recurso ocioso: sai pelo portão sem UMA consulta ao PostgREST nem ao pool", async () => {
    semearRetrato(tudo(false));
    const { status, data } = await chamar(rota);

    expect(status).toBe(200);
    expect(data.pulado).toBe("recurso_ocioso");
    // Contagem, não comentário: nenhuma tabela foi tocada e o pool `pg` não
    // recebeu nem a consulta do portão (o retrato veio semeado).
    expect(estado.consultas).toEqual({});
    expect(estado.rpcs).toEqual([]);
    expect(estado.queriesNoPool).toBe(0);
  });

  it("recurso ligado: a rota segue o caminho normal e consulta a tabela dela", async () => {
    // Só o recurso DESTA rota ligado — se a rota consultar a chave errada do
    // retrato, ela sai cedo e este caso fica vermelho.
    semearRetrato({ ...tudo(false), [recurso]: true });
    const { status, data } = await chamar(rota);

    expect(status).toBe(200);
    expect(data.pulado).toBeUndefined();
    expect(estado.consultas[tabela] ?? 0).toBeGreaterThan(0);
  });
});
