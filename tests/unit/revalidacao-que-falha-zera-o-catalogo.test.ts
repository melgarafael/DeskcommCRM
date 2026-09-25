/**
 * POST /api/v1/ai/credentials/:id/revalidate — quando a revalidação FALHA, o
 * catálogo de modelos é zerado.
 *
 * ─── O defeito que este arquivo guarda ────────────────────────────────────
 *
 * O ramo de falha gravava `validated_at: null` e `validation_error`, e deixava
 * `models_available` como estava. A lista fica da validação ANTERIOR, e a tela
 * a mostra: `CredentialCard.tsx` desenha `credential.models_available?.length`
 * ao lado da mensagem de erro. Quem olha vê "Falha na validação" e, embaixo,
 * uma contagem de modelos — uma credencial que deixou de ser confiável com
 * cara de credencial pronta.
 *
 * Recorte do PR #714, de @betoarts. O commit dele não trouxe teste; este
 * arquivo é da triagem, e existe porque a diferença no diff é de uma linha e o
 * efeito dela só aparece na segunda revalidação.
 *
 * ─── Por que o caso de SUCESSO está aqui ──────────────────────────────────
 *
 * Sem ele, zerar sempre passaria: a guarda ficaria verde com o defeito oposto,
 * que é pior (o usuário perde o catálogo de uma credencial que FUNCIONA).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/v1/ai/credentials/[id]/revalidate/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateProviderKey } from "@/lib/ai/provider-validators";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/provider-validators", () => ({ validateProviderKey: vi.fn() }));
// A decifragem não é o assunto deste arquivo: o que se mede é o que vai para o
// UPDATE depois que o provider responde.
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "sk-decifrada",
}));

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";

type Resposta = { data?: unknown; error?: unknown };
type Patch = Record<string, unknown>;

function fakeAdmin(config: Record<string, Resposta>) {
  const updates: Patch[] = [];
  return {
    updates,
    from(table: string) {
      let op = "select";
      const respond = () => config[`${table}:${op}`] ?? config[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        update: (patch: Patch) => {
          op = "update";
          updates.push(patch);
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

/** A linha bruta que a rota lê antes de decifrar. */
const linha = {
  id,
  organization_id: org,
  provider: "anthropic",
  label: "Produção",
  api_key_encrypted: "\\x00",
  api_key_iv: "\\x00",
  api_key_tag: "\\x00",
  is_active: true,
};

/** O que a view segura devolve depois do UPDATE — o corpo da resposta. */
const segura = {
  id,
  organization_id: org,
  provider: "anthropic",
  label: "Produção",
  api_key_last4: "ABCD",
  validated_at: null,
  validation_error: "unauthorized",
  models_available: null,
  is_active: true,
  created_by: "actor",
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
};

function invocar() {
  return POST(
    new NextRequest(`http://localhost/api/v1/ai/credentials/${id}/revalidate`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

function admindeMentira() {
  const fake = fakeAdmin({
    "ai_provider_credentials:select": { data: linha, error: null },
    "ai_provider_credentials:update": { data: segura, error: null },
  });
  vi.mocked(createAdminClient).mockReturnValue(fake as unknown as ReturnType<typeof createAdminClient>);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: org, role: "admin", name: "Org" },
    user: { id: "actor", idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("POST /api/v1/ai/credentials/:id/revalidate", () => {
  it("falhou: zera o catálogo junto com o carimbo de validação", async () => {
    vi.mocked(validateProviderKey).mockResolvedValue({ ok: false, error: "unauthorized" } as Awaited<
      ReturnType<typeof validateProviderKey>
    >);
    const fake = admindeMentira();

    const res = await invocar();
    expect(res.status).toBe(200);

    const patch = fake.updates[0] ?? {};
    expect(patch).toMatchObject({ validated_at: null, validation_error: "unauthorized" });
    expect(
      patch.models_available,
      "o catálogo da validação anterior sobreviveu à falha: a tela mostra a contagem antiga ao lado do erro",
    ).toBeNull();
    expect("models_available" in patch, "o UPDATE nem tocou em models_available").toBe(true);
  });

  it("CONTROLE POSITIVO — deu certo: o catálogo é o que o provider devolveu, não nulo", async () => {
    vi.mocked(validateProviderKey).mockResolvedValue({
      ok: true,
      models: ["claude-sonnet-5", "claude-haiku-4-5"],
    } as Awaited<ReturnType<typeof validateProviderKey>>);
    const fake = admindeMentira();

    const res = await invocar();
    expect(res.status).toBe(200);

    const patch = fake.updates[0] ?? {};
    expect(patch.models_available).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
    expect(patch.validation_error).toBeNull();
  });
});
