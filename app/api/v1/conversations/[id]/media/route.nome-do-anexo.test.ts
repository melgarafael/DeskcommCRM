// @vitest-environment node
//
// Multipart real (File/FormData) precisa do realm do Node — jsdom (default do
// projeto) tem File/FormData próprios que o parser de multipart do NextRequest
// (undici) não sabe ler. Mesmo pragma das outras rotas de upload.
/**
 * POST /api/v1/conversations/[id]/media — o nome ORIGINAL do anexo (#4457).
 *
 * O caminho no bucket nasce `out-<uuid>.<ext>` (dois arquivos com o mesmo nome
 * não podem se sobrescrever), e o envio usava o BASENAME dele como `filename`
 * do documento: o cliente recebia `out-3f9a2b.pdf` no lugar do nome que a
 * pessoa escolheu. A rota é o único ponto que ainda vê o `File` — depois dela
 * só existe o storage_path —, então é aqui que o nome tem de ser devolvido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NextRequest } from "next/server";

import { pedidoComTamanho } from "@/tests/helpers/pedido-com-tamanho";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveAuthDual } from "@/lib/api/auth-dual";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const CAMINHO = `http://localhost/api/v1/conversations/${CONV_ID}/media`;
const NOME_ORIGINAL =
  "Dom Travel - Voucher LOC 123456 - Nome do Passageiro - Maceió.pdf";

let storagePathEnviado: string | null = null;

/** Client falso: a conversa existe e é da org ativa. */
function conversaExistente() {
  const maybeSingle = vi.fn(async () => ({ data: { id: CONV_ID }, error: null }));
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = maybeSingle;
  return { from: vi.fn(() => chain) };
}

/** Bucket falso: guarda o caminho que a rota mandou subir. */
function bucketQueAceita() {
  const upload = vi.fn(async (caminho: string) => {
    storagePathEnviado = caminho;
    return { error: null };
  });
  return { storage: { from: vi.fn(() => ({ upload })) } };
}

function requisicaoDeUpload(nome: string): Promise<NextRequest> {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], nome, { type: "application/pdf" }),
  );
  return pedidoComTamanho(CAMINHO, { method: "POST", body: form });
}

const ctx = { params: Promise.resolve({ id: CONV_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  storagePathEnviado = null;
  const supabase = conversaExistente();
  vi.mocked(createAdminClient).mockReturnValue(bucketQueAceita() as never);
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    supabase,
    organizationId: ORG_ID,
    role: "agent",
    idioma: "pt-BR",
    actor: { type: "user", id: USER_ID, role: "agent" },
  } as never);
});

describe("POST /api/v1/conversations/[id]/media — nome do anexo (#4457)", () => {
  it("devolve o nome ORIGINAL do arquivo, com acentos, espaços e hífens", async () => {
    const { POST } = await import("./route");
    const res = await POST(await requisicaoDeUpload(NOME_ORIGINAL), ctx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { media_filename?: string } };
    expect(json.data.media_filename).toBe(NOME_ORIGINAL);
  });

  it("o caminho no bucket continua aleatório — o nome original não vira endereço", async () => {
    const { POST } = await import("./route");
    await POST(await requisicaoDeUpload(NOME_ORIGINAL), ctx);

    expect(storagePathEnviado).toMatch(
      new RegExp(`^${ORG_ID}/${CONV_ID}/out-[0-9a-f-]{36}\\.pdf$`),
    );
    expect(storagePathEnviado).not.toContain("Voucher");
  });
});
