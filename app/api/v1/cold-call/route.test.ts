import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

/**
 * GET /api/v1/cold-call — a fila (#3933).
 *
 * Três coisas que a tela não mostra como erro, e por isso moram aqui:
 * - o módulo desligado (o padrão) responde 404, mas só DEPOIS de autorizar;
 * - a fila grande: o `.in()` com os ids viaja na URL, e o Kong recusa a partir de ~187 ids
 *   (`app/api/v1/conversations/_handler.ts`). A rota dividia em UMA consulta e descartava o
 *   `error`, então acima de ~200 leads a fila vinha sem nome nem telefone, sem aviso;
 * - quem pediu para não ser incomodado chega marcado, para a tela não oferecer a ligação.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
/** O muro medido do Kong 2.8.1: a partir daqui a URL passa de 8.192 B e volta 414. */
const MURO_DO_KONG = 187;

type Linha = Record<string, unknown>;
type Resposta = { data: Linha[] | null; error: { message: string } | null };

/** Um PostgREST de mentira que filtra de verdade e recusa `.in()` grande como o Kong. */
function bancoFalso(tabelas: Record<string, Linha[]>, falhaEm?: string) {
  const tamanhosDoIn: Record<string, number[]> = {};
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    let recusada = falhaEm === tabela;
    const consulta = {
      select: () => consulta,
      order: () => consulta,
      limit: () => consulta,
      eq: (coluna: string, valor: unknown) => {
        linhas = linhas.filter((l) => l[coluna] === valor);
        return consulta;
      },
      in: (coluna: string, valores: readonly unknown[]) => {
        (tamanhosDoIn[tabela] ??= []).push(valores.length);
        if (valores.length >= MURO_DO_KONG) recusada = true;
        linhas = linhas.filter((l) => valores.includes(l[coluna]));
        return consulta;
      },
      then: <R>(resolver: (r: Resposta) => R) =>
        Promise.resolve(
          recusada ? { data: null, error: { message: "414 Request-URI Too Large" } } : { data: linhas, error: null },
        ).then(resolver),
    };
    return consulta;
  };
  return { from, tamanhosDoIn };
}

