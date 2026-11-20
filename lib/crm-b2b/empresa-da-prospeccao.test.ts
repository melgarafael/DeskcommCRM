/**
 * "Transformar em empresa" (#3198, fatia 3): o contato que a prospecção criou
 * ganha a Empresa do módulo "Empresas e pessoas".
 *
 * O que estes testes fixam:
 *   1. o contato da prospecção vira Empresa com o endereço separado em colunas e
 *      o vínculo `contacts.company_id` gravado, com rastro no audit;
 *   2. contato que não veio da prospecção, anonimizado ou que JÁ tem empresa é
 *      recusado, e nada é escrito;
 *   3. vencida a poda de 365 dias (a linha do candidato some), a Empresa nasce
 *      com o que o contato guardou — sem endereço, sem inventar nada;
 *   4. o que a equipe digitou na Empresa não é sobrescrito pelo endereço do Maps;
 *   5. a Empresa que já existe para o `place_id` é reaproveitada, não duplicada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditar = vi.hoisted(() => vi.fn(async (_evento: { action: string }) => undefined));
const empresaDoCandidato = vi.hoisted(() =>
  vi.fn<(admin: unknown, org: string, negocio: Record<string, unknown>) => Promise<string | null>>(),
);
const admin = vi.hoisted(() => ({ cliente: null as unknown }));

vi.mock("@/lib/audit", () => ({ audit: auditar }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/prospecting/empresa-do-candidato", () => ({ empresaDoCandidato }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.cliente }));

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import {
  estadoDaEmpresaDaProspeccaoHandler,
  transformarContatoEmEmpresaHandler,
} from "@/lib/crm-b2b/empresa-da-prospeccao";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const EMPRESA = "33333333-3333-4333-8333-333333333333";
const ATOR = "44444444-4444-4444-8444-444444444444";
const PLACE = "ChIJ-padaria-sao-joao";

const CTX: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: ATOR, role: "agent" },
  requestId: "req-3198-f3",
  idioma: "pt-BR",
};

interface Cenario {
  contato?: Record<string, unknown> | null;
  candidato?: { data: unknown } | null;
  /** A linha de `companies` que o `place_id` já tem (a primeira busca). */
  empresaExistente?: { id: string } | null;
  /** As colunas de endereço que a Empresa já tem preenchidas. */
  enderecoAtual?: Record<string, string | null>;
  /** Linhas que o UPDATE do vínculo devolve; vazio = alguém ligou antes. */
  vinculo?: Array<{ id: string }>;
}

const CONTATO_DA_PROSPECCAO = {
  id: CONTATO,
  name: "Padaria São João",
  display_name: "Padaria São João",
  phone_number: "+5511999990000",
  source: "prospecting",
  source_metadata: { campaign_id: "c1", place_id: PLACE, maps_url: "https://maps.example/sj" },
  company_id: null,
  is_anonymized: false,
};

const DADOS_DO_CANDIDATO = {
  name: "Padaria São João",
  category: "Padaria",
  address: "R. Augusta, 1234 - Consolação, São Paulo - SP, 01304-001",
  website: "https://padariasaojoao.example",
  maps_url: "https://maps.example/sj",
  rating: 4.6,
  reviews: 120,
  emails: ["contato@padariasaojoao.example"],
  socials: [],
};

/** Banco falso: registra cada UPDATE e responde o que o cenário disse. */
function banco(c: Cenario) {
  const atualizacoes: Array<{ tabela: string; patch: unknown }> = [];
  const contato = c.contato === undefined ? CONTATO_DA_PROSPECCAO : c.contato;

  function consulta(tabela: string) {
    let colunas = "";
    let patch: unknown = null;
    const q: Record<string, unknown> = {};
    for (const m of ["eq", "is", "order", "limit"]) q[m] = () => q;
    q.select = (cols: string) => {
      colunas = cols;
      return q;
    };
    q.update = (p: unknown) => {
      patch = p;
      atualizacoes.push({ tabela, patch: p });
      return q;
    };
    const resolver = () => {
      if (tabela === "contacts") {
        if (patch) return { data: c.vinculo ?? [{ id: CONTATO }], error: null };
        return { data: contato, error: null };
      }
      if (tabela === "prospecting_candidates") return { data: c.candidato ?? null, error: null };
      if (tabela === "companies") {
        if (patch) return { data: null, error: null };
        if (colunas.includes("street")) {
          return {
            data: { street: null, number: null, complement: null, district: null, city: null, state: null, zip_code: null, ...c.enderecoAtual },
            error: null,
          };
        }
        return { data: c.empresaExistente ?? null, error: null };
      }
      return { data: null, error: null };
    };
    q.maybeSingle = async () => resolver();
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok);
    return q;
  }

  const cliente = { from: (t: string) => consulta(t) } as unknown as SupabaseClient;
  return { cliente, atualizacoes };
}

