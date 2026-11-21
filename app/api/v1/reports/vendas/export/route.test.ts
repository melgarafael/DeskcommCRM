/**
 * GET /api/v1/reports/vendas/export — o arquivo do relatório de vendas.
 *
 * Duas provas sustentam esta fatia, e as duas são por COMPARAÇÃO, não por
 * leitura:
 *
 *   1. **O arquivo tem os MESMOS números que a tela.** O teste chama as duas
 *      rotas — a da tela (`/api/v1/metrics/attendants`) e a do arquivo — contra
 *      o mesmo payload da RPC e compara, linha a linha, cada número do CSV com
 *      o do JSON. Recalcular em paralelo (um `reduce`, uma segunda consulta) cai
 *      aqui: o número diverge e o teste fica vermelho.
 *   2. **O recorte da tela vai junto.** Com `?owner_user_id=`, o arquivo tem só
 *      a linha daquele atendente e o `p_owner` chega à RPC; ignorar o filtro
 *      devolve o mundo inteiro e derruba o teste.
 *
 * O resto mede o envelope das exportações que já existem (BOM, `;`, CRLF,
 * `Content-Disposition` datado), o papel `manager` — o mesmo de
 * `contacts/export` e `audit/export` — e a trilha de auditoria com QUANTOS, sem
 * conteúdo de venda.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(),
  membrosDaOrganizacao: vi.fn(),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ANA = "33333333-3333-4333-8333-333333333333";
const BRUNO = "44444444-4444-4444-8444-444444444444";
const JANELA = "?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";
const URL = `http://localhost/api/v1/reports/vendas/export${JANELA}`;

function usuario(): AuthUser {
  return {
    id: USER_ID,
    email: "gerente@exemplo.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as AuthUser;
}

/** A linha do atendente exatamente como `fn_attendant_metrics` devolve. */
function atendente(parcial: Record<string, unknown>): Record<string, unknown> {
  return {
    user_id: ANA,
    won: 0,
    lost: 0,
    conversations_handled: 0,
    avg_first_response_seconds: null,
    median_first_response_seconds: null,
    ...parcial,
  };
}

/**
 * O dublê da RPC — e ele HONRA `p_owner`, como a função do banco faz. Sem isso
 * o teste do recorte passaria mesmo se a rota esquecesse o filtro.
 */
function fakeSupabase(todasAsLinhas: Array<Record<string, unknown>>) {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(nome: string, args: Record<string, unknown>) {
      chamadas.push({ nome, args });
      const owner = args.p_owner as string | undefined;
      const linhas = owner ? todasAsLinhas.filter((l) => l.user_id === owner) : todasAsLinhas;
      return Promise.resolve({
        data: {
          funnel: [{ stage_id: "s1", stage_name: "Novo", position: 0, count: 7 }],
          attendants: linhas,
          excluded_tag: null,
          excluded_conversations: 0,
        },
        error: null,
      });
    },
  };
  return { chamadas, client };
}

async function chamarExport(url = URL): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest(url));
}

async function chamarTela(url = URL.replace("/reports/vendas/export", "/metrics/attendants")) {
  const { GET } = await import("@/app/api/v1/metrics/attendants/route");
  return GET(new NextRequest(url));
}

/** As linhas de DADOS do CSV, já sem BOM e sem a quebra final. */
function linhasDoCsv(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter((l) => l !== "")
    .slice(1);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(),
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
  vi.mocked(nomesDosAtendentes).mockResolvedValue(
    new Map([
      [ANA, "Ana Souza"],
      [BRUNO, null],
    ]) as never,
  );
});

