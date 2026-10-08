// @vitest-environment node
/**
 * Os ITENS 1 a 5 do desenho do mantenedor (#2147) no ponto de entrada do
 * cadastro — a Server Action `definirServidorMcpExterno`:
 *
 *  1. quem cadastra é o DONO DA INSTALAÇÃO (`regraPlatformAdmin`, a mesma das
 *     extensões), e o gate vem ANTES da validação de forma;
 *  2. o registro continua POR ORGANIZAÇÃO: a linha gravada é a da organização
 *     ativa na sessão, nunca um id que o corpo do pedido tenha mandado;
 *  3. a chave sai do `organizations.settings` (jsonb que a RLS entrega a todo
 *     membro) e vai CIFRADA para as colunas `mcp_externo_chave_*`;
 *  4. o endereço passa pelo guard anti-SSRF dos webhooks já no cadastro;
 *  5. a trilha de auditoria leva SÓ o host — `api_audit_log` é append-only.
 *
 * Os mocks cobrem fronteiras (sessão, banco, auditoria); a REGRA de permissão,
 * a CIFRAGEM e o GUARD anti-SSRF são os de produção — trocá-los aqui tornaria
 * o teste mudo justamente sobre o que ele afirma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => {
  // Tem de existir ANTES de qualquer import: `lib/env.ts` lê o processo no
  // carregamento do módulo, e é ele que entrega a chave de cifragem ao AES.
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
  return {
    usuario: null as Record<string, unknown> | null,
    org: { orgId: "0be7a70c-0000-4000-8000-000000000001", name: "Org Ativa" } as {
      orgId: string;
      name: string;
    } | null,
    aal: "aal2" as string,
    plataforma: { scope: "full", mfa_required: false } as {
      scope: string;
      mfa_required: boolean;
    } | null,
    plataformaErro: null as { message: string } | null,
    linha: null as Record<string, unknown> | null,
    updates: [] as Array<Record<string, unknown>>,
    eqs: [] as Array<[string, unknown]>,
    selects: [] as string[],
    audits: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => estado.usuario),
  resolveActiveOrg: vi.fn(async () => estado.org),
  mfaEmDivida: vi.fn(async () => false),
  sessionAal: vi.fn(async () => estado.aal),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (evento: Record<string, unknown>) => {
    estado.audits.push(evento);
  }),
}));

/** Cadeia thenable + encadeável: serve o SELECT (`eq().maybeSingle()`) e o UPDATE (`await .eq()`). */
function cadeia() {
  const c = {
    select: (colunas?: string) => {
      if (colunas) estado.selects.push(colunas);
      return c;
    },
    update: (payload: Record<string, unknown>) => {
      estado.updates.push(payload);
      return c;
    },
    eq: (coluna: string, valor: unknown) => {
      estado.eqs.push([coluna, valor]);
      return c;
    },
    maybeSingle: async () => ({ data: estado.linha, error: null }),
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ error: null }).then(ok, ko),
  };
  return c;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => cadeia() }) }));
vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    createClient: vi.fn(async () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => ({
              maybeSingle: async () => ({
                data: estado.plataforma,
                error: estado.plataformaErro,
              }),
            }),
          }),
        }),
      }),
    })),
  };
});

import { definirServidorMcpExterno } from "@/app/actions/settings/definirServidorMcpExterno";
import { decryptKey, byteaToBuffer } from "@/lib/crypto/aes_gcm";

const ORG = "0be7a70c-0000-4000-8000-000000000001";
const CHAVE = "segredo-do-erp-abcd";

function adminDaInstalacao() {
  estado.usuario = {
    id: "11111111-1111-4111-8111-111111111111",
    is_platform_admin: true,
    support: null,
    idioma: "pt",
  };
}

beforeEach(() => {
  estado.usuario = { id: "11111111-1111-4111-8111-111111111111", is_platform_admin: true, support: null, idioma: "pt" };
  estado.org = { orgId: ORG, name: "Org Ativa" };
  estado.aal = "aal2";
  estado.plataforma = { scope: "full", mfa_required: false };
  estado.plataformaErro = null;
  estado.linha = { settings: { conversions: { meta_page_id: "111" } } };
  estado.updates = [];
  estado.eqs = [];
  estado.selects = [];
  estado.audits = [];
});

// ─── Item 1: quem cadastra ───────────────────────────────────────────────────