async function rodar(c: Cenario) {
  const { cliente, atualizacoes } = banco(c);
  admin.cliente = cliente;
  const resultado = await transformarContatoEmEmpresaHandler(cliente, CTX, ATOR, CONTATO);
  return { resultado, atualizacoes };
}

async function recusa(c: Cenario): Promise<ApiError> {
  try {
    await rodar(c);
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("esperava uma recusa");
}

beforeEach(() => {
  auditar.mockClear();
  empresaDoCandidato.mockReset();
  empresaDoCandidato.mockResolvedValue(EMPRESA);
});

describe("transformarContatoEmEmpresaHandler", () => {
  it("cria a Empresa com os dados do candidato, separa o endereço e liga o contato", async () => {
    const { resultado, atualizacoes } = await rodar({ candidato: { data: DADOS_DO_CANDIDATO } });

    expect(empresaDoCandidato).toHaveBeenCalledTimes(1);
    expect(empresaDoCandidato.mock.calls[0]?.[1]).toBe(ORG);
    expect(empresaDoCandidato.mock.calls[0]?.[2]).toMatchObject({
      key: PLACE,
      name: "Padaria São João",
      phone: "+5511999990000",
      website: "https://padariasaojoao.example",
      maps_url: "https://maps.example/sj",
      emails: ["contato@padariasaojoao.example"],
    });

    expect(resultado).toEqual({
      company_id: EMPRESA,
      criada: true,
      endereco_preenchido: ["street", "number", "district", "city", "state", "zip_code"],
    });
    expect(atualizacoes).toContainEqual({
      tabela: "companies",
      patch: {
        street: "R. Augusta",
        number: "1234",
        district: "Consolação",
        city: "São Paulo",
        state: "SP",
        zip_code: "01304-001",
      },
    });
    expect(atualizacoes).toContainEqual({ tabela: "contacts", patch: { company_id: EMPRESA } });

    const acoes = auditar.mock.calls.map((c) => c[0].action);
    expect(acoes).toEqual(["companies.created", "contacts.company_linked"]);
  });

  it("não grava nota, avaliações nem categoria na Empresa", async () => {
    await rodar({ candidato: { data: DADOS_DO_CANDIDATO } });
    const negocio = empresaDoCandidato.mock.calls[0]?.[2];
    expect(negocio).not.toHaveProperty("rating");
    expect(negocio).not.toHaveProperty("reviews");
    expect(negocio).not.toHaveProperty("category");
  });

  it("vencida a poda, usa o que o contato guardou e não inventa endereço", async () => {
    const { resultado, atualizacoes } = await rodar({ candidato: null });

    expect(empresaDoCandidato.mock.calls[0]?.[2]).toMatchObject({
      key: PLACE,
      name: "Padaria São João",
      phone: "+5511999990000",
      website: null,
      maps_url: "https://maps.example/sj",
      emails: [],
    });
    expect(resultado.endereco_preenchido).toEqual([]);
    expect(atualizacoes.some((a) => a.tabela === "companies")).toBe(false);
    expect(atualizacoes).toContainEqual({ tabela: "contacts", patch: { company_id: EMPRESA } });
  });

  it("não sobrescreve a coluna de endereço que a equipe já preencheu", async () => {
    const { resultado, atualizacoes } = await rodar({
      candidato: { data: DADOS_DO_CANDIDATO },
      enderecoAtual: { street: "Rua Digitada à Mão", city: "São Paulo" },
    });
    expect(resultado.endereco_preenchido).toEqual(["number", "district", "state", "zip_code"]);
    const patch = atualizacoes.find((a) => a.tabela === "companies")?.patch as Record<string, string>;
    expect(patch).not.toHaveProperty("street");
    expect(patch).not.toHaveProperty("city");
  });

  it("reaproveita a Empresa que já existe para o place_id e não repete o audit de criação", async () => {
    const { resultado } = await rodar({
      candidato: { data: DADOS_DO_CANDIDATO },
      empresaExistente: { id: EMPRESA },
    });
    expect(resultado.criada).toBe(false);
    const acoes = auditar.mock.calls.map((c) => c[0].action);
    expect(acoes).toEqual(["contacts.company_linked"]);
  });

  it("recusa o contato que não veio da prospecção, sem escrever nada", async () => {
    const e = await recusa({ contato: { ...CONTATO_DA_PROSPECCAO, source: "manual" } });
    expect(e.status).toBe(422);
    expect(empresaDoCandidato).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("recusa o contato da prospecção sem place_id", async () => {
    const e = await recusa({ contato: { ...CONTATO_DA_PROSPECCAO, source_metadata: { campaign_id: "c1" } } });
    expect(e.status).toBe(422);
    expect(empresaDoCandidato).not.toHaveBeenCalled();
  });

  it("recusa o contato anonimizado", async () => {
    const e = await recusa({ contato: { ...CONTATO_DA_PROSPECCAO, is_anonymized: true } });
    expect(e.status).toBe(422);
    expect(empresaDoCandidato).not.toHaveBeenCalled();
  });

  it("recusa o contato que já tem empresa (409) e não cria outra", async () => {
    const e = await recusa({ contato: { ...CONTATO_DA_PROSPECCAO, company_id: EMPRESA } });
    expect(e.status).toBe(409);
    expect(empresaDoCandidato).not.toHaveBeenCalled();
  });

  it("responde 404 quando o contato não é desta organização", async () => {
    const e = await recusa({ contato: null });
    expect(e.status).toBe(404);
    expect(empresaDoCandidato).not.toHaveBeenCalled();
  });

  it("falha com erro quando a Empresa não pôde ser criada, sem ligar o contato", async () => {
    empresaDoCandidato.mockResolvedValue(null);
    const e = await recusa({ candidato: { data: DADOS_DO_CANDIDATO } });
    expect(e.status).toBe(500);
    expect(auditar).not.toHaveBeenCalled();
  });

  it("dois cliques juntos: quem perde a corrida recebe 409 se outra Empresa ganhou", async () => {
    // O UPDATE não ligou nada (outra chamada ligou antes) e o contato já aponta para OUTRA empresa.
    const e = await recusa({
      candidato: { data: DADOS_DO_CANDIDATO },
      vinculo: [],
      contato: CONTATO_DA_PROSPECCAO,
    });
    // A releitura devolve o contato ainda sem empresa → conflito.
    expect(e.status).toBe(409);
  });
});

describe("estadoDaEmpresaDaProspeccaoHandler", () => {
  it("contato da prospecção sem empresa é elegível ao botão", async () => {
    const { cliente } = banco({});
    const estado = await estadoDaEmpresaDaProspeccaoHandler(cliente, CTX, CONTATO);
    expect(estado).toEqual({ elegivel: true, empresa: null });
  });

  it("contato que não veio da prospecção não é elegível", async () => {
    const { cliente } = banco({ contato: { ...CONTATO_DA_PROSPECCAO, source: "whatsapp" } });
    const estado = await estadoDaEmpresaDaProspeccaoHandler(cliente, CTX, CONTATO);
    expect(estado.elegivel).toBe(false);
  });

  it("mostra a Empresa de qualquer contato ligado, mesmo o que não veio da prospecção", async () => {
    const { cliente } = banco({
      contato: { ...CONTATO_DA_PROSPECCAO, source: "whatsapp", company_id: EMPRESA },
      empresaExistente: { id: EMPRESA, trade_name: "Padaria São João", legal_name: null } as { id: string },
    });
    const estado = await estadoDaEmpresaDaProspeccaoHandler(cliente, CTX, CONTATO);
    expect(estado.elegivel).toBe(false);
    expect(estado.empresa).toEqual({ id: EMPRESA, nome: "Padaria São João" });
  });

  it("contato anonimizado não é elegível", async () => {
    const { cliente } = banco({ contato: { ...CONTATO_DA_PROSPECCAO, is_anonymized: true } });
    const estado = await estadoDaEmpresaDaProspeccaoHandler(cliente, CTX, CONTATO);
    expect(estado.elegivel).toBe(false);
  });
});
