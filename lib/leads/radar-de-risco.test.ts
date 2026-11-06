// lib/leads/radar-de-risco.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { carregaRadarDeRisco } from "./radar-de-risco";

interface LinhaDeProposta {
  id: string;
  lead_id: string | null;
  status: string;
  numero: number | null;
  ano: number | null;
  valid_until: string | null;
  versao: number;
  created_at: string;
  titulo?: string | null;
  contact_id?: string | null;
}

interface AvisoAberto {
  ref_id: string;
}

interface LinhaDeContato {
  id: string;
  name: string | null;
  display_name: string | null;
}

const ORG_ID = "22222222-2222-4222-8222-222222222222";

/**
 * `leadsAbertos`: ids que a consulta de `crm_leads` (status='open', funil
 * não-arquivado) devolveria. Default: deriva dos `lead_id` das propostas
 * (todo mundo "aberto"), para não quebrar os testes que não têm opinião
 * sobre isso.
 */
function montarAdmin(
  propostas: LinhaDeProposta[],
  leadsAbertos?: string[],
  extras?: { avisos?: AvisoAberto[]; contatos?: LinhaDeContato[] },
) {
  const idsAbertos = leadsAbertos ?? [...new Set(propostas.map((p) => p.lead_id).filter((id): id is string => id !== null))];
  const avisosAbertos = extras?.avisos ?? [];
  const contatos = extras?.contatos ?? [];
  const chamadas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = {
    from: vi.fn((tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      chamadas.push({ tabela, filtros });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cadeia: any = {
        select: () => cadeia,
        eq: (campo: string, valor: unknown) => {
          filtros.push([campo, valor]);
          return cadeia;
        },
        not: (campo: string, op: string, valor: unknown) => {
          filtros.push([`not:${campo}:${op}`, valor]);
          return cadeia;
        },
        order: () => cadeia,
        limit: () => cadeia,
        is: () => cadeia,
        in: (campo: string, valores: unknown) => {
          filtros.push([`in:${campo}`, valores]);
          return cadeia;
        },
        gt: () => cadeia,
        then: (resolve: (r: { data: unknown[]; error: null }) => void) => {
          if (tabela === "crm_proposals") return resolve({ data: [...propostas], error: null });
          if (tabela === "agent_inbox_items") return resolve({ data: [...avisosAbertos], error: null });
          if (tabela === "contacts") {
            const pedido = filtros.find(([campo]) => campo === "in:id")?.[1] as string[] | undefined;
            const linhas = pedido ? contatos.filter((c) => pedido.includes(c.id)) : [...contatos];
            return resolve({ data: linhas, error: null });
          }
          if (tabela === "crm_leads") {
            return resolve({
              data: idsAbertos.map((id) => ({
                id,
                title: "",
                contact_id: null,
                owner_user_id: null,
                owner_kind: null,
                owner_agent_id: null,
                stage_id: null,
                last_activity_at: null,
                created_at: "2026-01-01T00:00:00Z",
                pipeline_id: "pipeline-1",
              })),
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return cadeia;
    }),
  };
  return { admin, chamadas };
}

describe("carregaRadarDeRisco — propostas vencidas sem retomada (N3)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("negócio com proposta VENCIDA e SEM proposta mais nova: entra em propostas_vencidas_sem_retomada", async () => {
    const { admin } = montarAdmin([
      { id: "prop-1", lead_id: "lead-1", status: "vencida", numero: 1, ano: 2026, valid_until: "2026-01-01", versao: 1, created_at: "2026-01-01T00:00:00Z" },
    ]);
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_vencidas_sem_retomada.map((p) => p.lead_id)).toContain("lead-1");
    expect(radar.propostas_vencidas_sem_retomada[0]).toMatchObject({ proposal_id: "prop-1", numero: 1, ano: 2026 });
  });

  it("negócio com proposta vencida MAS já tem proposta mais nova enviada/aceita: NÃO entra", async () => {
    const { admin } = montarAdmin([
      { id: "prop-v1", lead_id: "lead-1", status: "vencida", numero: 1, ano: 2026, valid_until: "2026-01-01", versao: 1, created_at: "2026-01-01T00:00:00Z" },
      { id: "prop-v2", lead_id: "lead-1", status: "enviada", numero: 1, ano: 2026, valid_until: "2026-06-01", versao: 2, created_at: "2026-02-01T00:00:00Z" },
    ]);
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_vencidas_sem_retomada.map((p) => p.lead_id)).not.toContain("lead-1");
  });

  it("proposta órfã (lead_id nulo): fora da lista — sem negócio, sem linha no radar", async () => {
    const { admin } = montarAdmin([
      { id: "prop-orfa", lead_id: null, status: "vencida", numero: 1, ano: 2026, valid_until: "2026-01-01", versao: 1, created_at: "2026-01-01T00:00:00Z" },
    ]);
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_vencidas_sem_retomada).toEqual([]);
  });

  it("negócio com DUAS cadeias (uma vencida antiga, outra em voo mais nova): a cadeia NOVA vence — não entra na lista", async () => {
    const { admin } = montarAdmin([
      // Cadeia antiga: chegou a v2, vencida, numero 5 — versao alta mas ANTIGA.
      { id: "prop-cadeia-velha-v2", lead_id: "lead-1", status: "vencida", numero: 5, ano: 2026, valid_until: "2026-01-01", versao: 2, created_at: "2026-01-15T00:00:00Z" },
      // Cadeia nova: numero 9, v1, enviada — criada DEPOIS, versao baixa.
      { id: "prop-cadeia-nova-v1", lead_id: "lead-1", status: "enviada", numero: 9, ano: 2026, valid_until: "2026-06-01", versao: 1, created_at: "2026-03-01T00:00:00Z" },
    ]);
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_vencidas_sem_retomada.map((p) => p.lead_id)).not.toContain("lead-1");
  });

  it("negócio FECHADO (fora de crm_leads.status='open') com proposta vencida: NÃO entra", async () => {
    const { admin } = montarAdmin(
      [{ id: "prop-1", lead_id: "lead-fechado", status: "vencida", numero: 1, ano: 2026, valid_until: "2026-01-01", versao: 1, created_at: "2026-01-01T00:00:00Z" }],
      [], // nenhum lead aberto — lead-fechado não está na lista
    );
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_vencidas_sem_retomada).toEqual([]);
  });

  it("todas as consultas filtram organization_id (isolamento)", async () => {
    const { admin, chamadas } = montarAdmin([]);
    await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    const dePropostas = chamadas.filter((c) => c.tabela === "crm_proposals");
    expect(dePropostas.length).toBeGreaterThan(0);
    for (const c of dePropostas) {
      expect(c.filtros).toContainEqual(["organization_id", ORG_ID]);
    }
  });
});

