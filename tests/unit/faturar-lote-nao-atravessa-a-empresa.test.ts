/**
 * FATURAR EM LOTE NÃO ATRAVESSA A FRONTEIRA DA EMPRESA (#4845).
 *
 * ## O defeito que este arquivo prende
 *
 * A rota lia `calendar_appointments` por `.in("id", appointment_ids)` — sem
 * empresa. A RLS daquela tabela libera TODAS as empresas de que a pessoa é
 * membro (`organization_id in fn_user_org_ids()`) e, para o admin da
 * plataforma, todas. O id de um atendimento da empresa B voltava, e daí em
 * diante tudo era gravado com `org = authz.org.orgId` (a empresa ATIVA): a
 * comanda (`sales.insert`), o item (`sale_items.insert`, com o preço do
 * catálogo e o dono do atendimento alheio) e o
 * `rpc("fn_finalizar_comanda", { p_org: org })`, que gera `commissions` e um
 * `financial_entries` PAGO no caixa da A. Dinheiro nascia na empresa errada,
 * e o atendimento da B continuava pendente lá.
 *
 * ## O que se mede aqui, e por que no dublê
 *
 * Três coisas, e nenhuma delas é a resposta HTTP sozinha:
 *
 *   1. a LEITURA pede a empresa — o dublê guarda os filtros aplicados na
 *      consulta (sabotagem: apagar o `.eq("organization_id", org)` deixa de
 *      filtrar, o id de fora volta, e o caso de recusa reprova com 200);
 *   2. a recusa não ESCREVE NADA — `sales`, `sale_items` e as RPCs ficam
 *      vazios, e as contagens de `commissions`/`financial_entries` do dublê
 *      continuam zero (é o que prova a atomicidade: a rota decide antes de
 *      abrir a primeira comanda);
 *   3. a recusa não REVELA o atendimento alheio — nem título, nem preço, nem
 *      o id, nem de qual empresa é. Um id que não existe em empresa nenhuma
 *      recebe a MESMA resposta de um id de outra empresa, então a rota também
 *      não serve de sonda para descobrir o que existe no vizinho.
 *
 * O caminho feliz fica junto, no mesmo arquivo: o filtro por empresa não pode
 * ter custado o faturamento de quem está na empresa certa.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => true),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ORG_DE_FORA = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const CONTATO_DE_FORA = "55555555-5555-4555-8555-999999999999";
const SERVICO = "77777777-7777-4777-8777-777777777777";
const PAYMENT = "66666666-6666-4666-8666-666666666666";
const APPOINTMENT = "44444444-4444-4444-8444-444444444444";
const APPOINTMENT_2 = "44444444-4444-4444-8444-555555555555";
const APPOINTMENT_DE_FORA = "44444444-4444-4444-8444-999999999999";
const INEXISTENTE = "44444444-4444-4444-8444-000000000000";
const TITULO_DE_FORA = "Massagem relaxante da outra empresa";
const PRECO_DE_FORA = 123456;

type Agendamento = {
  id: string;
  organization_id: string;
  title: string;
  contact_id: string | null;
  contact_organization_id?: string | null;
  event_type_id: string | null;
  owner_user_id: string | null;
  status: string;
  calendar_event_types: { name: string; default_price_cents: number | null } | null;
};

const agendamento = (over: Partial<Agendamento> & { id: string }): Agendamento => ({
  organization_id: ORG,
  title: "Corte",
  contact_id: CONTATO,
  event_type_id: SERVICO,
  owner_user_id: USER,
  status: "completed",
  calendar_event_types: { name: "Corte", default_price_cents: 5000 },
  ...over,
});

/**
 * O que a rota escreveu e o que ela pediu ao banco.
 *
 * `filtros` é o instrumento da LEITURA (é ele que denuncia a consulta sem
 * empresa) e `insercoes`/`rpcs` são o da ESCRITA (é o que prova a recusa sem
 * efeito).
 */
let mundo: {
  agendamentos: Agendamento[];
  contatos: Array<{ id: string; organization_id: string }>;
};
let filtros: Record<string, Array<[string, unknown]>>;
let insercoes: Record<string, Array<Record<string, unknown>>>;
let rpcs: string[];

