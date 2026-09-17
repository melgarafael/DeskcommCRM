/**
 * PATCH /api/v1/ai/credentials/:id — rotação da chave NO LUGAR.
 *
 * É o caminho que faltava: sem ele, trocar uma chave só tinha a saída
 * "excluir e recriar", e a exclusão é bloqueada pela FK quando alguma versão a
 * usa. Aqui se prova o essencial: a chave é cifrada (nunca gravada em claro),
 * a resposta não a devolve, e o rótulo colidido é tratado como no POST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Precisa existir ANTES de qualquer import: `lib/env.ts` lê o processo no
// carregamento do módulo, e é ele que entrega a chave de cifragem ao AES.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { PATCH } from "@/app/api/v1/ai/credentials/[id]/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { decryptKey, byteaToBuffer } from "@/lib/crypto/aes_gcm";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/provider-validators", () => ({
  validateProviderKey: vi.fn(async () => ({ ok: true, models: ["claude-x"] })),
}));

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const CHAVE_NOVA = "sk-ant-api03-NOVA-CHAVE-ABCD";

type Resposta = { data?: unknown; error?: unknown };
type Patch = Record<string, unknown>;
type Fake = {
  from: (table: string) => unknown;
  updates: Patch[];
};

function fakeAdmin(config: Record<string, Resposta>): Fake {
  const updates: Patch[] = [];
  return {
    updates,
    from(table: string) {
      let op = "select";
      const respond = () => config[`${table}:${op}`] ?? config[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (patch: Patch) => {
          op = "update";
          updates.push(patch);
          return chain;
        },
        insert: () => {
          op = "insert";
          return chain;
        },
        delete: () => {
          op = "delete";
          return chain;
        },
        maybeSingle: async () => respond(),
        single: async () => respond(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(respond()).then(resolve),
      };
      return chain;
    },
  };
}

const cred = {
  id,
  organization_id: org,
  provider: "anthropic",
  label: "Produção",
  api_key_last4: "old1",
};

/** Linha que a view segura devolveria — nunca tem campo cifrado. */
const segura = {
  id,
  organization_id: org,
  provider: "anthropic",
  label: "Produção",
  api_key_last4: "ABCD",
  validated_at: null,
  validation_error: null,
  models_available: null,
  is_active: true,
  created_by: "actor",
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};

function invocar(body: unknown) {
  return PATCH(new NextRequest(`http://localhost/api/v1/ai/credentials/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: org, role: "admin", name: "Org" },
    user: { id: "actor", idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("PATCH /api/v1/ai/credentials/:id", () => {
  it("troca a chave: cifra, marca para revalidar e a chave NOVA é a que decifra", async () => {
    const fake = fakeAdmin({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_provider_credentials:update": { data: { id }, error: null },
      "ai_provider_credentials_safe:select": { data: segura, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(fake as unknown as ReturnType<typeof createAdminClient>);

    const res = await invocar({ api_key: CHAVE_NOVA });
    expect(res.status).toBe(200);

    const patch = fake.updates[0] ?? {};
    // Cifrado de verdade: nada de plaintext coluna adentro.
    expect(JSON.stringify(patch)).not.toContain(CHAVE_NOVA);
    expect(patch.api_key_last4).toBe("ABCD");
    // O veredito anterior deixa de valer — a tela mostra "validando".
    expect(patch.validated_at).toBeNull();
    expect(patch.validation_error).toBeNull();
    expect(patch.models_available).toBeNull();

    // A chave que o agente vai usar é a nova: o round-trip real prova.
    const decifrada = decryptKey({
      ciphertext: byteaToBuffer(patch.api_key_encrypted),
      iv: byteaToBuffer(patch.api_key_iv),
      tag: byteaToBuffer(patch.api_key_tag),
    });
    expect(decifrada).toBe(CHAVE_NOVA);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.credential_updated",
        resourceId: id,
        organizationId: org,
      }),
    );
  });

  it("não vaza a chave na resposta (nem em claro, nem o campo cifrado)", async () => {
    const fake = fakeAdmin({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_provider_credentials:update": { data: { id }, error: null },
      "ai_provider_credentials_safe:select": { data: segura, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(fake as unknown as ReturnType<typeof createAdminClient>);

    const res = await invocar({ api_key: CHAVE_NOVA });
    const texto = JSON.stringify(await res.json());

    expect(texto).not.toContain(CHAVE_NOVA);
    expect(texto).not.toContain("api_key_encrypted");
    expect(texto).not.toContain("api_key_iv");
    expect(texto).not.toContain("api_key_tag");
    expect(JSON.parse(texto).data.api_key_last4).toBe("ABCD");
  });

  it("só renomear não mexe na chave nem dispara revalidação", async () => {
    const fake = fakeAdmin({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_provider_credentials:update": { data: { id }, error: null },
      "ai_provider_credentials_safe:select": { data: { ...segura, label: "Produção 2" }, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(fake as unknown as ReturnType<typeof createAdminClient>);

    const res = await invocar({ label: "Produção 2" });
    expect(res.status).toBe(200);

    const patch = fake.updates[0] ?? {};
    expect(patch.label).toBe("Produção 2");
    expect(patch.api_key_encrypted).toBeUndefined();
    expect(patch.validated_at).toBeUndefined();
  });

  it("rótulo colidido responde 409 como o POST", async () => {
    const fake = fakeAdmin({
      "ai_provider_credentials:select": { data: cred, error: null },
      "ai_provider_credentials:update": { data: null, error: { code: "23505", message: "duplicate key" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(fake as unknown as ReturnType<typeof createAdminClient>);

    const res = await invocar({ label: "Produção" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("label_already_used");
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem campo algum responde 422, sem tocar no banco", async () => {
    const fake = fakeAdmin({ "ai_provider_credentials:select": { data: cred, error: null } });
    vi.mocked(createAdminClient).mockReturnValue(fake as unknown as ReturnType<typeof createAdminClient>);

    const res = await invocar({});
    expect(res.status).toBe(422);
    expect(fake.updates).toHaveLength(0);
  });

  it("credencial de outra organização responde 404 e não grava", async () => {
    const fake = fakeAdmin({
      "ai_provider_credentials:select": { data: { ...cred, organization_id: "outra-org" }, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(fake as unknown as ReturnType<typeof createAdminClient>);

    const res = await invocar({ api_key: CHAVE_NOVA });
    expect(res.status).toBe(404);
    expect(fake.updates).toHaveLength(0);
  });
});
