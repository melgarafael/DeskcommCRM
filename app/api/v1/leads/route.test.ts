// @vitest-environment node
/**
 * AVISO DE NEGÓCIO ABERTO DUPLICADO NA CRIAÇÃO (issue #1751) — AVISA E NÃO BLOQUEIA.
 *
 * ─── A régua que este teste protege ──────────────────────────────────────────
 *
 * A migration 0256 decidiu que um cliente PODE ter dois negócios abertos: "a
 * regra 'um aberto por contato' é do INGEST, não do CRM — e prendê-la no schema
 * a imporia a todos os caminhos". Por isso o POST /api/v1/leads NÃO recusa o
 * segundo negócio. O que ele faz é devolver na resposta
 * `meta.avisos: ["negocio_aberto_existente"]`, para quem criou poder mostrar o
 * aviso na tela com link para o que já existe.
 *
 * Duplicidade é uma tríade, e não um par: MESMO contato, MESMO funil e negócio
 * ABERTO. Os três casos abaixo separam as três arestas — tirar qualquer filtro
 * da consulta reprova um deles.
 *
 * O que NÃO está aqui: fusão de negócios (item 2 da proposta) exige a coluna
 * `crm_leads.is_merged_into`, que não existe — migration nova, fora da fatia.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// A criação em si é mockada: o que se prova aqui é o AVISO da resposta, não o
// INSERT — e sem este mock o teste precisaria de um dublê para sete tabelas.
vi.mock("./_handler", () => ({
  createLeadHandler: vi.fn(async () => ({ id: "lead-novo-0000" })),
}));

import { createLeadHandler } from "./_handler";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const USER = "11111111-1111-4111-8111-111111111111";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUNIL_OUTRO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTATO = "22222222-2222-4222-8222-222222222222";

type Negocio = {
  id: string;
  title: string;
  organization_id: string;
  contact_id: string;
  pipeline_id: string;
  status: string;
};

function negocio(sobrescreve: Partial<Negocio> = {}): Negocio {
  return {
    id: "lead-ja-aberto",
    title: "Michelle — contrato antigo",
    organization_id: ORG,
    contact_id: CONTATO,
    pipeline_id: FUNIL,
    status: "open",
    ...sobrescreve,
  };
}

/**
 * Supabase de mentira que APENAS aplica os `.eq()` recebidos, como o
 * PostgREST: a linha volta só se casar com todos os filtros. É isto que faz do
 * teste um guard — apagar `.eq("pipeline_id", …)` do código muda o resultado da
 * consulta, e não só a leitura do código.
 */
function supabaseCom(negocios: Negocio[]) {
  const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];

  const cliente = {
    from(tabela: string) {
      const meus: Array<{ coluna: string; valor: unknown }> = [];
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          meus.push({ coluna, valor });
          filtros.push({ tabela, coluna, valor });
          return q;
        },
        limit: () => q,
        maybeSingle: async () => {
          const achado =
            negocios.find((n) =>
              meus.every((f) => (n as unknown as Record<string, unknown>)[f.coluna] === f.valor),
            ) ?? null;
          return { data: achado, error: null };
        },
      };
      return q;
    },
  };

  return { cliente: cliente as never, filtros };
}

function authOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
}

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/leads", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function criarBody(sobrescreve: Record<string, unknown> = {}) {
  return {
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    title: "Segundo negócio da Michelle",
    contact_id: CONTATO,
    source: "manual",
    ...sobrescreve,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authOk();
});

describe("POST /api/v1/leads — aviso de negócio aberto duplicado", () => {
  it("mesmo contato E mesmo funil abertos → cria E devolve meta.avisos", async () => {
    const { cliente, filtros } = supabaseCom([negocio()]);
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await POST(req(criarBody()));
    const body = await res.json();

    // Criou mesmo assim — a 0256 proíbe o bloqueio.
    expect(res.status).toBe(201);
    expect(createLeadHandler).toHaveBeenCalledTimes(1);
    expect(body.data).toMatchObject({ id: "lead-novo-0000" });

    // E avisou, com o negócio que já existe à mão (é ele que a tela linka).
    expect(body.meta.avisos).toEqual(["negocio_aberto_existente"]);
    expect(body.meta.negocio_aberto_existente).toMatchObject({
      id: "lead-ja-aberto",
      title: "Michelle — contrato antigo",
    });

    // A consulta é desta organização: sem o filtro, o aviso viria de dados de
    // outra empresa.
    expect(filtros).toContainEqual({ tabela: "crm_leads", coluna: "organization_id", valor: ORG });
  });

  it("mesmo contato ABERTO em OUTRO funil → cria SEM aviso", async () => {
    const { cliente } = supabaseCom([negocio({ pipeline_id: FUNIL_OUTRO })]);
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await POST(req(criarBody()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(createLeadHandler).toHaveBeenCalledTimes(1);
    // Sem `meta.avisos` nenhum — não existe `meta` nesta resposta.
    expect(body.meta?.avisos).toBeUndefined();
  });

  it("mesmo contato E mesmo funil, mas ENCERRADO → cria sem aviso", async () => {
    // Encerrado não é duplicidade: perder e tentar de novo é o fluxo normal
    // (issue #1538), e avisar ali ensinaria o operador a ignorar o aviso.
    const { cliente } = supabaseCom([negocio({ status: "lost" })]);
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await POST(req(criarBody()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.meta?.avisos).toBeUndefined();
  });

  it("negócio SEM contato → cria sem aviso (não há quem duplicar)", async () => {
    const { cliente, filtros } = supabaseCom([negocio()]);
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await POST(req(criarBody({ contact_id: undefined })));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.meta?.avisos).toBeUndefined();
    // Sem contato nem a consulta roda: nada que perguntar ao banco.
    expect(filtros).toEqual([]);
  });

  it("contato de OUTRA organização → o aviso nunca cruza tenant", async () => {
    // A linha de outro tenant só casaria se `organization_id` não filtrasse.
    const { cliente } = supabaseCom([negocio({ organization_id: OUTRA_ORG })]);
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await POST(req(criarBody()));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.meta?.avisos).toBeUndefined();
  });
});
