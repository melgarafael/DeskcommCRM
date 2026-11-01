// @vitest-environment node
/**
 * POST /api/v1/contacts/import/agenda (#2736) — a fronteira da rota.
 *
 * O serviço (`lib/contacts/agenda-do-celular.ts`) tem os testes dele com
 * dublês; aqui se prova o que é da ROTA: quem pode pedir, o que é recusado
 * ANTES de falar com o aparelho (body malformado, canal de outro tenant, canal
 * sem método de agenda, número desconectado) e o envelope que a tela lê.
 *
 * `@/lib/channels` é dublado aqui — resolveSessionRef e getAdapter — porque o
 * contrato do seam (a coluna do identificador, o adapter que implementa
 * `listPhonebook`) é testado lá; o que importa nesta fronteira é o que a rota
 * FAZ com as duas respostas, inclusive quando o adapter lança.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAdapter } from "@/lib/channels";
import { requireRole } from "@/lib/auth/require-role";
import { criarDepsDeAgenda, sincronizarAgendaDoCelular } from "@/lib/contacts/agenda-do-celular";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// O seam chega pronto: a coluna e o DEFAULT vêm do módulo real (escrevê-los
// aqui seria nomear provider num arquivo em `app/`, que o lint de canal varre).
vi.mock("@/lib/channels", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSessionRef: vi.fn(() => "sessao-pareada-1"),
  getAdapter: vi.fn(),
}));
// O serviço inteiro é dublê aqui — ele é coberto por testes próprios com as
// duas fronteiras (transporte e banco) injetadas.
vi.mock("@/lib/contacts/agenda-do-celular", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/contacts/agenda-do-celular")>()),
  criarDepsDeAgenda: vi.fn(() => ({ deps: "fabricados" })),
  sincronizarAgendaDoCelular: vi.fn(),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CANAL = "33333333-3333-4333-8333-333333333333";

/** O adapter DUM linha que TEM agenda — o método presente é o que a rota testa. */
function adapterComAgenda() {
  return { listPhonebook: vi.fn(async () => []) } as never;
}

/** A leitura da sessão que a rota faz — devolve o canal montado, ou ausência. */
function canalNoBanco(
  linha: { provider?: string | null; status?: string | null } | null,
  erro: { message: string } | null = null,
) {
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    maybeSingle: vi.fn(async () => ({ data: linha, error: erro })),
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from: vi.fn((tabela: string) => {
      expect(tabela).toBe("channel_sessions");
      return q;
    }),
  } as never);
}

function requisicao(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/contacts/import/agenda", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const RESUMO = {
  lidos: 320,
  importados: 40,
  ja_existentes: 270,
  ignorados: 10,
  erros: 0,
  truncado: false,
  proximo_offset: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
  vi.mocked(sincronizarAgendaDoCelular).mockResolvedValue(RESUMO as never);
  vi.mocked(getAdapter).mockReturnValue(adapterComAgenda());
  canalNoBanco({ provider: "canal-teste", status: "WORKING" });
});