function montarMundo(opts: {
  agendamentos: Agendamento[];
  contatos?: Array<{ id: string; organization_id: string }>;
}) {
  mundo = {
    agendamentos: opts.agendamentos,
    contatos: opts.contatos ?? [
      { id: CONTATO, organization_id: ORG },
      { id: CONTATO_DE_FORA, organization_id: ORG_DE_FORA },
    ],
  };
  filtros = {};
  insercoes = {};
  rpcs = [];

  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: ORG, name: "Org", role: "agent" },
      }) as never,
  );

  /** Aplica os filtros registrados, como o PostgREST faria. */
  const aplicar = (linhas: Array<Record<string, unknown>>, tabela: string) => {
    const postos = filtros[tabela] ?? [];
    return linhas.filter((linha) =>
      postos.every(([campo, valor]) =>
        Array.isArray(valor)
          ? (valor as unknown[]).includes(linha[campo])
          : linha[campo] === valor,
      ),
    );
  };

  const from = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};
    /** Anota o filtro APLICADO — é este registro que denuncia a leitura sem empresa. */
    const anotar = (campo: string, valor: unknown) => {
      (filtros[tabela] ??= []).push([campo, valor]);
      return cadeia;
    };

    cadeia.select = () => cadeia;
    cadeia.order = () => cadeia;
    cadeia.limit = () => cadeia;
    cadeia.neq = () => cadeia;
    cadeia.eq = (campo: string, valor: unknown) => anotar(campo, valor);
    cadeia.in = (campo: string, valor: unknown) => anotar(campo, valor);

    cadeia.insert = (linha: Record<string, unknown>) => {
      (insercoes[tabela] ??= []).push(linha);
      const inserido = {
        id: `${tabela}-${insercoes[tabela]!.length}`,
        number: 7,
        status: "open",
      };
      const elo: Record<string, unknown> = {
        select: () => elo,
        single: async () => ({ data: inserido, error: null }),
        maybeSingle: async () => ({ data: inserido, error: null }),
      };
      elo.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve({ data: inserido, error: null }).then(ok, ko);
      return elo;
    };
    cadeia.maybeSingle = async () =>
      tabela === "organizations"
        ? { data: { currency: "BRL" }, error: null }
        : { data: null, error: null };
    cadeia.single = async () => ({ data: null, error: null });
    cadeia.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
      const linhas: Array<Record<string, unknown>> =
        tabela === "calendar_appointments"
          ? (mundo.agendamentos as unknown as Array<Record<string, unknown>>)
          : tabela === "contacts"
            ? (mundo.contatos as unknown as Array<Record<string, unknown>>)
            : [];
      return Promise.resolve({ data: aplicar(linhas, tabela), error: null }).then(ok, ko);
    };
    return cadeia;
  };

  const rpc = async (fn: string) => {
    rpcs.push(fn);
    return fn === "fn_finalizar_comanda" ? { data: null, error: null } : { data: 7, error: null };
  };

  vi.mocked(createClient).mockResolvedValue({ from, rpc } as never);
}

/** Os filtros que a rota aplicou na leitura de agendamentos. */
function filtrosDosAgendamentos(): Array<[string, unknown]> {
  return filtros["calendar_appointments"] ?? [];
}

const pedido = (corpo: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/v1/financeiro/comandas/faturar-lote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });

const lote = (...ids: string[]) => ({ appointment_ids: ids, payment_method_id: PAYMENT });

