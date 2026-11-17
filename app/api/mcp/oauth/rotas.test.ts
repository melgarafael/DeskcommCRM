/**
 * As rotas do OAuth do MCP (migration 9390) e o 401 do `/api/mcp`, com o banco
 * falsificado. As regras que decidem a emissão (PKCE, uso único, ainda-admin)
 * moram no SQL e são provadas em `tests/invariants/mcp-oauth-servidor.test.ts`;
 * aqui fica o que é da rota: o que entra, o que sai, o que nunca vai ao banco
 * em claro, e para onde um erro pode (e não pode) voltar.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthDoMcp from "@/lib/mcp/auth";

const h = vi.hoisted(() => ({
  clientes: new Map<string, Record<string, unknown>>(),
  inserts: [] as { tabela: string; payload: Record<string, unknown> }[],
  rpcs: [] as { nome: string; args: Record<string, unknown> }[],
  rpcResposta: { data: null as unknown, error: null as null | { code?: string; message: string } },
  auditadas: [] as Record<string, unknown>[],
  limitado: false,
  registro: { motivo: null as string | null, despejados: 0 },
  authz: null as unknown,
  suporteNegado: null as Response | null,
}));

vi.mock("@/lib/audit", () => ({
  audit: async (linha: Record<string, unknown>) => {
    h.auditadas.push(linha);
  },
}));

vi.mock("@/lib/mcp/oauth/limites", () => ({
  oauthMcpLimitado: async () => h.limitado,
  TETO_DE_CLIENTES_PENDENTES: 100,
}));

vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "CRM" }) }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => h.suporteNegado }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async () => h.authz }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (c: string, v: unknown) => {
        filtros[c] = v;
        return chain;
      };
      chain.insert = (payload: Record<string, unknown>) => {
        h.inserts.push({ tabela, payload });
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: tabela === "mcp_oauth_clientes" ? (h.clientes.get(filtros.client_id as string) ?? null) : null,
        error: null,
      });
      chain.single = async () => ({ data: { id: "c0ffee00-0000-4000-8000-000000000001", created_at: "2026-11-15T20:00:00Z" }, error: null });
      chain.then = (ok: (v: unknown) => unknown) => ok({ data: null, error: null });
      return chain;
    },
    rpc: (nome: string, args: Record<string, unknown>) => {
      h.rpcs.push({ nome, args });
      if (nome === "fn_mcp_oauth_registrar_cliente") {
        const { motivo, despejados } = h.registro;
        return Promise.resolve({
          data: [
            motivo
              ? { motivo, id: null, created_at: null, despejados }
              : { motivo: null, id: "c0ffee00-0000-4000-8000-000000000001", created_at: "2026-11-15T20:00:00Z", despejados },
          ],
          error: null,
        });
      }
      return Promise.resolve(nome === "fn_mcp_oauth_podar" ? { data: 0, error: null } : h.rpcResposta);
    },
  }),
}));

vi.mock("@/lib/mcp/server", () => ({ createMcpServer: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: vi.fn() }));
vi.mock("@/lib/organizacao/capacidades", () => ({ capacidadesDaOrganizacao: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const real = await vi.importActual<typeof AuthDoMcp>("@/lib/mcp/auth");
  return {
    ...real,
    validateBearerToken: async () => {
      throw new real.McpAuthError(-32001, 401, "Missing or malformed Authorization header.");
    },
  };
});

const CLIENT_ID = `dcc_${"a".repeat(32)}`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const DESAFIO = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLIENTE = {
  id: "11111111-1111-4111-8111-111111111111",
  client_id: CLIENT_ID,
  nome: "ChatGPT",
  redirect_uris: [REDIRECT],
  metodo_de_autenticacao: "none",
  client_secret_hash: null,
  ultimo_uso_em: null as string | null,
};
/** O mesmo cliente depois de concluir uma troca de código aqui. */
const CLIENTE_JA_CONECTOU = { ...CLIENTE, ultimo_uso_em: "2026-11-10T12:00:00Z" };

function form(campos: Record<string, string>): string {
  return new URLSearchParams(campos).toString();
}

beforeEach(() => {
  h.clientes.clear();
  h.clientes.set(CLIENT_ID, CLIENTE);
  h.inserts = [];
  h.rpcs = [];
  h.auditadas = [];
  h.limitado = false;
  h.registro = { motivo: null, despejados: 0 };
  h.rpcResposta = { data: null, error: null };
  h.authz = null;
  h.suporteNegado = null;
});

