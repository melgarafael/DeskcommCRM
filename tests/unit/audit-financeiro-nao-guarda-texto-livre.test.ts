/**
 * O AUDIT DO FINANCEIRO NÃO GUARDA TEXTO LIVRE SOBRE A PESSOA.
 *
 * ═══ Por que esta é a parte irreversível ═══
 *
 * `lib/audit` insere `metadata` CRU em `api_audit_log`. A tabela tem retenção
 * de anos, é append-only NO SCHEMA (nenhum papel tem GRANT de UPDATE/DELETE,
 * nem `service_role`) — e a cascata de anonimização da LGPD não a alcança. Ou
 * seja: `sales.notes`, `sales.reverse_reason` e `loyalty_ledger.reason` são
 * redigidos quando o titular pede anonimização, e uma CÓPIA da mesma frase
 * gravada no audit sobreviveria a ele. Não há comando que a apague depois.
 *
 * É por isso que a guarda é aqui, no ato de escrever, e não numa varredura que
 * limpe depois: depois não existe.
 *
 * ═══ O que cada caso afirma, e por que são DUAS afirmações ═══
 *
 * Cada caso afirma que a frase NÃO está no evento de audit **e** que o audit
 * FOI chamado. Só a primeira metade mediria a ausência da CHAMADA — uma rota
 * que deixasse de auditar passaria no teste com louvor, e o que se teria
 * provado é que o audit sumiu, não que ele foi sanitizado. O segundo expect é
 * o controle positivo; sem ele este arquivo é decorativo.
 *
 * ═══ O que este teste NÃO prova ═══
 *
 * Que o motivo continue guardado onde a LGPD chega (`sales.reverse_reason`,
 * `loyalty_ledger.reason`). Isso é do banco e do RPC, não da rota — aqui o
 * cliente Supabase é dublê. O que se mede é o que a rota MANDA para o audit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

interface EventoDeAudit {
  action: string;
  metadata?: Record<string, unknown>;
}

// O espião declara o ARGUMENTO que a rota passa. Sem ele, `mock.calls` é
// uma tupla vazia e `([e]) => …` não compila (TS2493) — o typecheck roda
// ANTES dos testes, então um espião sem assinatura reprova o `verify`
// inteiro sem nenhum caso chegar a rodar.
const auditSpy = vi.fn(async (_evento: EventoDeAudit) => undefined);

vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

// Só as fronteiras: sessão, cookie de org e o guarda de acompanhamento. O
// handler, o Zod e o `ok()`/`fail()` que montam a resposta são os de verdade —
// se a sanitização morasse num helper que o teste dublasse, ele não mediria nada.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "f1a1ce00-0000-4000-8000-000000000001";
const USUARIO = "f1a1ce00-0000-4000-8000-0000000000a1";
const COMANDA = "f1a1ce00-0000-4000-8000-0000000000c1";
const CONTATO = "f1a1ce00-0000-4000-8000-0000000000d1";

/**
 * As frases que NÃO podem chegar ao audit. São propositalmente do tipo que uma
 * clínica escreve de verdade: identificam a pessoa e descrevem a saúde dela.
 */
const NOTA_DA_COMANDA = "paciente Marta chorou na sala e pediu para remarcar";
const MOTIVO_DO_ESTORNO = "estornado porque a Marta passou mal durante o procedimento";
const MOTIVO_DA_FIDELIDADE = "bonus porque a Marta indicou a irmã que faz quimio";

/** Pega o evento de audit da ação pedida — e reprova se ele não existe. */
function eventoDoAudit(action: string): EventoDeAudit {
  const evento = auditSpy.mock.calls
    .map(([e]) => e)
    .find((e) => e.action === action);
  // CONTROLE POSITIVO. Sem este expect, a ausência da frase mediria a ausência
  // da chamada: rota que parasse de auditar passaria em todos os casos abaixo.
  expect(evento, `a rota não chamou audit({ action: "${action}" })`).toBeDefined();
  return evento as EventoDeAudit;
}

/** O evento INTEIRO vira texto: o vazamento pode estar fora de `metadata`. */
function naoContem(evento: EventoDeAudit, frase: string): void {
  expect(
    JSON.stringify(evento),
    `o audit de "${evento.action}" carrega texto livre sobre a pessoa — ele fica ` +
      "em `api_audit_log` para sempre, fora do alcance da anonimização da LGPD",
  ).not.toContain(frase);
}

// ---------------------------------------------------------------------------
// Dublê do PostgREST — só as chamadas que as três rotas fazem.
// ---------------------------------------------------------------------------

interface Cadeia {
  select: (colunas?: string) => Cadeia;
  insert: (linha: Record<string, unknown>) => Cadeia;
  update: (linha: Record<string, unknown>) => Cadeia;
  eq: (coluna: string, valor: unknown) => Cadeia;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  single: () => Promise<{ data: unknown; error: unknown }>;
  then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => unknown;
}