describe("GET /api/v1/reports/vendas/export — o mesmo número que a tela", () => {
  it("⭐ cada número do arquivo é o número que a tela mostra (comparação, não leitura)", async () => {
    const linhasDaRpc = [
      atendente({
        user_id: ANA,
        won: 4,
        lost: 1,
        conversations_handled: 9,
        avg_first_response_seconds: 900,
        median_first_response_seconds: 120,
      }),
      atendente({
        user_id: BRUNO,
        won: 0,
        lost: 3,
        conversations_handled: 2,
        avg_first_response_seconds: 12.5,
        median_first_response_seconds: null,
      }),
    ];

    // A TELA primeiro: é dela que o arquivo tem de ser cópia.
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(linhasDaRpc).client as never);
    const tela = (await (await chamarTela()).json()) as {
      data: { attendants: Array<Record<string, unknown>> };
    };

    vi.mocked(createClient).mockResolvedValue(fakeSupabase(linhasDaRpc).client as never);
    const arquivo = await chamarExport();
    const linhas = linhasDoCsv(await arquivo.text());

    expect(tela.data.attendants).toHaveLength(2);
    expect(linhas).toHaveLength(2);

    tela.data.attendants.forEach((linha, i) => {
      const [nome, ganhos, perdidos, conversas, media, mediana] = linhas[i]!.split(";");
      // O rótulo é o da casa (nome → e-mail → "Atendente <sufixo>"), nunca o uuid.
      expect(nome).toBe(
        rotuloDoMembro({
          full_name: linha.user_id === ANA ? "Ana Souza" : null,
          email: null,
          user_id: linha.user_id as string,
        }),
      );
      expect(Number(ganhos)).toBe(linha.won);
      expect(Number(perdidos)).toBe(linha.lost);
      expect(Number(conversas)).toBe(linha.conversations_handled);
      expect(media).toBe(linha.avg_first_response_seconds === 12.5 ? "12,5" : "900");
      expect(mediana).toBe(linha.median_first_response_seconds === null ? "" : "120");
    });
  });

  it("⭐ com o atendente filtrado na tela, o arquivo tem SÓ a linha dele", async () => {
    const linhasDaRpc = [
      atendente({ user_id: ANA, won: 4, lost: 1, conversations_handled: 9 }),
      atendente({ user_id: BRUNO, won: 0, lost: 3, conversations_handled: 2 }),
    ];
    const { chamadas, client } = fakeSupabase(linhasDaRpc);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamarExport(`${URL}&owner_user_id=${BRUNO}`);
    const linhas = linhasDoCsv(await res.text());

    // O filtro viaja para a MESMA RPC da tela — ignorá-lo devolveria as duas
    // linhas e este `toHaveLength(1)` cairia.
    expect(chamadas[0]?.args).toMatchObject({ p_owner: BRUNO });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain("0;3;2");
    expect(linhas.join("")).not.toContain("Ana Souza");
  });

  it("sem filtro, o arquivo é o mesmo conjunto da tela (todos os atendentes)", async () => {
    const linhasDaRpc = [
      atendente({ user_id: ANA, won: 1 }),
      atendente({ user_id: BRUNO, won: 2 }),
    ];
    const { chamadas, client } = fakeSupabase(linhasDaRpc);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const linhas = linhasDoCsv(await (await chamarExport()).text());

    expect(chamadas[0]?.args).toMatchObject({
      p_org: ORG_ID,
      p_from: "2026-09-01T00:00:00.000Z",
      p_to: "2026-10-01T00:00:00.000Z",
      p_owner: undefined,
    });
    expect(linhas).toHaveLength(2);
  });
});

describe("GET /api/v1/reports/vendas/export — o envelope das exportações da casa", () => {
  it("⭐ CSV com BOM, `;`, CRLF e nome de arquivo que diz o que é e o período", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase([atendente({ user_id: ANA })]).client as never,
    );

    const res = await chamarExport();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="vendas-por-atendente-2026-09-01_a_2026-10-01.csv"',
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();

    // O BOM são os três primeiros BYTES — `res.text()` o come.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const corpo = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    expect(corpo.startsWith("atendente;ganhos;perdidos;conversas;")).toBe(true);
    expect(corpo).toContain("\r\n");
    expect(corpo.endsWith("\r\n")).toBe(true);
  });

  it("média não medida sai VAZIA, e o decimal sai com vírgula (Excel pt-BR)", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase([
        atendente({
          user_id: ANA,
          won: 2,
          avg_first_response_seconds: 1.5,
          median_first_response_seconds: null,
        }),
      ]).client as never,
    );

    const [, , , , media, mediana] = linhasDoCsv(await (await chamarExport()).text())[0]!.split(
      ";",
    );

    expect(media).toBe("1,5");
    // `null` não é zero: zero diria "respondeu na hora zero".
    expect(mediana).toBe("");
  });

  it("lista vazia devolve o cabeçalho — não um arquivo que mente ter linhas", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase([]).client as never);

    const res = await chamarExport();
    const linhas = linhasDoCsv(await res.text());

    expect(res.status).toBe(200);
    expect(linhas).toHaveLength(0);
  });
});

describe("GET /api/v1/reports/vendas/export — papel, escopo e auditoria", () => {
  it("exige `manager`, o MESMO piso de contacts/export e audit/export", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase([]).client as never);

    await chamarExport();

    const [papel, opcoes] = vi.mocked(requireRole).mock.calls[0]!;
    expect(papel).toBe("manager");
    expect(Object.keys(opcoes ?? {}).sort()).toEqual(["requestId", "resource"]);
  });

  it("sem papel não lê uma linha sequer e não audita", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: { code: "forbidden_role", message: "Papel insuficiente." } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    } as never);

    const res = await chamarExport();

    expect(res.status).toBe(403);
    // O client nem foi criado: a recusa acontece ANTES de qualquer leitura.
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("audita QUANTOS e QUAL recorte — nunca o conteúdo da venda", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase([atendente({ user_id: ANA, won: 4 }), atendente({ user_id: BRUNO })])
        .client as never,
    );

    await chamarExport(`${URL}&owner_user_id=${ANA}`);

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "reports.sales_exported",
      actorUserId: USER_ID,
      organizationId: ORG_ID,
      resourceType: "report",
      metadata: {
        formato: "csv",
        total: 1,
        filtros: { atendente: ANA },
        janela: { de: "2026-09-01T00:00:00.000Z", ate: "2026-10-01T00:00:00.000Z", dias: 30 },
      },
    });
  });

  it("janela invertida é 422, e a leitura não acontece", async () => {
    const res = await chamarExport(
      "http://localhost/api/v1/reports/vendas/export?from=2026-10-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
    );

    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("slug de atendente que não é uuid é 422 — o mesmo validador da tela", async () => {
    const res = await chamarExport(`${URL}&owner_user_id=ana`);

    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });
});