const corpo = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/financeiro/comandas/faturar-lote — #4845", () => {
  it("lê os agendamentos SEMPRE com a empresa ativa", async () => {
    montarMundo({ agendamentos: [agendamento({ id: APPOINTMENT })] });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(lote(APPOINTMENT)));

    expect(res.status).toBe(200);
    expect(filtrosDosAgendamentos()).toContainEqual(["organization_id", ORG]);
  });

  it("um agendamento de outra empresa recusa o LOTE INTEIRO, sem gravar nada", async () => {
    montarMundo({
      agendamentos: [
        agendamento({ id: APPOINTMENT }),
        agendamento({
          id: APPOINTMENT_DE_FORA,
          organization_id: ORG_DE_FORA,
          contact_id: CONTATO_DE_FORA,
          title: TITULO_DE_FORA,
          calendar_event_types: { name: TITULO_DE_FORA, default_price_cents: PRECO_DE_FORA },
        }),
      ],
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    // O da empresa ativa vem PRIMEIRO de propósito: é a ordem que um laço
    // desatento usaria para já ter faturado o primeiro quando encontrasse o
    // segundo. A recusa tem de vir antes de qualquer escrita.
    const res = await POST(pedido(lote(APPOINTMENT, APPOINTMENT_DE_FORA)));
    const json = await corpo(res);

    expect(res.status).toBe(422);
    expect((json.error as Record<string, unknown>).code).toBe(
      "financeiro_agendamento_fora_da_empresa",
    );
    expect((json.error as Record<string, unknown>).message).toContain("1 atendimento");
    expect((json.error as Record<string, unknown>).details).toEqual({ fora_da_empresa: 1 });

    expect(insercoes["sales"] ?? []).toEqual([]);
    expect(insercoes["sale_items"] ?? []).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("a recusa não revela nada do atendimento de fora — nem nome, nem preço, nem empresa", async () => {
    montarMundo({
      agendamentos: [
        agendamento({
          id: APPOINTMENT_DE_FORA,
          organization_id: ORG_DE_FORA,
          contact_id: CONTATO_DE_FORA,
          title: TITULO_DE_FORA,
          calendar_event_types: { name: TITULO_DE_FORA, default_price_cents: PRECO_DE_FORA },
        }),
      ],
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(lote(APPOINTMENT_DE_FORA)));
    const texto = JSON.stringify(await corpo(res));

    expect(res.status).toBe(422);
    expect(texto).not.toContain(TITULO_DE_FORA);
    expect(texto).not.toContain(String(PRECO_DE_FORA));
    expect(texto).not.toContain(ORG_DE_FORA);
    expect(texto).not.toContain(CONTATO_DE_FORA);
    expect(texto).not.toContain(APPOINTMENT_DE_FORA);
    // A contagem fica; o id não.
    expect(texto).toContain('"fora_da_empresa":1');
  });

  it("id que não existe em empresa nenhuma recebe a MESMA resposta do id de fora (não é sonda)", async () => {
    montarMundo({ agendamentos: [] });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(lote(INEXISTENTE)));
    const json = await corpo(res);

    expect(res.status).toBe(422);
    expect((json.error as Record<string, unknown>).code).toBe(
      "financeiro_agendamento_fora_da_empresa",
    );
    expect((json.error as Record<string, unknown>).details).toEqual({ fora_da_empresa: 1 });
  });

  it("agendamento da empresa com CONTATO de outra empresa também recusa o lote, sem gravar", async () => {
    montarMundo({
      agendamentos: [
        agendamento({ id: APPOINTMENT }),
        agendamento({ id: APPOINTMENT_2, contact_id: CONTATO_DE_FORA }),
      ],
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(lote(APPOINTMENT, APPOINTMENT_2)));
    const json = await corpo(res);

    expect(res.status).toBe(422);
    expect((json.error as Record<string, unknown>).code).toBe(
      "financeiro_contato_fora_da_empresa",
    );
    expect((json.error as Record<string, unknown>).details).toEqual({ fora_da_empresa: 1 });

    expect(insercoes["sales"] ?? []).toEqual([]);
    expect(insercoes["sale_items"] ?? []).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("caminho feliz: dois atendimentos da empresa ativa são faturados", async () => {
    montarMundo({
      agendamentos: [agendamento({ id: APPOINTMENT }), agendamento({ id: APPOINTMENT_2 })],
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(lote(APPOINTMENT, APPOINTMENT_2)));
    const json = await corpo(res);

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ faturados: 2, numeros: [7, 7] });

    const vendas = insercoes["sales"] ?? [];
    const itens = insercoes["sale_items"] ?? [];
    expect(vendas).toHaveLength(2);
    expect(itens).toHaveLength(2);
    for (const venda of vendas) expect(venda.organization_id).toBe(ORG);
    for (const item of itens) expect(item.organization_id).toBe(ORG);
    expect(vendas.map((v) => v.appointment_id).sort()).toEqual([APPOINTMENT, APPOINTMENT_2].sort());

    expect(rpcs.filter((fn) => fn === "fn_finalizar_comanda")).toHaveLength(2);
  });

  it("atendimento CANCELADO da própria empresa não derruba o lote (não é 'de fora')", async () => {
    montarMundo({
      agendamentos: [
        agendamento({ id: APPOINTMENT }),
        agendamento({ id: APPOINTMENT_2, status: "cancelled" }),
      ],
    });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(lote(APPOINTMENT, APPOINTMENT_2)));

    expect(res.status).toBe(200);
    expect(insercoes["sales"] ?? []).toHaveLength(1);
  });
});
