import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";

import { POST } from "./route";

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));

/**
 * POST /api/v1/conversations/[id]/drafts (issue #1611) — a porta da integração.
 *
 * O banco é o MESMO dublê com predicado do teste das regras: a linha da
 * conversa só aparece se `organization_id` casar. É por isso que o caso
 * cross-tenant mede a rota, e não o mock.
 *
 * `idempotency_keys` entra no dublê porque o helper roda DE VERDADE aqui —
 * mesmo critério do teste de `messages`: o que se mede é a integração entre a
 * rota e `comIdempotencia`, e o número que decide o caso é a CONTAGEM de
 * rascunhos, não a igualdade das respostas (um caminho que devolvesse o recibo
 * gravado e criasse de novo passaria na igualdade e duplicaria o rascunho).
 */
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONV_B = "bbbbbbbb-1111-4000-8000-000000000002";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const CHAVE = "aaaaaaaa-2222-4000-8000-000000000010";

type Linha = Record<string, unknown>;

let drafts: Linha[] = [];
let chaves: Linha[] = [];
let inserts: number;

function clienteFake(conversas: Linha[]) {
  function builder(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let payload: Linha | null = null;
    let patch: Linha | null = null;
    let maiorQue: [string, unknown] | null = null;
    const linhas = () =>
      tabela === "conversation_drafts"
        ? drafts
        : tabela === "idempotency_keys"
          ? chaves
          : conversas;
    const casa = (l: Linha) =>
      filtros.every(([c, v]) => l[c] === v) &&
      (maiorQue === null || String(l[maiorQue[0]]) > String(maiorQue[1]));
    const q = {
      select: () => q,
      insert: (v: Linha) => {
        // O recibo é gravado no INSERT e ninguém chama `.select()` depois: o
        // helper aguarda este retorno direto, então a linha entra aqui.
        if (tabela === "idempotency_keys") {
          chaves.push({ id: `chave-${chaves.length + 1}`, ...v });
          return { error: null };
        }
        payload = v;
        return q;
      },
      update: (v: Linha) => {
        patch = v;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      is: () => q,
      gt: (c: string, v: unknown) => {
        maiorQue = [c, v];
        return q;
      },
      maybeSingle: async () => {
        if (payload) {
          inserts += 1;
          const nova = { id: "00000000-0000-4000-8000-000000000020", ...payload };
          drafts.push(nova);
          return { data: { id: nova.id }, error: null };
        }
        const alvo = linhas().find(casa) ?? null;
        return { data: alvo, error: null };
      },
      // O recibo TERMINAL é gravado por um UPDATE aguardado direto, sem
      // `maybeSingle`: é o `then` que aplica o patch na linha que casou.
      then: (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
        if (patch) {
          for (const l of linhas().filter(casa)) Object.assign(l, patch);
          patch = null;
        }
        return Promise.resolve({ data: null, error: null }).then(comOk, comErro);
      },
    };
    return q;
  }
  return { from: builder } as unknown as SupabaseClient;
}

function req(url: string, body: unknown, chave?: string) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(chave === undefined ? {} : { "Idempotency-Key": chave }),
    },
    body: JSON.stringify(body),
  });
}

const contexto = (id = CONV_A) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  drafts = [];
  chaves = [];
  inserts = 0;
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
  vi.mocked(tetoDeEscritaDoToken).mockResolvedValue(null);
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    organizationId: ORG_A,
    actor: { type: "user", id: USER },
    supabase: clienteFake([{ id: CONV_A, organization_id: ORG_A }]),
    idioma: "pt-BR",
    via: "token",
    apiTokenId: "token-1",
  } as unknown as Awaited<ReturnType<typeof resolveAuthDual>>);
});

