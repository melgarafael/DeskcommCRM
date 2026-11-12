import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  role: "manager" as string,
  settings: {} as Record<string, unknown>,
  message: null as Record<string, unknown> | null,
  /** Filtros aplicados na ÚLTIMA consulta a `messages` — é o que prova o isolamento. */
  filtrosDaMensagem: [] as Array<[string, unknown]>,
  audit: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "usuario-1", idioma: "pt-BR" },
    org: { orgId: "org-1", role: state.role },
  }),
}));

vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    state.audit.push(entrada);
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filtros.push([col, val]);
          return q;
        },
        maybeSingle: async () => {
          if (tabela === "organizations") {
            return { data: { settings: state.settings }, error: null };
          }
          if (tabela === "messages") {
            state.filtrosDaMensagem = [...filtros];
            const casa =
              state.message !== null &&
              filtros.every(([col, val]) => state.message?.[col] === val);
            return { data: casa ? state.message : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { POST } from "./route";

const id = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id }) };
const url = `http://localhost/api/v1/messages/${id}/texto-retido`;

/** Texto FICTÍCIO: nada real de cliente entra em teste (regra da #4500). */
const TEXTO_FICTICIO = "combinado fictício de teste, 3 caixas";

const mensagemApagada = () => ({
  id,
  organization_id: "org-1",
  conversation_id: "conversa-1",
  direction: "inbound",
  body: TEXTO_FICTICIO,
  media_derived_text: null,
  revoked_at: "2026-11-10T12:00:00.000Z",
});

beforeEach(() => {
  state.role = "manager";
  state.settings = {};
  state.message = mensagemApagada();
  state.filtrosDaMensagem = [];
  state.audit.length = 0;
});

describe("com permissão", () => {
  it("devolve o texto quando o perfil está autorizado na organização", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data?: { texto?: string } };
    expect(corpo.data?.texto).toBe(TEXTO_FICTICIO);
  });
});

describe("sem permissão", () => {
  it("nega com a lista VAZIA — o caso de hoje, antes de alguém configurar", async () => {
    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(403);
  });

  it("nega quando a lista tem outro perfil", async () => {
    state.role = "agent";
    state.settings = { texto_retido: { perfis: ["admin"] } };
    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(403);
  });

  it("a resposta NÃO carrega o texto — nem em campo extra, nem em mensagem de erro", async () => {
    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    const bruto = await res.text();
    expect(bruto).not.toContain(TEXTO_FICTICIO);
    expect(bruto.toLowerCase()).toContain("permissão");
  });
});

describe("outra organização", () => {
  it("mensagem de outro tenant não sai, mesmo com o perfil autorizado", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    state.message = { ...mensagemApagada(), organization_id: "org-2" };

    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    const bruto = await res.text();

    expect(res.status).toBe(409);
    expect(bruto).not.toContain(TEXTO_FICTICIO);
    // O filtro por organização é a porta: sem ele a linha da outra empresa vem.
    expect(state.filtrosDaMensagem).toContainEqual(["organization_id", "org-1"]);
  });
});

describe("texto indisponível", () => {
  it("mensagem apagada sem corpo responde indisponível", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    state.message = { ...mensagemApagada(), body: null };

    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
      "texto_indisponivel",
    );
  });

  it("mensagem que não foi apagada não é revelada por esta porta", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    state.message = { ...mensagemApagada(), revoked_at: null };

    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(409);
  });

  it("mensagem apagada pelo atendente não é revelada por esta porta", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    state.message = { ...mensagemApagada(), direction: "outbound" };

    const res = await POST(new NextRequest(url, { method: "POST" }), ctx);
    expect(res.status).toBe(409);
  });
});

describe("auditoria de cada clique", () => {
  const ultima = () => state.audit[state.audit.length - 1] ?? {};

  it("revelado audita usuário, organização, conversa, mensagem e resultado", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    await POST(new NextRequest(url, { method: "POST" }), ctx);

    const entrada = ultima();
    expect(entrada.action).toBe("message.retained_text_revealed");
    expect(entrada.actorUserId).toBe("usuario-1");
    expect(entrada.organizationId).toBe("org-1");
    expect(entrada.resourceType).toBe("message");
    expect(entrada.resourceId).toBe(id);
    expect(entrada.metadata).toMatchObject({
      conversation_id: "conversa-1",
      message_id: id,
      result: "revelado",
      role: "manager",
    });
  });

  it("NEGADO também audita — e sem conteúdo nenhum no metadata", async () => {
    await POST(new NextRequest(url, { method: "POST" }), ctx);

    const entrada = ultima();
    expect(entrada.action).toBe("message.retained_text_denied");
    expect(entrada.metadata).toMatchObject({ result: "negado", message_id: id });
    expect(JSON.stringify(entrada)).not.toContain(TEXTO_FICTICIO);
  });

  it("INDISPONÍVEL também audita", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    state.message = { ...mensagemApagada(), body: null };
    await POST(new NextRequest(url, { method: "POST" }), ctx);

    expect(ultima().action).toBe("message.retained_text_unavailable");
    expect(ultima().metadata).toMatchObject({ result: "indisponivel" });
  });

  it("nenhuma das três trilhas copia o texto", async () => {
    state.settings = { texto_retido: { perfis: ["manager"] } };
    await POST(new NextRequest(url, { method: "POST" }), ctx);
    state.message = { ...mensagemApagada(), body: null };
    await POST(new NextRequest(url, { method: "POST" }), ctx);
    state.settings = {};
    await POST(new NextRequest(url, { method: "POST" }), ctx);

    expect(state.audit.length).toBe(3);
    expect(JSON.stringify(state.audit)).not.toContain(TEXTO_FICTICIO);
  });
});