const uuid = (prefixo: number, i: number) =>
  `${String(prefixo).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;

function fila(quantos: number, contato: (i: number) => Linha = () => ({})) {
  const leads = Array.from({ length: quantos }, (_, i) => ({
    id: uuid(1, i),
    organization_id: ORG,
    pipeline_id: "funil",
    status: "open",
    title: `Lead ${i}`,
    description: null,
    tags: [],
    stage_id: "etapa-fila",
    contact_id: uuid(2, i),
    owner_user_id: null,
    created_at: "2026-11-01T00:00:00Z",
  }));
  const contacts = leads.map((l, i) => ({
    id: l.contact_id,
    organization_id: ORG,
    // "Contato 12" é o rótulo técnico que `nomeDoContato` descarta; nome de gente de verdade.
    name: `Pessoa ${i}`,
    display_name: null,
    phone_number: `+55119${String(i).padStart(8, "0")}`,
    is_anonymized: false,
    is_blocked: false,
    is_personal: false,
    ...contato(i),
  }));
  return {
    crm_pipelines: [
      { id: "funil", organization_id: ORG, is_archived: false, name: "Cold Call", settings: { cold_call: { ativo: true, roteiro: "" } } },
    ],
    crm_stages: [{ id: "etapa-fila", organization_id: ORG, pipeline_id: "funil", slug: "na-fila", name: "Na fila" }],
    crm_leads: leads,
    contacts,
    crm_lead_activities: [
      { organization_id: ORG, type: "cold_call_result", lead_id: leads[quantos - 1]!.id, performed_at: "2026-11-02T10:00:00Z", payload: { resultado: "nao_atendeu" } },
    ],
    conversations: [],
  };
}

async function lerFila() {
  const resposta = await GET();
  return { status: resposta.status, corpo: (await resposta.json()) as { data?: { leads: Linha[] }; error?: { code: string } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u", idioma: "pt-BR" } } as never);
});

describe("o módulo desligado", () => {
  it("responde 404, e o funil nem é lido", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    const banco = bancoFalso(fila(3));
    vi.mocked(createClient).mockResolvedValue(banco as never);
    const { status, corpo } = await lerFila();
    expect(status).toBe(404);
    expect(corpo.error?.code).toBe("not_found");
    expect(vi.mocked(moduloLigado).mock.calls[0]![1]).toBe("cold_call");
  });

  it("quem não está autorizado recebe a recusa do auth, antes de saber do módulo", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) } as never);
    const { status } = await lerFila();
    expect(status).toBe(401);
    expect(moduloLigado).not.toHaveBeenCalled();
  });
});

describe("fila com mais de 200 leads", () => {
  it("todo lead chega com nome, telefone e histórico, e nenhum `.in()` passa do muro do Kong", async () => {
    const banco = bancoFalso(fila(250));
    vi.mocked(createClient).mockResolvedValue(banco as never);
    const { status, corpo } = await lerFila();
    expect(status).toBe(200);
    const leads = corpo.data!.leads;
    expect(leads).toHaveLength(250);
    expect(leads.every((l) => typeof l.contato_nome === "string" && typeof l.telefone === "string")).toBe(true);
    expect(leads[249]!.tentativas).toBe(1);
    // Controle: a sonda enxergou os lotes, e todos ficaram abaixo do muro.
    const tamanhos = Object.values(banco.tamanhosDoIn).flat();
    expect(tamanhos.length).toBeGreaterThan(3);
    expect(Math.max(...tamanhos)).toBeLessThan(MURO_DO_KONG);
  });

  it("erro de uma consulta derruba a fila com 500, em vez de devolver lead sem nome", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso(fila(5), "contacts") as never);
    const { status, corpo } = await lerFila();
    expect(status).toBe(500);
    expect(corpo.error?.code).toBe("internal_error");
  });
});

describe("quem não recebe ligação chega marcado", () => {
  it("bloqueado, pessoal e anonimizado têm motivo; o resto, nenhum", async () => {
    const estados: Linha[] = [{ is_blocked: true }, { is_personal: true }, { is_anonymized: true }, {}];
    vi.mocked(createClient).mockResolvedValue(bancoFalso(fila(4, (i) => estados[i]!)) as never);
    const { corpo } = await lerFila();
    expect(corpo.data!.leads.map((l) => l.nao_ligar)).toEqual(["bloqueado", "pessoal", "anonimizado", null]);
  });

  it("e chega sem telefone, e-mail, endereço nem conversa; o lead comum chega com tudo", async () => {
    const estados: Linha[] = [{ is_blocked: true }, { is_personal: true }, { is_anonymized: true }, {}];
    const base = fila(4, (i) => ({
      email: `pessoa${i}@exemplo.com`,
      street: "Rua A",
      number: "10",
      district: "Centro",
      city: "Recife",
      state: "PE",
      ...estados[i],
    }));
    const tabelas = {
      ...base,
      conversations: base.contacts.map((c, i) => ({
        id: `conversa-${i}`,
        organization_id: ORG,
        contact_id: c.id,
        last_message_at: "2026-11-02T09:00:00Z",
      })),
    };
    vi.mocked(createClient).mockResolvedValue(bancoFalso(tabelas) as never);
    const { corpo } = await lerFila();
    const leads = corpo.data!.leads;
    const contato = (l: Linha) => ({ telefone: l.telefone, email: l.email, endereco: l.endereco, conversa_id: l.conversa_id });

    for (const l of leads.slice(0, 3)) {
      expect(contato(l)).toEqual({ telefone: null, email: null, endereco: null, conversa_id: null });
      // O nome e o motivo ficam: é o que a tela mostra em "Não ligar · motivo".
      expect(l.titulo).toBeTruthy();
      expect(l.nao_ligar).not.toBeNull();
    }
    expect(contato(leads[3]!)).toEqual({
      telefone: "+5511900000003",
      email: "pessoa3@exemplo.com",
      endereco: "Rua A, 10 - Centro - Recife - PE",
      conversa_id: "conversa-3",
    });
  });
});