describe("POST /api/v1/conversations/[id]/drafts", () => {
  it("devolve 201 com draft_id e URL, e audita a criação", async () => {
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/drafts`, {
        texto: "Sua cobrança venceu hoje.",
        origem: "erp",
      }),
      contexto(),
    );

    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as { data: { draft_id: string; url: string } };
    expect(corpo.data.draft_id).toBe("00000000-0000-4000-8000-000000000020");
    expect(corpo.data.url).toBe(`/app/inbox?id=${CONV_A}&rascunho=${corpo.data.draft_id}`);
    expect(drafts[0]).toMatchObject({ organization_id: ORG_A, source: "erp" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.draft_created",
        organizationId: ORG_A,
        resourceId: CONV_A,
        actorApiTokenId: "token-1",
      }),
    );
  });

  it("404 quando a conversa é de OUTRA organização — e nada é gravado", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: true,
      organizationId: ORG_A,
      actor: { type: "user", id: USER },
      supabase: clienteFake([{ id: CONV_B, organization_id: ORG_B }]),
      idioma: "pt-BR",
      via: "token",
      apiTokenId: "token-1",
    } as unknown as Awaited<ReturnType<typeof resolveAuthDual>>);

    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_B}/drafts`, { texto: "oi", origem: "erp" }),
      contexto(CONV_B),
    );

    expect(resposta.status).toBe(404);
    expect(inserts).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("422 acima do teto de 4096 caracteres, sem tocar o banco", async () => {
    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/drafts`, {
        texto: "x".repeat(4097),
        origem: "erp",
      }),
      contexto(),
    );

    expect(resposta.status).toBe(422);
    expect(inserts).toBe(0);
  });

  it("403 quando a identidade é negada — nem banco, nem auditoria", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    });

    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/drafts`, { texto: "oi", origem: "erp" }),
      contexto(),
    );

    expect(resposta.status).toBe(403);
    expect(inserts).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("429 quando o teto de escrita por token recusa", async () => {
    vi.mocked(tetoDeEscritaDoToken).mockResolvedValue(
      fail("rate_limited", "Too many requests.", 429),
    );

    const resposta = await POST(
      req(`/api/v1/conversations/${CONV_A}/drafts`, { texto: "oi", origem: "erp" }),
      contexto(),
    );

    expect(resposta.status).toBe(429);
    expect(inserts).toBe(0);
    expect(audit).not.toHaveBeenCalled();
    expect(tetoDeEscritaDoToken).toHaveBeenCalledWith(expect.anything(), "drafts", expect.any(String));
  });

  it("422 quando a conversa não é UUID", async () => {
    const resposta = await POST(
      req(`/api/v1/conversations/conversa-invalida/drafts`, { texto: "oi", origem: "erp" }),
      contexto("conversa-invalida"),
    );

    expect(resposta.status).toBe(422);
    expect(inserts).toBe(0);
  });
});

describe("POST /api/v1/conversations/[id]/drafts — Idempotency-Key", () => {
  const corpo = { texto: "Sua cobrança venceu hoje.", origem: "erp" };
  const url = (id: string) => `/api/v1/conversations/${id}/drafts`;

  it("mesma chave e mesmo corpo: DUAS chamadas, UM rascunho, a MESMA resposta", async () => {
    const primeira = await POST(req(url(CONV_A), corpo, CHAVE), contexto());
    const segunda = await POST(req(url(CONV_A), corpo, CHAVE), contexto());

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(await segunda.json()).toEqual(await primeira.json());
    // O número que decide: a integração que repete o pedido para de duplicar.
    expect(inserts).toBe(1);
    expect(drafts).toHaveLength(1);
    // O replay não é uma segunda criação — a trilha não pode contar duas.
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("mesma chave e corpo DIFERENTE: 409, e nada é criado", async () => {
    const primeira = await POST(req(url(CONV_A), corpo, CHAVE), contexto());
    const segunda = await POST(
      req(url(CONV_A), { texto: "Outro texto.", origem: "erp" }, CHAVE),
      contexto(),
    );

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(409);
    const erro = (await segunda.json()) as { error: { code: string } };
    expect(erro.error.code).toBe("idempotency_conflict");
    expect(inserts).toBe(1);
  });

  it("mesma chave em OUTRA conversa: 409, e não o replay da primeira", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: true,
      organizationId: ORG_A,
      actor: { type: "user", id: USER },
      supabase: clienteFake([
        { id: CONV_A, organization_id: ORG_A },
        { id: CONV_B, organization_id: ORG_A },
      ]),
      idioma: "pt-BR",
      via: "token",
      apiTokenId: "token-1",
    } as unknown as Awaited<ReturnType<typeof resolveAuthDual>>);

    const primeira = await POST(req(url(CONV_A), corpo, CHAVE), contexto());
    const segunda = await POST(req(url(CONV_B), corpo, CHAVE), contexto(CONV_B));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(409);
    expect(inserts).toBe(1);
  });

  it("chave que não é UUID: 400, e o efeito nem começa", async () => {
    const resposta = await POST(req(url(CONV_A), corpo, "nao-e-uuid"), contexto());

    expect(resposta.status).toBe(400);
    expect(inserts).toBe(0);
    expect(chaves).toHaveLength(0);
  });
});