describe("/api/mcp sem token: o 401 ensina onde pegar um", () => {
  it("leva WWW-Authenticate com resource_metadata (RFC 9728 §5.1)", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const resp = await POST(new NextRequest("http://localhost:3000/api/mcp", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(401);
    const desafio = resp.headers.get("www-authenticate") ?? "";
    expect(desafio).toMatch(/^Bearer /);
    // A origem é a de NEXT_PUBLIC_APP_URL (nunca do Host da requisição) — a do ambiente do teste.
    const { enderecosOAuth } = await import("@/lib/mcp/oauth/config");
    expect(desafio).toContain(`resource_metadata="${enderecosOAuth().metadadosDoRecurso}"`);
    expect(enderecosOAuth().metadadosDoRecurso).toMatch(/^https?:\/\/[^/]+\/\.well-known\/oauth-protected-resource$/);
    expect(desafio).not.toContain("invalid_token");
  });

  it("com token apresentado e recusado, diz invalid_token", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const resp = await POST(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer dsk_morto_x" },
      }),
    );
    expect(resp.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("POST /api/mcp/oauth/register", () => {
  /** O que foi ao banco para registrar: a função que conta, despeja e insere sob lock. */
  const registros = () => h.rpcs.filter((r) => r.nome === "fn_mcp_oauth_registrar_cliente");

  it("registra cliente público e não guarda segredo nenhum", async () => {
    const { POST } = await import("./register/route");
    const resp = await POST(
      new Request("http://x/api/mcp/oauth/register", {
        method: "POST",
        body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }),
      }),
    );
    expect(resp.status).toBe(201);
    const corpo = (await resp.json()) as Record<string, unknown>;
    expect(corpo.client_id).toMatch(/^dcc_[A-Za-z0-9_-]{32}$/);
    expect(corpo.client_secret).toBeUndefined();
    expect(corpo.token_endpoint_auth_method).toBe("none");
    expect(registros()[0]!.args.p_client_secret_hash).toBeNull();
    // A poda é do cron diário, nunca da requisição de registro.
    expect(h.rpcs.map((r) => r.nome)).not.toContain("fn_mcp_oauth_podar");
    expect(h.auditadas[0]!.action).toBe("mcp_oauth.cliente_registrado");
  });

  it("o nome declarado chega limpo ao banco — é ele que vira o nome do token", async () => {
    const { POST } = await import("./register/route");
    const resp = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ client_name: "\u202EChat\nGPT\u202C\u200F", redirect_uris: [REDIRECT] }),
      }),
    );
    expect(resp.status).toBe(201);
    expect(registros()[0]!.args.p_nome).toBe("Chat GPT");
    expect(((await resp.json()) as { client_name: string }).client_name).toBe("Chat GPT");
  });

  it("cliente com segredo: o plaintext sai na resposta e só o hash vai ao banco", async () => {
    const { POST } = await import("./register/route");
    const resp = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }),
      }),
    );
    const corpo = (await resp.json()) as { client_secret: string };
    expect(corpo.client_secret).toMatch(/^dcs_/);
    const guardado = registros()[0]!.args.p_client_secret_hash as string;
    expect(guardado).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(guardado).not.toContain(corpo.client_secret);
  });

  it("redirect http fora de localhost é recusado", async () => {
    const { POST } = await import("./register/route");
    const resp = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) }),
    );
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    expect(registros()).toHaveLength(0);
  });

  it("teto de pendentes cheio: o registro novo é aceito, e o despejo vai na auditoria", async () => {
    const { POST } = await import("./register/route");
    h.registro = { motivo: null, despejados: 1 };
    const resp = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
    expect(resp.status).toBe(201);
    expect(registros()[0]!.args.p_teto).toBe(100);
    expect(h.auditadas[0]!.metadata).toMatchObject({ pendentes_despejados: 1 });
  });

  it("campos com teto: corpo grande, endereço longo e endereços demais são recusados sem gravar", async () => {
    const { POST } = await import("./register/route");
    const registrar = (corpo: string) => POST(new Request("http://x", { method: "POST", body: corpo }));
    const grande = await registrar(JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x".repeat(9_000) }));
    expect(grande.status).toBe(413);
    const longo = await registrar(JSON.stringify({ redirect_uris: [`${REDIRECT}?${"a".repeat(600)}`] }));
    expect(longo.status).toBe(400);
    const demais = await registrar(JSON.stringify({ redirect_uris: Array.from({ length: 6 }, (_, i) => `${REDIRECT}/${i}`) }));
    expect(demais.status).toBe(400);
    expect(registros()).toHaveLength(0);
  });

  it("limite de taxa responde 429 antes de tocar no banco", async () => {
    h.limitado = true;
    const { POST } = await import("./register/route");
    const resp = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
    expect(resp.status).toBe(429);
    expect(registros()).toHaveLength(0);
  });
});