describe("carregaRadarDeRisco — propostas esperando revisão (C6)", () => {
  beforeEach(() => vi.restoreAllMocks());

  const RASCUNHO = {
    id: "prop-1",
    lead_id: "lead-1",
    status: "rascunho",
    numero: null,
    ano: null,
    valid_until: "2026-10-16",
    versao: 1,
    created_at: "2026-09-26T00:00:00Z",
    titulo: "Site catálogo",
    contact_id: "c-1",
  };

  it("rascunho com aviso aberto entra, com título, contato e created_at", async () => {
    const { admin } = montarAdmin([RASCUNHO], undefined, {
      avisos: [{ ref_id: "prop-1" }],
      contatos: [{ id: "c-1", name: "Maria", display_name: null }],
    });
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_esperando_revisao).toEqual([
      {
        proposal_id: "prop-1",
        lead_id: "lead-1",
        titulo: "Site catálogo",
        contact_name: "Maria",
        created_at: "2026-09-26T00:00:00Z",
      },
    ]);
  });

  it("rascunho com aviso não mantém negócio fechado no radar geral", async () => {
    const { admin } = montarAdmin([RASCUNHO], [], { avisos: [{ ref_id: "prop-1" }] });
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_esperando_revisao).toEqual([]);
  });

  it("rascunho SEM aviso aberto não entra", async () => {
    const { admin } = montarAdmin([RASCUNHO], undefined, { avisos: [] });
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_esperando_revisao).toEqual([]);
  });

  it("só rascunho entra: enviada com aviso aberto não está esperando revisão", async () => {
    const { admin } = montarAdmin(
      [{ ...RASCUNHO, status: "enviada" }],
      undefined,
      { avisos: [{ ref_id: "prop-1" }] },
    );
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_esperando_revisao).toEqual([]);
  });

  it("órfã sem lead_id com aviso aberto: fora da lista — sem negócio, sem linha no radar", async () => {
    const { admin } = montarAdmin(
      [{ ...RASCUNHO, lead_id: null }],
      [],
      { avisos: [{ ref_id: "prop-1" }] },
    );
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_esperando_revisao).toEqual([]);
  });

  it("aviso de outra organização nunca entra: a leitura filtra organization_id, kind e status", async () => {
    const { admin, chamadas } = montarAdmin([RASCUNHO], undefined, {
      avisos: [{ ref_id: "prop-1" }],
    });
    await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    const deAvisos = chamadas.filter((c) => c.tabela === "agent_inbox_items");
    expect(deAvisos.length).toBeGreaterThan(0);
    for (const c of deAvisos) {
      expect(c.filtros).toContainEqual(["organization_id", ORG_ID]);
      expect(c.filtros).toContainEqual(["kind", "proposta_pronta_para_revisao"]);
      expect(c.filtros).toContainEqual(["status", "open"]);
    }
  });
});

