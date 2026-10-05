import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cache do redirect da foto de perfil — GET /api/v1/contacts/{id}/avatar.
 *
 * A rota é chamada uma vez por contato COM foto a cada render da lista de
 * conversas, e cada chamada custa sessão + organização ativa + SELECT em
 * `contacts` + `createSignedUrl`. Sem `Cache-Control` o browser não guarda nada
 * e a cadeia inteira se repete a cada refresh — medido em ~73ms de servidor por
 * foto, ~3s por carga numa instalação com 39 contatos com foto.
 *
 * O que se prova aqui:
 *  - o 307 carrega `Cache-Control` com `private` e um `max-age` positivo;
 *  - `max-age` é MENOR que a vida da assinatura (senão o browser reusa um
 *    redirect que aponta pra URL vencida e a foto some);
 *  - `private` está presente — a autorização é por organização da sessão, e um
 *    cache compartilhado serviria o rosto de um contato a outro tenant;
 *  - o 404 de "sem foto"/anonimizado NÃO é cacheado: anonimização é irreversível
 *    por contrato e não pode ficar presa num cache que a antecede.
 *
 * O client é falsificado; o handler roda de verdade.
 */

const SIGNED_URL = "https://storage.example/assinada?token=abc";

let contatoRow: { avatar_storage_path: string | null; is_anonimizado: boolean } | null = null;
let orgAtiva: { orgId: string; org_status: string } | null = { orgId: "org-1", org_status: "active" };
let erroDeAssinatura: { message: string } | null = null;

// A assinatura tipada importa: o teste do TTL lê o 2º argumento que o handler
// passou, e com `vi.fn(async () => ...)` esse índice não existe no tipo.
const createSignedUrl = vi.fn(async (_caminho: string, _ttlSegundos: number) =>
  erroDeAssinatura
    ? { data: null, error: erroDeAssinatura }
    : { data: { signedUrl: SIGNED_URL }, error: null },
);

/** Imita o query builder do PostgREST: encadeável, resolve no `maybeSingle()`. */
function chain(): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({
            data: contatoRow
              ? {
                  avatar_storage_path: contatoRow.avatar_storage_path,
                  is_anonymized: contatoRow.is_anonimizado,
                }
              : null,
            error: null,
          });
        }
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: async () => ({ id: "user-1" }),
  orgAtivaSemPortao: async () => orgAtiva,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => chain() }),
    storage: { from: () => ({ createSignedUrl }) },
  }),
}));

const { GET } = await import("@/app/api/v1/contacts/[id]/avatar/route");

function chamar(id = "contato-1") {
  return GET({} as never, { params: Promise.resolve({ id }) });
}

describe("GET /api/v1/contacts/{id}/avatar — cache do redirect", () => {
  beforeEach(() => {
    contatoRow = { avatar_storage_path: "org-1/avatars/contato-1.jpg", is_anonimizado: false };
    orgAtiva = { orgId: "org-1", org_status: "active" };
    erroDeAssinatura = null;
    createSignedUrl.mockClear();
  });

  it("responde 307 para a URL assinada", async () => {
    const res = await chamar();
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe(SIGNED_URL);
  });

  it("manda Cache-Control — sem isso a lista refaz a rota inteira por foto a cada render", async () => {
    const res = await chamar();
    const cc = res.headers.get("Cache-Control");

    expect(cc, "o 307 precisa de Cache-Control ou o browser não guarda nada").toBeTruthy();
    expect(cc).toMatch(/max-age=\d+/);
    expect(Number(/max-age=(\d+)/.exec(cc ?? "")?.[1])).toBeGreaterThan(0);
  });

  it("marca o cache como private — a autorização é por organização da sessão", async () => {
    const res = await chamar();
    const cc = res.headers.get("Cache-Control") ?? "";

    expect(cc, "cache compartilhado serviria a foto de um tenant a outro").toContain("private");
    expect(cc).not.toContain("public");
  });

  it("expira o cache ANTES da assinatura, senão o redirect guardado aponta pra URL vencida", async () => {
    const res = await chamar();
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1]);

    // A vida da assinatura é o argumento passado ao createSignedUrl pelo próprio
    // handler — lido dele, não copiado, para o teste não descolar da constante.
    const ttlAssinatura = createSignedUrl.mock.calls[0]?.[1];

    expect(ttlAssinatura, "o handler precisa ter assinado a URL").toBeDefined();
    expect(ttlAssinatura ?? 0).toBeGreaterThan(0);
    expect(maxAge).toBeLessThan(ttlAssinatura ?? 0);
  });

  it("não cacheia o 404 de contato sem foto", async () => {
    contatoRow = { avatar_storage_path: null, is_anonimizado: false };
    const res = await chamar();

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/max-age=[1-9]/);
  });

  it("não cacheia o 404 de contato anonimizado — anonimização é irreversível", async () => {
    contatoRow = { avatar_storage_path: "org-1/avatars/contato-1.jpg", is_anonimizado: true };
    const res = await chamar();

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/max-age=[1-9]/);
  });

  it("não cacheia quando a assinatura falha", async () => {
    erroDeAssinatura = { message: "storage indisponível" };
    const res = await chamar();

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/max-age=[1-9]/);
  });
});
