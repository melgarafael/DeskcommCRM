import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createSupabaseFollowupGateDb,
  decidirAgenteDoEnrollmentAutomatico,
  resolveAgentForAutomaticTrigger,
  type EnabledFollowupAgent,
  type FollowupGateDb,
} from "./agent-followup-gate";

/**
 * #3928 (CR do mantenedor) — ESPECIALISTA DE ROTEADOR SEM NÚMERO PRÓPRIO.
 *
 * Desde a migration 0749 (#3284), um especialista de roteador de intenções pode
 * ser publicado sem número próprio (`ai_agent_versions.channel_session_id`
 * nulo). Ele atende PELO NÚMERO DO ROTEADOR: o portão do dreno
 * (`lib/ai/agents/quem-atende-a-sessao.ts`) conta os membros e o fallback do
 * roteador ATIVO naquele número.
 *
 * O adapter do gate do follow-up lia esse nulo como "canal desconhecido", e o
 * filtro `channelSessionId === canal` do #3852 nunca deixava o especialista
 * concorrer a um canal concreto. Numa organização com roteador, um fluxo de IA
 * armado SÓ por especialistas deixava de inscrever — exatamente o caminho que
 * o #3852 veio consertar.
 *
 * A régua é a MESMA do portão do dreno, na direção inversa (de agente para
 * números): `ai_routers.channel_session_id` dos roteadores com `is_active`, em
 * que o agente é `fallback_agent_id` ou membro (`ai_router_members`), sempre
 * recortado por `organization_id`. Não é uma segunda régua: são as mesmas
 * tabelas, as mesmas colunas e o mesmo `is_active` que o turno executa.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_VIZINHA = "22222222-2222-4222-8222-222222222222";
const POINTER = "33333333-3333-4333-8333-333333333333";

const CANAL_ROTEADOR = "aaaa1111-0000-4000-8000-00000000000a";
const CANAL_PROPRIO = "bbbb2222-0000-4000-8000-00000000000b";
const CANAL_VIZINHO = "cccc3333-0000-4000-8000-00000000000c";

const ESPECIALISTA = "e0000000-0000-4000-8000-0000000000e1";
const OUTRO_AGENTE = "a0000000-0000-4000-8000-0000000000a2";
const ROTEADOR = "r0000000-0000-4000-8000-0000000000r1";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

interface Consulta {
  tabela: string;
  colunas: string;
  filtros: Array<[string, unknown]>;
}

/**
 * Postgres/PostgREST de mentira: FILTRA de verdade pelos `eq`/`in` que o
 * adapter mandar. É o que torna visível uma leitura sem `organization_id` — a
 * linha da organização vizinha vazaria para a lista.
 */
function adminDeMentira(tabelas: Tabelas): { admin: SupabaseClient; consultas: Consulta[] } {
  const consultas: Consulta[] = [];

  function construtor(tabela: string, colunas: string, filtros: Array<[string, unknown]>, registrada?: Consulta) {
    // A consulta registrada é a MESMA referência que a cadeia vai preenchendo:
    // assim o teste enxerga os `eq`/`in` que o adapter mandou, e não só a tabela.
    const consulta = registrada ?? { tabela, colunas, filtros };
    const linhas = (): Linha[] =>
      (tabelas[tabela] ?? []).filter((linha) =>
        consulta.filtros.every(([coluna, valor]) =>
          Array.isArray(valor) ? valor.includes(linha[coluna]) : linha[coluna] === valor,
        ),
      );
    const resposta = () => Promise.resolve({ data: linhas(), error: null });
    const filtra = (coluna: string, valor: unknown) => {
      consulta.filtros.push([coluna, valor]);
      return construtor(tabela, colunas, consulta.filtros, consulta);
    };
    return {
      eq: (coluna: string, valor: unknown) => filtra(coluna, valor),
      in: (coluna: string, valor: unknown[]) => filtra(coluna, valor),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown, falha?: (e: unknown) => unknown) =>
        resposta().then(ok, falha),
    };
  }

  const admin = {
    from(tabela: string) {
      return {
        select(colunas: string) {
          const consulta: Consulta = { tabela, colunas, filtros: [] };
          consultas.push(consulta);
          return construtor(tabela, colunas, consulta.filtros, consulta);
        },
      };
    },
  } as unknown as SupabaseClient;

  return { admin, consultas };
}

