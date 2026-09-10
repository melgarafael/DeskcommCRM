/**
 * LIGAR O LEMBRETE — a superfície que faltava, e as três coisas que ela promete.
 *
 * O cron `agenda-reminder` (`99c33257`) lê `calendar_event_types.reminder_enabled`
 * e `reminder_minutes_before` desde que nasceu. Nenhum dos dois estava no
 * `criarSchema`, no `alterarSchema` nem na projeção do GET desta rota — então a
 * varredura devolvia zero linhas em TODA instalação e ninguém tinha como mudar
 * isso, nem pela tela nem pela API. É o anti-pattern que esta casa nomeia:
 * capacidade que existe e não tem como ser usada.
 *
 * ─── O que cada bloco prende, e por que assim ────────────────────────────────
 *
 * O veredito NUNCA é "o campo aparece no schema" — símbolo presente não é
 * comportamento. O que se mede é o EFEITO em três eixos:
 *
 *  1. **Persiste.** A linha do banco termina com o valor pedido. Um handler que
 *     valida o campo e depois o descarta passa em qualquer teste de símbolo.
 *  2. **Recusa o que não lembra.** A faixa é mais estreita que o CHECK do banco
 *     de propósito (0 min nunca dispara, 30 dias não é lembrete) — e recusar
 *     tem de vir SEM escrita nenhuma.
 *  3. **Não atravessa organização.** O admin client bypassa a RLS; o único
 *     filtro é o `.eq("organization_id", …)` da rota. Um teste que só olhasse o
 *     status 404 passaria com a escrita já emitida — por isso o que se afirma é
 *     sobre a LINHA da outra organização, que tem de continuar intacta.
 *
 * O dublê APLICA os filtros de verdade (não devolve linha fixa): sem isso,
 * apagar o `.eq("organization_id", …)` da rota deixaria o caso de isolamento
 * verde, medindo o dublê em vez do handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { listaTiposDeAtendimento } from "@/lib/agenda/consulta";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agenda/consulta", () => ({ listaTiposDeAtendimento: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const TIPO_DA_ORG = "44444444-4444-4444-8444-444444444444";
const TIPO_DA_OUTRA = "55555555-5555-4555-8555-555555555555";

interface Linha {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
  [k: string]: unknown;
}

function linha(over: Partial<Linha> & { id: string; organization_id: string }): Linha {
  return {
    name: "Consulta",
    slug: `slug-${over.id}`,
    // Como o banco entrega desde a 0194: desligado, 1440 min guardados.
    reminder_enabled: false,
    reminder_minutes_before: 1440,
    ...over,
  };
}

/** Toda escrita que chegou ao banco, com os filtros que a acompanharam. */
interface Escrita {
  op: "insert" | "update";
  campos: Record<string, unknown>;
  filtros: Record<string, unknown>;
}

function makeAdmin(linhas: Linha[]) {
  const escritas: Escrita[] = [];

  function builder() {
    const filtros: Record<string, unknown> = {};
    let op: "insert" | "update" | null = null;
    let campos: Record<string, unknown> = {};

    function resolver(): { data: unknown; error: null } {
      if (op === "insert") {
        escritas.push({ op, campos, filtros });
        const nova = linha({
          id: "66666666-6666-4666-8666-666666666666",
          organization_id: String(campos.organization_id),
          ...(campos as Partial<Linha>),
        });
        linhas.push(nova);
        return { data: { id: nova.id, slug: nova.slug }, error: null };
      }
      // O update APLICA os filtros — é o que faz o caso de isolamento medir a
      // rota. E a escrita é registrada de qualquer jeito: uma tentativa que não
      // casou linha nenhuma é informação, não silêncio.
      escritas.push({ op: "update", campos, filtros });
      const alvo = linhas.filter((l) =>
        Object.entries(filtros).every(([k, v]) => (l as Record<string, unknown>)[k] === v),
      );
      for (const l of alvo) Object.assign(l, campos);
      return { data: alvo[0] ? { id: alvo[0].id } : null, error: null };
    }

    const api = {
      insert(v: Record<string, unknown>) {
        op = "insert";
        campos = v;
        return api;
      },
      update(v: Record<string, unknown>) {
        op = "update";
        campos = v;
        return api;
      },
      eq(coluna: string, valor: unknown) {
        filtros[coluna] = valor;
        return api;
      },
      select() {
        return api;
      },
      single: async () => resolver(),
      maybeSingle: async () => resolver(),
    };
    return api;
  }

  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      expect(tabela, "a rota mexeu em outra tabela").toBe("calendar_event_types");
      return builder();
    },
  } as unknown as ReturnType<typeof createAdminClient>);

  return { escritas };
}