function cadeia(resposta: { data: unknown; error: unknown }): Cadeia {
  const c: Cadeia = {
    select: () => c,
    insert: () => c,
    update: () => c,
    eq: () => c,
    maybeSingle: async () => resposta,
    single: async () => resposta,
    then: (resolve) => resolve(resposta),
  };
  return c;
}

function supabaseFake(respostas: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: (tabela: string) => cadeia(respostas[tabela] ?? { data: null, error: null }),
    rpc: async (fn: string) => respostas[`rpc:${fn}`] ?? { data: null, error: null },
  };
}

function sessao(respostas: Record<string, { data: unknown; error: unknown }>) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USUARIO,
      email: "gerente@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "manager" }],
    },
    org: { orgId: ORG, name: "Org", role: "manager" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(supabaseFake(respostas) as any);
}

const ctx = { params: Promise.resolve({ id: COMANDA }) };

function req(url: string, corpo: unknown, metodo: "PATCH" | "POST") {
  return new NextRequest(url, { method: metodo, body: JSON.stringify(corpo) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/financeiro/comandas/[id] — a observação não vaza para o audit", () => {
  it("alterar `notes` audita QUE mudou, nunca O QUE foi escrito", async () => {
    sessao({ sales: { data: { id: COMANDA, status: "open", number: 42 }, error: null } });
    const { PATCH } = await import("@/app/api/v1/financeiro/comandas/[id]/route");

    const res = await PATCH(
      req(
        `http://localhost/api/v1/financeiro/comandas/${COMANDA}`,
        {
          notes: NOTA_DA_COMANDA,
          discount_cents: 500,
        },
        "PATCH",
      ),
      ctx,
    );
    expect(res.status).toBe(200);

    const evento = eventoDoAudit("comanda.alterada");
    naoContem(evento, NOTA_DA_COMANDA);
    // Os derivados: o audit continua respondendo "quem mexeu na observação da
    // comanda 42?" — que é a pergunta que ele existe para responder.
    expect(evento.metadata).toEqual({
      number: 42,
      alterou_notes: true,
      discount_cents: 500,
      cancelada: false,
    });
  });

  it("cancelar também não leva a observação junto", async () => {
    sessao({ sales: { data: { id: COMANDA, status: "open", number: 7 }, error: null } });
    const { PATCH } = await import("@/app/api/v1/financeiro/comandas/[id]/route");

    const res = await PATCH(
      req(
        `http://localhost/api/v1/financeiro/comandas/${COMANDA}`,
        {
          cancel: true,
          notes: NOTA_DA_COMANDA,
        },
        "PATCH",
      ),
      ctx,
    );
    expect(res.status).toBe(200);

    const evento = eventoDoAudit("comanda.cancelada");
    naoContem(evento, NOTA_DA_COMANDA);
    expect(evento.metadata).toMatchObject({ number: 7, alterou_notes: true, cancelada: true });
  });
});

describe("POST /api/v1/financeiro/comandas/[id]/estornar — o motivo não vaza para o audit", () => {
  it("audita que houve motivo e o tamanho dele, nunca o motivo", async () => {
    sessao({ "rpc:fn_estornar_comanda": { data: { sale_id: COMANDA }, error: null } });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/[id]/estornar/route");

    const res = await POST(
      req(
        `http://localhost/api/v1/financeiro/comandas/${COMANDA}/estornar`,
        {
          reason: MOTIVO_DO_ESTORNO,
        },
        "POST",
      ),
      ctx,
    );
    expect(res.status).toBe(200);

    const evento = eventoDoAudit("comanda.estornada");
    naoContem(evento, MOTIVO_DO_ESTORNO);
    expect(evento.metadata).toEqual({
      motivo_informado: true,
      motivo_chars: MOTIVO_DO_ESTORNO.length,
    });
  });
});

describe("POST /api/v1/financeiro/fidelidade — o motivo não vaza para o audit", () => {
  it("audita os pontos, nunca a justificativa escrita sobre a pessoa", async () => {
    sessao({
      loyalty_ledger: {
        data: {
          id: "f1a1ce00-0000-4000-8000-0000000000e1",
          points: 50,
          reason: MOTIVO_DA_FIDELIDADE,
          created_at: "2026-09-19T12:00:00.000Z",
        },
        error: null,
      },
    });
    const { POST } = await import("@/app/api/v1/financeiro/fidelidade/route");

    const res = await POST(
      req(
        "http://localhost/api/v1/financeiro/fidelidade",
        {
          contact_id: CONTATO,
          points: 50,
          reason: MOTIVO_DA_FIDELIDADE,
        },
        "POST",
      ),
    );
    expect(res.status).toBe(200);

    const evento = eventoDoAudit("fidelidade.ponto_dado");
    naoContem(evento, MOTIVO_DA_FIDELIDADE);
    expect(evento.metadata).toEqual({
      points: 50,
      motivo_informado: true,
      motivo_chars: MOTIVO_DA_FIDELIDADE.length,
    });
  });
});