// O Postgres honra `.order(last_activity_at asc).limit(500)`: numa org com mais
// de 500 abertos, o negócio recém-ativo fica FORA de `rows`. Este dublê honra
// order, limit, `status` e `in(id)`, como o banco, para provar que estar fora de
// `rows` não tira da revisão um negócio que segue aberto.
function montarAdminComTeto(leads: Array<{ id: string; status: string; last_activity_at: string }>) {
  const propostas = ["lead-ativo", "lead-fechado"].map((lead_id, i) => ({
    id: `prop-${i}`, lead_id, status: "rascunho", numero: null, ano: null, valid_until: null,
    versao: 1, created_at: "2026-11-04T00:00:00Z", titulo: "x", contact_id: null,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = {
    from: vi.fn((tabela: string) => {
      let limite = Infinity;
      let status: unknown;
      let ids: string[] | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cadeia: any = {
        select: () => cadeia, not: () => cadeia, order: () => cadeia, is: () => cadeia, gt: () => cadeia,
        eq: (campo: string, valor: unknown) => { if (campo === "status") status = valor; return cadeia; },
        in: (campo: string, valores: string[]) => { if (campo === "id") ids = valores; return cadeia; },
        limit: (n: number) => { limite = n; return cadeia; },
        then: (resolve: (r: { data: unknown[]; error: null }) => void) => {
          if (tabela === "crm_proposals") return resolve({ data: propostas, error: null });
          if (tabela === "agent_inbox_items") return resolve({ data: propostas.map((p) => ({ ref_id: p.id })), error: null });
          if (tabela === "crm_leads") {
            const linhas = leads
              .filter((l) => status === undefined || l.status === status)
              .filter((l) => ids === undefined || ids.includes(l.id))
              .sort((a, b) => a.last_activity_at.localeCompare(b.last_activity_at))
              .slice(0, limite)
              .map((l) => ({
                id: l.id, title: "", contact_id: null, owner_user_id: null, owner_kind: null, owner_agent_id: null,
                stage_id: null, last_activity_at: l.last_activity_at, created_at: l.last_activity_at, pipeline_id: "pipeline-1",
              }));
            return resolve({ data: linhas, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return cadeia;
    }),
  };
  return admin;
}

describe("carregaRadarDeRisco — revisão com mais de 500 negócios abertos (C6)", () => {
  const parados = Array.from({ length: 500 }, (_, i) => ({ id: `parado-${i}`, status: "open", last_activity_at: "2025-01-01T00:00:00Z" }));

  it("rascunho com aviso de negócio ABERTO e recém-ativo segue no radar geral", async () => {
    const admin = montarAdminComTeto([
      ...parados,
      { id: "lead-ativo", status: "open", last_activity_at: "2026-11-04T00:00:00Z" },
      { id: "lead-fechado", status: "won", last_activity_at: "2026-11-04T00:00:00Z" },
    ]);
    const radar = await carregaRadarDeRisco(admin, { organizationId: ORG_ID });
    expect(radar.propostas_esperando_revisao.map((p) => p.lead_id)).toEqual(["lead-ativo"]);
  });
});