/** O banco do caso: um roteador ativo no `canal` com o agente que se quer testar. */
function banco(opcoes: {
  versoes: Linha[];
  roteadores?: Linha[];
  membros?: Linha[];
}): Tabelas {
  return {
    ai_agent_versions: opcoes.versoes,
    ai_routers: opcoes.roteadores ?? [],
    ai_router_members: opcoes.membros ?? [],
  };
}

const versaoDoEspecialista = (canal: string | null, pointer = POINTER): Linha => ({
  organization_id: ORG,
  agent_id: ESPECIALISTA,
  channel_session_id: canal,
  status: "published",
  followup: { enabled: true, flow_pointer_ids: [pointer] },
});

const roteadorAtivoNo = (canal: string, fallback: string | null = null): Linha => ({
  id: ROTEADOR,
  organization_id: ORG,
  channel_session_id: canal,
  is_active: true,
  fallback_agent_id: fallback,
});

const membroDoRoteador = (agente: string): Linha => ({
  router_id: ROTEADOR,
  organization_id: ORG,
  agent_id: agente,
});

function gateDe(tabelas: Tabelas): FollowupGateDb {
  return createSupabaseFollowupGateDb(adminDeMentira(tabelas).admin);
}

describe("#3928 — especialista de roteador publicado SEM número próprio", () => {
  it("atende pelo número do roteador ATIVO em que é membro (medição do mantenedor)", async () => {
    const db = gateDe(
      banco({
        versoes: [versaoDoEspecialista(null)],
        roteadores: [roteadorAtivoNo(CANAL_ROTEADOR)],
        membros: [membroDoRoteador(ESPECIALISTA)],
      }),
    );

    // Sem o canal: a decisão de hoje, intacta (contrato do #3852).
    await expect(decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER, true)).resolves.toEqual({
      agentId: ESPECIALISTA,
      barrado: false,
    });

    // Com o canal do roteador: o especialista CONCORRE. Antes do conserto:
    // `{ agentId: null, barrado: true }` — o fluxo de IA deixava de inscrever.
    await expect(decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER, true, CANAL_ROTEADOR)).resolves.toEqual({
      agentId: ESPECIALISTA,
      barrado: false,
    });
  });

  it("o FALLBACK do roteador ativo também atende — não só o membro", async () => {
    const db = gateDe(
      banco({
        versoes: [versaoDoEspecialista(null)],
        roteadores: [roteadorAtivoNo(CANAL_ROTEADOR, ESPECIALISTA)],
        membros: [],
      }),
    );

    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_ROTEADOR)).resolves.toBe(ESPECIALISTA);
  });

  it("a lista SOMA: número próprio e número do roteador em que é membro", async () => {
    const db = gateDe(
      banco({
        versoes: [versaoDoEspecialista(CANAL_PROPRIO)],
        roteadores: [roteadorAtivoNo(CANAL_ROTEADOR)],
        membros: [membroDoRoteador(ESPECIALISTA)],
      }),
    );

    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_PROPRIO)).resolves.toBe(ESPECIALISTA);
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_ROTEADOR)).resolves.toBe(ESPECIALISTA);
  });

  it("roteador ativo SEM número não vira canal nenhum (nada de `''` na lista)", async () => {
    const db = gateDe(
      banco({
        versoes: [versaoDoEspecialista(null)],
        roteadores: [{ ...roteadorAtivoNo(CANAL_ROTEADOR), channel_session_id: null }],
        membros: [membroDoRoteador(ESPECIALISTA)],
      }),
    );

    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_ROTEADOR)).resolves.toBeNull();
  });
});

