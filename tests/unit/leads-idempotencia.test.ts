// @vitest-environment node
/**
 * POST /api/v1/leads — A MESMA Idempotency-Key NÃO CRIA DOIS LEADS (issue #5338).
 *
 * ─── A régua que este teste protege ──────────────────────────────────────────
 *
 * O `apiClient` carimba `Idempotency-Key` em todo POST (`lib/api/client.ts`),
 * então um duplo clique ou uma retentativa de rede chegam com a MESMA chave. A
 * rota não lia o cabeçalho e o INSERT era incondicional: dois cartões para o
 * mesmo contato no mesmo funil, e o efeito em produção era exatamente esse.
 *
 * O que se prova aqui é a CONTAGEM de criações, não a igualdade das respostas:
 * devolver o recibo E criar de novo passaria na igualdade. `comIdempotencia`
 * roda de VERDADE sobre um banco falso de `idempotency_keys` (com o índice
 * único que decide a corrida); só o `createLeadHandler` é dublado — o INSERT
 * dele tem testes próprios.
 *
 * Os dois caminhos estão aqui porque consertar um não pode quebrar o outro:
 * com chave, repetição devolve o MESMO lead; sem chave, o comportamento de
 * sempre continua (duas chamadas, dois leads).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// O aviso do #1751 consulta `crm_leads` antes do insert; aqui ele não é o
// objeto (tem teste próprio em `app/api/v1/leads/route.test.ts`), e devolver
// nulo mantém o banco falso com UMA tabela — a que decide este caso.
vi.mock("@/lib/leads/negocio-aberto-duplicado", () => ({
  AVISO_NEGOCIO_ABERTO_EXISTENTE: "negocio_aberto_existente",
  negocioAbertoExistente: vi.fn(async () => null),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { POST } from "@/app/api/v1/leads/route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CHAVE = "aaaaaaa1-1111-4111-8111-111111111111";

type Linha = Record<string, unknown>;

/**
 * `public.idempotency_keys` em memória, com as cadeias EXATAS que
 * `comIdempotencia` encadeia e o índice único
 * (`organization_id`, `key`, `endpoint`) devolvendo 23505 — é ele que decide
 * quem executa o efeito numa corrida.
 */
function bancoFalso() {
  const linhas: Linha[] = [];
  const from = (tabela: string) => {
    if (tabela !== "idempotency_keys") throw new Error(`tabela inesperada: ${tabela}`);
    const eq: Array<[string, unknown]> = [];
    let gt: [string, unknown] | null = null;
    let patch: Linha | null = null;
    let inserindo: Linha | null = null;
    let erroDoInsert: { code: string } | null = null;
    const casa = (l: Linha) =>
      eq.every(([c, v]) => l[c] === v) && (gt ? String(l[gt[0]]) > String(gt[1]) : true);
    const aplicar = () => {
      if (patch) for (const l of linhas.filter(casa)) Object.assign(l, patch);
      patch = null;
      if (inserindo) {
        const repetida = linhas.some(
          (l) =>
            l.organization_id === inserindo!.organization_id &&
            l.key === inserindo!.key &&
            l.endpoint === inserindo!.endpoint,
        );
        if (repetida) erroDoInsert = { code: "23505" };
        else linhas.push({ id: `linha-${linhas.length + 1}`, ...inserindo });
        inserindo = null;
      }
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => (eq.push([c, v]), b);
    b.gt = (c: string, v: unknown) => ((gt = [c, v]), b);
    b.insert = (l: Linha) => ((inserindo = l), b);
    b.update = (p: Linha) => ((patch = p), b);
    b.maybeSingle = async () => (aplicar(), { data: linhas.find(casa) ?? null, error: null });
    b.single = async () => {
      aplicar();
      const l = linhas.find(casa);
      return { data: l ?? null, error: l ? null : { message: "no rows" } };
    };
    b.then = (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
      aplicar();
      return Promise.resolve({ data: null, error: erroDoInsert }).then(comOk, comErro);
    };
    return b;
  };
  return { from, linhas };
}

function pedido(chave: string | null, corpo = criarBody()): NextRequest {
  return new NextRequest("http://localhost/api/v1/leads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(chave ? { "Idempotency-Key": chave } : {}),
    },
    body: JSON.stringify(corpo),
  });
}

function criarBody(sobrescreve: Record<string, unknown> = {}) {
  return {
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    title: "Novo lead — Michelle",
    contact_id: CONTATO,
    source: "manual",
    ...sobrescreve,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
  vi.mocked(createClient).mockResolvedValue(bancoFalso() as never);
  // Cada chamada do efeito cria um lead NOVO: é a contagem dele que denuncia a
  // duplicata — asserção de igualdade de resposta não denunciaria.
  let n = 0;
  vi.mocked(createLeadHandler).mockImplementation((async () => ({
    id: `lead-${++n}`,
    title: "Novo lead — Michelle",
  })) as never);
});

describe("POST /api/v1/leads — idempotência do cabeçalho (issue #5338)", () => {
  it("mesma chave, duas chamadas em sequência: UM lead, e a MESMA resposta", async () => {
    const primeira = await POST(pedido(CHAVE));
    const segunda = await POST(pedido(CHAVE));

    const corpoPrimeira = await primeira.json();
    const corpoSegunda = await segunda.json();

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    // A criação aconteceu UMA vez — o reenvio não criou o segundo cartão.
    expect(createLeadHandler).toHaveBeenCalledTimes(1);
    expect(corpoSegunda).toEqual(corpoPrimeira);
    expect(corpoSegunda.data.id).toBe("lead-1");
  });

  it("mesma chave, duas chamadas em paralelo: o efeito acontece UMA vez", async () => {
    const [a, b] = await Promise.all([POST(pedido(CHAVE)), POST(pedido(CHAVE))]);

    // Quem perde a corrida não executa: ou lê o recibo (201, mesmo id), ou
    // chega na reserva em curso (409 `idempotency_in_progress`, que retenta).
    expect(createLeadHandler).toHaveBeenCalledTimes(1);
    const ids = new Set<string>();
    for (const res of [a, b]) {
      if (res.status === 201) ids.add((await res.json()).data.id);
      else expect((await res.json()).error.code).toBe("idempotency_in_progress");
    }
    expect([...ids]).toEqual(["lead-1"]);
  });

  it("sem chave: o caminho de sempre — duas chamadas, dois leads", async () => {
    const primeira = await POST(pedido(null));
    const segunda = await POST(pedido(null));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(createLeadHandler).toHaveBeenCalledTimes(2);
    expect((await primeira.json()).data.id).not.toBe((await segunda.json()).data.id);
  });

  it("mesma chave com corpo diferente: 409 idempotency_conflict, sem criar de novo", async () => {
    await POST(pedido(CHAVE));
    const segunda = await POST(pedido(CHAVE, criarBody({ title: "Outro título" })));

    expect(segunda.status).toBe(409);
    expect((await segunda.json()).error.code).toBe("idempotency_conflict");
    expect(createLeadHandler).toHaveBeenCalledTimes(1);
  });

  it("chave que não é UUID: 400 e nada é criado", async () => {
    const res = await POST(pedido("nao-e-uuid"));

    expect(res.status).toBe(400);
    expect(createLeadHandler).not.toHaveBeenCalled();
  });
});