function authOk(role: "manager" | "admin" = "manager"): void {
  const user: AuthUser = {
    id: USER,
    email: "manager@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role } });
}

function req(metodo: "POST" | "PATCH", body: unknown) {
  return new NextRequest("http://localhost/api/v1/agenda/tipos", {
    method: metodo,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function corpoDeErro(res: Response) {
  return (await res.json()) as { error: { code: string; message: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/agenda/tipos — o lembrete no nascimento do tipo", () => {
  it("liga o lembrete pedido, e o valor CHEGA ao banco", async () => {
    authOk();
    const linhas: Linha[] = [];
    makeAdmin(linhas);
    const { POST } = await import("./route");

    const res = await POST(
      req("POST", {
        name: "Retorno",
        category: "retorno",
        duration_minutes: 15,
        location_kind: "in_person",
        reminder_enabled: true,
        reminder_minutes_before: 60,
      }),
    );

    expect(res.status).toBe(201);
    // A LINHA, não o schema: um handler que validasse e descartasse o campo
    // devolveria 201 igual.
    expect(linhas[0]?.reminder_enabled).toBe(true);
    expect(linhas[0]?.reminder_minutes_before).toBe(60);
  });

  /**
   * O DEFAULT DA 0194 CONTINUA VALENDO — e é isto que impede a entrega inteira
   * de virar uma regressão: nenhuma instalação passa a mandar mensagem por ter
   * atualizado.
   *
   * O que se prende é a AUSÊNCIA do campo no INSERT, não `reminder_enabled ===
   * false` na linha: um `.default(false)` no Zod produziria a mesma linha e
   * sobrescreveria a coluna do banco em toda criação, tirando do dono da
   * instalação a única decisão que a 0194 deixou reservada para ele.
   */
  it("sem o campo, o INSERT não o menciona — quem decide segue sendo o default do banco", async () => {
    authOk();
    const linhas: Linha[] = [];
    const db = makeAdmin(linhas);
    const { POST } = await import("./route");

    await POST(
      req("POST", {
        name: "Consulta",
        category: "consulta",
        duration_minutes: 30,
        location_kind: "in_person",
      }),
    );

    expect(Object.keys(db.escritas[0]?.campos ?? {})).not.toContain("reminder_enabled");
    expect(Object.keys(db.escritas[0]?.campos ?? {})).not.toContain("reminder_minutes_before");
  });
});

describe("PATCH /api/v1/agenda/tipos — ligar e desligar depois", () => {
  it("liga o lembrete de um tipo que já existia", async () => {
    authOk();
    const linhas = [linha({ id: TIPO_DA_ORG, organization_id: ORG })];
    makeAdmin(linhas);
    const { PATCH } = await import("./route");

    const res = await PATCH(
      req("PATCH", { id: TIPO_DA_ORG, reminder_enabled: true, reminder_minutes_before: 120 }),
    );

    expect(res.status).toBe(200);
    expect(linhas[0]?.reminder_enabled).toBe(true);
    expect(linhas[0]?.reminder_minutes_before).toBe(120);
  });

  it("desligar NÃO apaga a antecedência guardada", async () => {
    // A tela desabilita o campo de minutos quando o aviso está desligado, e
    // campo desabilitado não entra no FormData — então o PATCH chega só com
    // `reminder_enabled: false`. Se o handler zerasse os minutos por conta
    // própria, religar amanhã perderia a escolha de hoje.
    authOk();
    const linhas = [
      linha({ id: TIPO_DA_ORG, organization_id: ORG, reminder_enabled: true, reminder_minutes_before: 90 }),
    ];
    makeAdmin(linhas);
    const { PATCH } = await import("./route");

    await PATCH(req("PATCH", { id: TIPO_DA_ORG, reminder_enabled: false }));

    expect(linhas[0]?.reminder_enabled).toBe(false);
    expect(linhas[0]?.reminder_minutes_before).toBe(90);
  });
});

describe("a faixa aceita — mais estreita que o CHECK do banco, de propósito", () => {
  /**
   * `0` e `43200` são as bordas do CHECK (`between 0 and 43200`) e as duas
   * produzem lembrete que não lembra: o de 0 min é descartado por `estaNaHora`
   * em toda rodada, e o de 30 dias é um convite, não um lembrete.
   */
  it.each([
    ["0 minutos — nunca dispara", 0],
    ["14 minutos — abaixo de três ciclos do cron", 14],
    ["10 dias — mais que o teto de 7", 14_400],
    ["30 dias — a borda do CHECK do banco", 43_200],
  ])("recusa %s com 422, em português, e SEM escrita", async (_nome, minutos) => {
    authOk();
    const linhas = [linha({ id: TIPO_DA_ORG, organization_id: ORG })];
    const db = makeAdmin(linhas);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", { id: TIPO_DA_ORG, reminder_minutes_before: minutos }));

    expect(res.status).toBe(422);
    const corpo = await corpoDeErro(res);
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message, "a recusa saiu em inglês, do default do Zod").toMatch(/lembrete/i);
    expect(db.escritas, "recusou e escreveu mesmo assim").toEqual([]);
    expect(linhas[0]?.reminder_minutes_before).toBe(1440);
  });

  it.each([
    ["o piso", 15],
    ["o teto", 10_080],
  ])("aceita %s da faixa", async (_nome, minutos) => {
    authOk();
    const linhas = [linha({ id: TIPO_DA_ORG, organization_id: ORG })];
    makeAdmin(linhas);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", { id: TIPO_DA_ORG, reminder_minutes_before: minutos }));

    expect(res.status).toBe(200);
    expect(linhas[0]?.reminder_minutes_before).toBe(minutos);
  });

  it("recusa valor que não é número inteiro", async () => {
    authOk();
    const linhas = [linha({ id: TIPO_DA_ORG, organization_id: ORG })];
    const db = makeAdmin(linhas);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", { id: TIPO_DA_ORG, reminder_minutes_before: "60" }));

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });
});

describe("isolamento entre organizações", () => {
  /**
   * ⭐ O tipo EXISTE — só que na outra organização. O veredito não é o status:
   * é a linha da organização B, que tem de terminar exatamente como começou.
   * O admin client bypassa a RLS, então o `.eq("organization_id", …)` da rota é
   * a única coisa entre a organização A e o cadastro da B.
   */
  it("a organização A não liga o lembrete de um tipo da B", async () => {
    authOk();
    const daOutra = linha({ id: TIPO_DA_OUTRA, organization_id: OUTRA_ORG });
    const linhas = [daOutra];
    makeAdmin(linhas);
    const { PATCH } = await import("./route");

    const res = await PATCH(
      req("PATCH", { id: TIPO_DA_OUTRA, reminder_enabled: true, reminder_minutes_before: 30 }),
    );

    expect(res.status).toBe(404);
    expect(daOutra.reminder_enabled, "a organização A ligou o lembrete da B").toBe(false);
    expect(daOutra.reminder_minutes_before).toBe(1440);
  });

  it("alterar exige manager", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    });
    const linhas = [linha({ id: TIPO_DA_ORG, organization_id: ORG })];
    const db = makeAdmin(linhas);
    const { PATCH } = await import("./route");

    const res = await PATCH(req("PATCH", { id: TIPO_DA_ORG, reminder_enabled: true }));

    expect(res.status).toBe(403);
    expect(db.escritas).toEqual([]);
    // O teste acima recusaria igual se a rota pedisse `viewer` — quem prende o
    // papel é a asserção sobre o argumento.
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });
});

describe("GET /api/v1/agenda/tipos", () => {
  it("publica o estado do lembrete — sem ele, a tela só sabe pedir, nunca saber", async () => {
    authOk();
    makeAdmin([]);
    vi.mocked(listaTiposDeAtendimento).mockResolvedValue({
      ok: true,
      tipos: [
        {
          id: TIPO_DA_ORG,
          nome: "Consulta",
          slug: "consulta",
          descricao: null,
          categoria: "consulta",
          duracaoMin: 30,
          localKind: "in_person",
          localDetalhes: null,
          precisaConfirmacao: false,
          ativo: true,
          donoPadraoId: USER,
          bufferAntesMin: 0,
          bufferDepoisMin: 0,
          antecedenciaMinimaMin: 120,
          janelaDeAgendamentoDias: 60,
          lembreteLigado: true,
          lembreteAntecedenciaMin: 180,
        },
      ],
    });

    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/agenda/tipos"));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      data: Array<{ reminder_enabled: boolean; reminder_minutes_before: number }>;
    };
    expect(corpo.data[0]?.reminder_enabled).toBe(true);
    expect(corpo.data[0]?.reminder_minutes_before).toBe(180);
  });
});