describe("#3928 — o lado oposto continua barrado", () => {
  it("especialista publicado em OUTRO número, sem roteador, não atende este canal", async () => {
    const db = gateDe(banco({ versoes: [versaoDoEspecialista(CANAL_PROPRIO)] }));

    await expect(decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER, true, CANAL_ROTEADOR)).resolves.toEqual({
      agentId: null,
      barrado: true,
    });
    // e o número dele continua valendo
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_PROPRIO)).resolves.toBe(ESPECIALISTA);
  });

  it("roteador INATIVO não empresta o número: continua barrado", async () => {
    const db = gateDe(
      banco({
        versoes: [versaoDoEspecialista(null)],
        roteadores: [{ ...roteadorAtivoNo(CANAL_ROTEADOR), is_active: false }],
        membros: [membroDoRoteador(ESPECIALISTA)],
      }),
    );

    await expect(decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER, true, CANAL_ROTEADOR)).resolves.toEqual({
      agentId: null,
      barrado: true,
    });
  });

  it("sem o parâmetro de canal a decisão de hoje NÃO muda (menor uuid vence)", async () => {
    const db = gateDe(
      banco({
        versoes: [
          { ...versaoDoEspecialista(CANAL_PROPRIO), agent_id: OUTRO_AGENTE },
          versaoDoEspecialista(null),
        ],
        roteadores: [roteadorAtivoNo(CANAL_ROTEADOR)],
        membros: [membroDoRoteador(ESPECIALISTA)],
      }),
    );

    const semCanal = await decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER, true);
    expect(semCanal).toEqual({
      agentId: ESPECIALISTA < OUTRO_AGENTE ? ESPECIALISTA : OUTRO_AGENTE,
      barrado: false,
    });
  });
});

describe("#3928 — organização vizinha nunca entra na lista", () => {
  it("roteador de outra organização no MESMO número não empresta o canal", async () => {
    const db = gateDe({
      ai_agent_versions: [versaoDoEspecialista(null)],
      ai_routers: [{ ...roteadorAtivoNo(CANAL_VIZINHO), organization_id: ORG_VIZINHA }],
      ai_router_members: [{ ...membroDoRoteador(ESPECIALISTA), organization_id: ORG_VIZINHA }],
    });

    await expect(decidirAgenteDoEnrollmentAutomatico(db, ORG, POINTER, true, CANAL_VIZINHO)).resolves.toEqual({
      agentId: null,
      barrado: true,
    });
  });

  it("toda leitura nova leva `organization_id` — version, roteador e membro", async () => {
    const { admin, consultas } = adminDeMentira(
      banco({
        versoes: [versaoDoEspecialista(null)],
        roteadores: [roteadorAtivoNo(CANAL_ROTEADOR)],
        membros: [membroDoRoteador(ESPECIALISTA)],
      }),
    );
    await createSupabaseFollowupGateDb(admin).loadEnabledPublishedFollowupAgents(ORG);

    const porTabela = new Map(consultas.map((c) => [c.tabela, c]));
    expect([...porTabela.keys()].sort()).toEqual(["ai_agent_versions", "ai_router_members", "ai_routers"]);
    for (const tabela of ["ai_agent_versions", "ai_routers", "ai_router_members"] as const) {
      const filtros = new Map(porTabela.get(tabela)?.filtros ?? []);
      expect(filtros.get("organization_id"), `${tabela} sem organization_id`).toBe(ORG);
    }
    // a régua do portão do dreno, coluna por coluna
    expect(porTabela.get("ai_routers")?.colunas).toContain("channel_session_id");
    expect(porTabela.get("ai_routers")?.colunas).toContain("fallback_agent_id");
    expect(new Map(porTabela.get("ai_routers")?.filtros ?? []).get("is_active")).toBe(true);
    expect(porTabela.get("ai_router_members")?.colunas).toContain("agent_id");
  });
});

describe("#3928 — a lista no gate puro (dublês)", () => {
  const fakeDb = (agentes: EnabledFollowupAgent[]): FollowupGateDb => ({
    async loadEnabledPublishedFollowupAgents(orgId) {
      return orgId === ORG ? agentes : [];
    },
  });

  it("um agente que atende em dois números concorre nos dois", async () => {
    const db = fakeDb([{ agentId: ESPECIALISTA, pointerIds: [POINTER], channelSessionIds: [CANAL_PROPRIO, CANAL_ROTEADOR] }]);

    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_PROPRIO)).resolves.toBe(ESPECIALISTA);
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_ROTEADOR)).resolves.toBe(ESPECIALISTA);
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_VIZINHO)).resolves.toBeNull();
  });

  it("lista VAZIA não é candidata a canal concreto, e segue concorrendo sem canal", async () => {
    const db = fakeDb([{ agentId: ESPECIALISTA, pointerIds: [POINTER], channelSessionIds: [] }]);

    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER, CANAL_PROPRIO)).resolves.toBeNull();
    await expect(resolveAgentForAutomaticTrigger(db, ORG, POINTER)).resolves.toBe(ESPECIALISTA);
  });
});