describe("quem cadastra é o dono da instalação, e o gate vem antes da forma (item 1)", () => {
  it("sem sessão: unauthenticated", async () => {
    estado.usuario = null;
    expect(await definirServidorMcpExterno({ endpoint: "https://erp.loja/mcp", chave: CHAVE })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });

  it("quem não é platform admin recebe RECUSA DE PERMISSÃO mesmo com a forma inválida", async () => {
    estado.usuario = { id: "u", is_platform_admin: false, support: null, idioma: "pt" };
    // Entrada malformada de propósito: se o `safeParse` roda antes, isto vira
    // `validation_failed` e o operador aprende a regra errada.
    const resultado = await definirServidorMcpExterno({ endpoint: 123 } as never);
    expect(resultado).toEqual({ ok: false, error: "forbidden_role" });
    expect(estado.updates).toEqual([]);
  });

  it("sessão de suporte é recusada pela MESMA regra das extensões", async () => {
    estado.usuario = { id: "u", is_platform_admin: true, support: { ativo: true }, idioma: "pt" };
    expect(await definirServidorMcpExterno({ endpoint: "https://erp.loja/mcp", chave: CHAVE })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
  });

  it("escopo que não é `full` é recusado", async () => {
    estado.plataforma = { scope: "leitura", mfa_required: false };
    expect(await definirServidorMcpExterno({ endpoint: "https://erp.loja/mcp", chave: CHAVE })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
  });

  it("a plataforma cobra `aal2` quando a política dela pede", async () => {
    estado.plataforma = { scope: "full", mfa_required: true };
    estado.aal = "aal1";
    expect(await definirServidorMcpExterno({ endpoint: "https://erp.loja/mcp", chave: CHAVE })).toEqual({
      ok: false,
      error: "mfa_required",
    });
  });

  it("a recusa de permissão vem ANTES da organização ativa", async () => {
    estado.usuario = { id: "u", is_platform_admin: false, support: null, idioma: "pt" };
    estado.org = null;
    expect(await definirServidorMcpExterno({ endpoint: "https://erp.loja/mcp", chave: CHAVE })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
  });

  it("o dono da instalação com a forma certa grava", async () => {
    adminDaInstalacao();
    const resultado = await definirServidorMcpExterno({
      endpoint: "https://erp.loja/mcp",
      chave: CHAVE,
    });
    expect(resultado).toEqual({ ok: true, chaveUltimos4: "abcd" });
    expect(estado.updates).toHaveLength(1);
  });
});

// ─── Item 2: por organização ─────────────────────────────────────────────────

describe("o registro é da ORGANIZAÇÃO da sessão, nunca do corpo do pedido (item 2)", () => {
  it("grava na linha da organização ativa mesmo com `organization_id` no body", async () => {
    await definirServidorMcpExterno({
      endpoint: "https://erp.loja/mcp",
      chave: CHAVE,
      organization_id: "0be7a70c-0000-4000-8000-000000000099",
    } as never);

    // SELECT e UPDATE têm o MESMO filtro de linha — os dois pela organização
    // ativa, e nenhum pelo id que veio no corpo.
    const gravacoes = estado.eqs.filter(([coluna]) => coluna === "id");
    expect(gravacoes.length).toBeGreaterThanOrEqual(2);
    expect(gravacoes.every(([, valor]) => valor === ORG)).toBe(true);
    expect(JSON.stringify(estado.updates[0])).not.toContain("000000000099");
    // A leitura também é da mesma linha: um registro nunca é lido por outro id.
    expect(estado.selects[0]).toContain("settings");
  });
});

// ─── Item 3: chave cifrada ───────────────────────────────────────────────────

describe("a chave sai do jsonb e vai cifrada (item 3)", () => {
  it("as quatro colunas recebem a chave; o `settings.mcp_externo` fica SEM chave", async () => {
    await definirServidorMcpExterno({ endpoint: "https://erp.loja/mcp", chave: CHAVE });
    const payload = estado.updates[0]!;

    const settings = payload.settings as { mcp_externo?: Record<string, unknown>; conversions?: unknown };
    expect(settings.mcp_externo).toEqual({ endpoint: "https://erp.loja/mcp" });
    expect(settings.conversions).toEqual({ meta_page_id: "111" });

    expect(payload.mcp_externo_chave_encrypted).toMatch(/^\\x[0-9a-f]+$/i);
    expect(payload.mcp_externo_chave_iv).toMatch(/^\\x[0-9a-f]+$/i);
    expect(payload.mcp_externo_chave_tag).toMatch(/^\\x[0-9a-f]+$/i);
    expect(payload.mcp_externo_chave_last4).toBe("abcd");

    // A prova de que NADA em claro foi gravado no que a RLS entrega a todo mundo.
    expect(JSON.stringify(payload.settings)).not.toContain(CHAVE);

    // E o ciphertext ABRE com a chave de instalação — cifrar sem conseguir abrir
    // seria um apagão de credencial disfarçado de segurança.
    const aberta = decryptKey({
      ciphertext: byteaToBuffer(payload.mcp_externo_chave_encrypted as string),
      iv: byteaToBuffer(payload.mcp_externo_chave_iv as string),
      tag: byteaToBuffer(payload.mcp_externo_chave_tag as string),
    });
    expect(aberta).toBe(CHAVE);
  });

  it("apagar zera as colunas e o bolso, preservando os outros bolsos", async () => {
    await definirServidorMcpExterno({ endpoint: "", chave: "" });
    const payload = estado.updates[0]!;
    expect((payload.settings as Record<string, unknown>).mcp_externo).toBeUndefined();
    expect((payload.settings as Record<string, unknown>).conversions).toEqual({ meta_page_id: "111" });
    expect(payload.mcp_externo_chave_encrypted).toBeNull();
    expect(payload.mcp_externo_chave_last4).toBeNull();
  });
});

// ─── Item 4: anti-SSRF no cadastro ───────────────────────────────────────────

describe("o endereço passa pelo guard anti-SSRF já no cadastro (item 4)", () => {
  it.each([
    ["metadados da nuvem", "http://169.254.169.254/mcp"],
    ["rede interna", "http://192.168.1.10/mcp"],
    ["localhost", "http://localhost:3000/mcp"],
    ["ipv6 literal", "http://[::1]/mcp"],
  ])("%s: recusa e nada é gravado", async (_rotulo, endpoint) => {
    const resultado = await definirServidorMcpExterno({ endpoint, chave: CHAVE });
    expect(resultado).toEqual({ ok: false, error: "endpoint_inseguro" });
    expect(estado.updates).toEqual([]);
    expect(estado.audits).toEqual([]);
  });

  it("um host público continua sendo aceito (a recusa não é geral demais)", async () => {
    const resultado = await definirServidorMcpExterno({
      endpoint: "https://erp.loja/mcp",
      chave: CHAVE,
    });
    expect(resultado.ok).toBe(true);
  });
});

// ─── Item 5: sem segredo no endereço ────────────────────────────────────────

describe("o endereço não carrega segredo para a trilha (item 5)", () => {
  it("querystring é recusada no cadastro — `?token=` não vira dado eterno", async () => {
    const resultado = await definirServidorMcpExterno({
      endpoint: "https://erp.loja/mcp?token=super-secreto",
      chave: CHAVE,
    });
    expect(resultado).toEqual({ ok: false, error: "endpoint_inseguro" });
    expect(estado.updates).toEqual([]);
  });

  it("fragmento é recusado no cadastro", async () => {
    const resultado = await definirServidorMcpExterno({
      endpoint: "https://erp.loja/mcp#segredo",
      chave: CHAVE,
    });
    expect(resultado).toEqual({ ok: false, error: "endpoint_inseguro" });
  });

  it("usuário:senha embutido continua sendo recusado", async () => {
    const resultado = await definirServidorMcpExterno({
      endpoint: "https://***@erp.loja/mcp",
      chave: CHAVE,
    });
    expect(resultado).toEqual({ ok: false, error: "endpoint_inseguro" });
  });

  it("o audit leva SÓ o host, mesmo com caminho no endereço", async () => {
    await definirServidorMcpExterno({
      endpoint: "https://erp.loja:8443/mcp/v1/pedidos",
      chave: CHAVE,
    });
    const trilha = JSON.stringify(estado.audits);
    expect(estado.audits[0]!.metadata).toMatchObject({ endpoint: "erp.loja:8443", registrado: true });
    expect(trilha).not.toContain("/mcp/v1/pedidos");
    expect(trilha).not.toContain("https://");
    // E a CHAVE não entra na trilha nem junto do host.
    expect(trilha).not.toContain(CHAVE);
  });
});