describe("POST /api/v1/contacts/import/agenda", () => {
  it("sync em modo suporte é recusado antes de qualquer coisa", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(
      new Response("support", { status: 403 }) as never,
    );
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(403);
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("quem não é agent+ não sincroniza (mesma régua do import de planilha)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response("forbidden", { status: 403 }),
    } as never);
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(403);
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("body ausente ou sem uuid é 422, com o pedido dito em PT-BR", async () => {
    for (const corpo of [null, {}, { channel_session_id: "não é uuid" }]) {
      const r = await POST(
        new NextRequest("http://localhost/api/v1/contacts/import/agenda", {
          method: "POST",
          body: corpo === null ? undefined : JSON.stringify(corpo),
        }),
      );
      expect(r.status).toBe(422);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("validation_failed");
    }
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("canal que não existe nesta organização é 404 — sem vazar o de outro tenant", async () => {
    canalNoBanco(null);
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(404);
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("erro de banco na leitura da sessão é 500 com envelope, nunca 500 cru", async () => {
    canalNoBanco(null, { message: "boom" });
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });

  it("canal sem o método de agenda é 409, antes de gastar uma chamada no aparelho", async () => {
    // O adapter existe mas não implementa `listPhonebook` — é a pergunta
    // "este canal tem agenda?" respondida pela presença do método, sem uma
    // linha aqui dizendo qual é o provider.
    vi.mocked(getAdapter).mockReturnValue({} as never);
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("channel_without_phonebook");
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("provider que a imagem ainda não conhece cai no MESMO 409 (falha fechada)", async () => {
    vi.mocked(getAdapter).mockImplementation(() => {
      throw new Error("unknown_channel_provider: canal-novo");
    });
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("channel_without_phonebook");
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("número desconectado é 409 antes de gastar uma chamada no aparelho", async () => {
    canalNoBanco({ provider: "canal-teste", status: "STOPPED" });
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("channel_not_working");
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("caminho feliz: resolve o ref pelo seam, monta os deps e devolve o resumo", async () => {
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(200);
    expect(sincronizarAgendaDoCelular).toHaveBeenCalledTimes(1);
    const [deps, entrada] = vi.mocked(sincronizarAgendaDoCelular).mock.calls[0]!;
    expect(deps).toBe(vi.mocked(criarDepsDeAgenda).mock.results[0]!.value);
    // Quem LÊ a agenda é a função que a rota construiu a partir do adapter —
    // o serviço não toca em transporte nenhum por conta própria.
    const [, listarPagina] = vi.mocked(criarDepsDeAgenda).mock.calls[0]!;
    expect(typeof listarPagina).toBe("function");
    // E a sessão que ele recebe vem do resolveSessionRef do seam, não de uma
    // coluna escrita nesta rota.
    expect(entrada).toMatchObject({
      organizationId: ORG,
      session: "sessao-pareada-1",
      actorUserId: USER,
    });
    const body = (await r.json()) as { data: typeof RESUMO };
    expect(body.data).toEqual(RESUMO);
  });

  it("o offset do clique anterior chega ao serviço; sem ele, o clique começa do zero", async () => {
    await POST(requisicao({ channel_session_id: CANAL, offset: 500 }));
    expect(vi.mocked(sincronizarAgendaDoCelular).mock.calls[0]![1]).toMatchObject({ offset: 500 });

    vi.mocked(sincronizarAgendaDoCelular).mockClear();
    await POST(requisicao({ channel_session_id: CANAL }));
    expect(vi.mocked(sincronizarAgendaDoCelular).mock.calls[0]![1]).toMatchObject({ offset: 0 });
  });

  it("offset negativo ou fracionário é 422 — o cursor vem de fora e não vira loop", async () => {
    for (const offset of [-1, 1.5, "500"]) {
      const r = await POST(requisicao({ channel_session_id: CANAL, offset }));
      expect(r.status).toBe(422);
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    }
    expect(sincronizarAgendaDoCelular).not.toHaveBeenCalled();
  });

  it("o resumo com cursor vai inteiro para a tela — é ele que ela devolve no próximo clique", async () => {
    vi.mocked(sincronizarAgendaDoCelular).mockResolvedValue({
      ...RESUMO,
      truncado: true,
      proximo_offset: 1000,
    } as never);
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    const body = (await r.json()) as { data: { truncado: boolean; proximo_offset: number | null } };
    expect(body.data).toMatchObject({ truncado: true, proximo_offset: 1000 });
  });

  it("falha de transporte vira 502 com a frase da conexão — sem status do provedor", async () => {
    vi.mocked(sincronizarAgendaDoCelular).mockRejectedValue(
      new Error("falha_do_transporte_503: corpo do provedor"),
    );
    const r = await POST(requisicao({ channel_session_id: CANAL }));
    expect(r.status).toBe(502);
    const body = (await r.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("channel_unavailable");
    expect(body.error.message).not.toContain("503");
  });
});