describe("GET /api/mcp/oauth/authorize", () => {
  const query = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: DESAFIO,
      code_challenge_method: "S256",
      state: "st-1",
      scope: "mcp:read mcp:write",
      ...extra,
    }).toString();

  it("pedido válido: ponte same-origin para a tela de consentimento", async () => {
    const { GET } = await import("./authorize/route");
    const resp = await GET(new Request(`http://x/api/mcp/oauth/authorize?${query()}`));
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("window.location.replace(");
    expect(html).toContain("/oauth/mcp/consentir?");
    expect(resp.headers.get("location")).toBeNull();
  });

  it("redirect_uri não registrado: página de erro, NUNCA redirecionamento", async () => {
    const { GET } = await import("./authorize/route");
    const resp = await GET(new Request(`http://x/api/mcp/oauth/authorize?${query({ redirect_uri: "https://evil.example/cb" })}`));
    expect(resp.status).toBe(400);
    expect(resp.headers.get("location")).toBeNull();
    expect(await resp.text()).not.toContain("evil.example");
  });

  it("cliente que nunca concluiu uma troca: erro de validação é página do CRM, NUNCA redirecionamento", async () => {
    const { GET } = await import("./authorize/route");
    const defeitos: Record<string, string>[] = [
      { code_challenge_method: "plain" },
      { response_type: "token" },
      { resource: "https://outro.example/mcp" },
    ];
    for (const extra of defeitos) {
      const resp = await GET(new Request(`http://x/api/mcp/oauth/authorize?${query(extra)}`));
      expect(resp.status, JSON.stringify(extra)).toBe(400);
      expect(resp.headers.get("location"), JSON.stringify(extra)).toBeNull();
      expect(resp.headers.get("content-type")).toContain("text/html");
      expect(await resp.text()).not.toContain("chatgpt.com");
    }
  });

  it("cliente que já conectou, sem PKCE S256: volta ao cliente com invalid_request e o state", async () => {
    h.clientes.set(CLIENT_ID, CLIENTE_JA_CONECTOU);
    const { GET } = await import("./authorize/route");
    const resp = await GET(new Request(`http://x/api/mcp/oauth/authorize?${query({ code_challenge_method: "plain" })}`));
    expect(resp.status).toBe(302);
    const volta = new URL(resp.headers.get("location")!);
    expect(`${volta.origin}${volta.pathname}`).toBe(REDIRECT);
    expect(volta.searchParams.get("error")).toBe("invalid_request");
    expect(volta.searchParams.get("state")).toBe("st-1");
  });

  it("cliente que já conectou, resource de outro servidor: invalid_target", async () => {
    h.clientes.set(CLIENT_ID, CLIENTE_JA_CONECTOU);
    const { GET } = await import("./authorize/route");
    const resp = await GET(new Request(`http://x/api/mcp/oauth/authorize?${query({ resource: "https://outro.example/mcp" })}`));
    expect(new URL(resp.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("POST /api/mcp/oauth/token", () => {
  const troca = {
    grant_type: "authorization_code",
    code: "dco_codigo",
    redirect_uri: REDIRECT,
    code_verifier: "v".repeat(43),
    client_id: CLIENT_ID,
  };
  const post = async (campos: Record<string, string>, headers: Record<string, string> = {}) => {
    const { POST } = await import("./token/route");
    return POST(
      new Request("http://x/api/mcp/oauth/token", {
        method: "POST",
        body: form(campos),
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      }),
    );
  };

  it("troca o código: devolve um dsk_ e um refresh, e o banco só vê hashes", async () => {
    h.rpcResposta = {
      data: [{ motivo: null, organization_id: "org-1", api_token_id: "tok-1", concessao_id: "con-1", escopos: ["mcp:read", "mcp:write"] }],
      error: null,
    };
    const resp = await post(troca);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    const corpo = (await resp.json()) as Record<string, unknown>;
    expect(corpo.token_type).toBe("Bearer");
    expect(corpo.access_token).toMatch(/^dsk_[0-9a-f]{8}_/);
    expect(corpo.refresh_token).toMatch(/^dsr_/);
    expect(corpo.scope).toBe("mcp:read mcp:write");
    expect(corpo.expires_in).toBe(3600);

    const rpc = h.rpcs.find((r) => r.nome === "fn_mcp_oauth_trocar_codigo")!;
    expect(rpc.args.p_cliente).toBe(CLIENTE.id);
    expect(rpc.args.p_code_verifier).toBe(troca.code_verifier);
    const valores = JSON.stringify(rpc.args);
    expect(valores).not.toContain(corpo.access_token as string);
    expect(valores).not.toContain(corpo.refresh_token as string);
    expect(valores).not.toContain("dco_codigo");
    expect(h.auditadas[0]).toMatchObject({ action: "mcp_oauth.token_emitido", actorApiTokenId: "tok-1", organizationId: "org-1" });
  });

  it("recusa do banco vira invalid_grant, sem token", async () => {
    h.rpcResposta = { data: [{ motivo: "invalid_grant", organization_id: null, api_token_id: null, concessao_id: null, escopos: null }], error: null };
    const resp = await post(troca);
    expect(resp.status).toBe(400);
    const corpo = (await resp.json()) as Record<string, unknown>;
    expect(corpo.error).toBe("invalid_grant");
    expect(corpo.access_token).toBeUndefined();
    expect(h.auditadas).toHaveLength(0);
  });

  it("sem code_verifier: invalid_request, e o banco nem é consultado", async () => {
    const { code_verifier: _v, ...semVerifier } = troca;
    const resp = await post(semVerifier);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_request");
    expect(h.rpcs).toHaveLength(0);
  });

  it("cliente desconhecido: 401 invalid_client", async () => {
    const resp = await post({ ...troca, client_id: `dcc_${"b".repeat(32)}` });
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { error: string }).error).toBe("invalid_client");
  });

  it("cliente com segredo sem o segredo: 401", async () => {
    h.clientes.set(CLIENT_ID, { ...CLIENTE, metodo_de_autenticacao: "client_secret_post", client_secret_hash: "\\x" + "0".repeat(64) });
    const resp = await post(troca);
    expect(resp.status).toBe(401);
  });

  it("grant_type desconhecido: unsupported_grant_type", async () => {
    const resp = await post({ grant_type: "password", client_id: CLIENT_ID });
    expect(((await resp.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });

  it("renovação rotaciona e audita token_renovado", async () => {
    h.rpcResposta = { data: [{ motivo: null, organization_id: "org-1", api_token_id: "tok-1", concessao_id: "con-1", escopos: ["mcp:read"] }], error: null };
    const resp = await post({ grant_type: "refresh_token", refresh_token: "dsr_velho", client_id: CLIENT_ID, scope: "mcp:read" });
    expect(resp.status).toBe(200);
    const rpc = h.rpcs.find((r) => r.nome === "fn_mcp_oauth_renovar")!;
    expect(rpc.args.p_escopos).toEqual(["mcp:read"]);
    expect(rpc.args.p_refresh_hash).not.toBe(rpc.args.p_novo_refresh_hash);
    expect(h.auditadas[0]!.action).toBe("mcp_oauth.token_renovado");
  });

  it("teto de tokens da organização: a mensagem do banco chega ao cliente", async () => {
    h.rpcResposta = { data: null, error: { code: "PT409", message: "Teto de tokens ativos por organização atingido: 50 de 50." } };
    const resp = await post(troca);
    const corpo = (await resp.json()) as { error: string; error_description: string };
    expect(corpo.error).toBe("temporarily_unavailable");
    expect(corpo.error_description).toContain("Teto de tokens");
  });
});

describe("POST /api/mcp/oauth/revoke", () => {
  it("token desconhecido também é 200 (RFC 7009 §2.2) e não audita", async () => {
    h.rpcResposta = { data: [], error: null };
    const { POST } = await import("./revoke/route");
    const resp = await POST(
      new Request("http://x", {
        method: "POST",
        body: form({ token: "dsr_qualquer", client_id: CLIENT_ID }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(resp.status).toBe(200);
    expect(h.auditadas).toHaveLength(0);
    expect(h.rpcs[0]!.args.p_cliente).toBe(CLIENTE.id);
  });

  it("revogação efetiva audita mcp_oauth.revogado", async () => {
    h.rpcResposta = { data: [{ organization_id: "org-1", api_token_id: "tok-1", concessao_id: "con-1" }], error: null };
    const { POST } = await import("./revoke/route");
    await POST(
      new Request("http://x", {
        method: "POST",
        body: form({ token: "dsr_qualquer", client_id: CLIENT_ID }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(h.auditadas[0]).toMatchObject({ action: "mcp_oauth.revogado", organizationId: "org-1" });
  });
});

describe("POST /api/v1/mcp/oauth/consentir", () => {
  const ORG = "22222222-2222-4222-8222-222222222222";
  const corpo = (extra: Record<string, string> = {}) => ({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: DESAFIO,
    code_challenge_method: "S256",
    state: "st-9",
    scope: "mcp:read mcp:write",
    organization_id: ORG,
    acesso: "leitura_e_escrita",
    decisao: "permitir",
    ...extra,
  });
  const admin = { ok: true, user: { id: "u-1", idioma: "pt-BR", support: null }, org: { orgId: ORG, role: "admin" } };
  const post = async (b: Record<string, string>) => {
    const { POST } = await import("@/app/api/v1/mcp/oauth/consentir/route");
    return POST(new NextRequest("http://localhost:3000/api/v1/mcp/oauth/consentir", { method: "POST", body: JSON.stringify(b) }));
  };

  it("permitir: guarda o hash do código e devolve a volta com code, state e iss", async () => {
    h.authz = admin;
    const resp = await post(corpo());
    expect(resp.status).toBe(200);
    const destino = new URL(((await resp.json()) as { data: { redirect_to: string } }).data.redirect_to);
    const codigo = destino.searchParams.get("code")!;
    expect(codigo).toMatch(/^dco_/);
    expect(destino.searchParams.get("state")).toBe("st-9");
    const linha = h.inserts.find((i) => i.tabela === "mcp_oauth_codigos")!.payload;
    expect(linha.codigo_hash).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(JSON.stringify(linha)).not.toContain(codigo);
    expect(linha.escopos).toEqual(["mcp:read", "mcp:write"]);
    expect(linha.organization_id).toBe(ORG);
    expect(linha.user_id).toBe("u-1");
    expect(h.auditadas[0]).toMatchObject({ action: "mcp_oauth.autorizado", actorUserId: "u-1", organizationId: ORG });
  });

  it("negar: volta com access_denied e não emite código", async () => {
    h.authz = admin;
    const resp = await post(corpo({ decisao: "negar" }));
    const destino = new URL(((await resp.json()) as { data: { redirect_to: string } }).data.redirect_to);
    expect(destino.searchParams.get("error")).toBe("access_denied");
    expect(h.inserts).toHaveLength(0);
    expect(h.auditadas[0]!.action).toBe("mcp_oauth.negado");
  });

  it("escrita que o aplicativo não pediu não é concedida", async () => {
    h.authz = admin;
    const resp = await post(corpo({ scope: "mcp:read" }));
    expect(resp.status).toBe(400);
    expect(h.inserts).toHaveLength(0);
  });

  it("quem não é admin da organização recebe a recusa de requireRole, sem código", async () => {
    h.authz = { ok: false, response: new Response("{}", { status: 403 }) };
    const resp = await post(corpo());
    expect(resp.status).toBe(403);
    expect(h.inserts).toHaveLength(0);
  });

  it("acompanhamento de suporte não conecta aplicativo", async () => {
    h.authz = { ...admin, user: { ...admin.user, support: { status: "active" } } };
    const resp = await post(corpo());
    expect(resp.status).toBe(403);
    expect(h.inserts).toHaveLength(0);
  });

  it("redirect_uri fora do registro do cliente: 404, sem código", async () => {
    h.authz = admin;
    const resp = await post(corpo({ redirect_uri: "https://evil.example/cb" }));
    expect(resp.status).toBe(404);
    expect(h.inserts).toHaveLength(0);
  });
});
