import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Qual endereço o cron de fotos pede ao canal.
 *
 * `wa_identity` é GERADA com o telefone antes do lid (migration 0122). Num número
 * BR cujo `wa_id` não tem o nono dígito — comum em linhas antigas — derivar o
 * chatId dela produz `55AA9BBBBCCCC@c.us`, endereço que não existe no WhatsApp:
 * o provider responde `profilePictureURL: null`, o cron carimba "sem foto" e o
 * avatar nunca aparece. Medido numa instalação real: `check-exists` do WAHA
 * devolvia `{"numberExists":true,"chatId":"55AABBBBCCCC@c.us"}` (12 dígitos)
 * para um contato cujo `wa_identity` dizia 13, e o `@lid` do mesmo contato
 * devolvia a foto na hora.
 *
 * `wa_lid` não deriva de telefone, por isso vem primeiro — a MESMA ordem de
 * `resolveWahaChatId` (lib/waha/send.ts) e de `chatIdOf` (session-reconciler).
 */

const CONTATO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LID = "142704667287623";

/** O contato do lote — cada teste ajusta antes de chamar. */
let linhaDoContato: Record<string, unknown> = {};
/** Endereços que o cron pediu ao canal. */
const pedidos: string[] = [];

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/channels", () => ({
  DEFAULT_CHANNEL_PROVIDER: "waha",
  getAdapter: () => ({
    fetchProfilePictureUrl: async (input: { recipient: string }) => {
      pedidos.push(input.recipient);
      return "https://cdn.exemplo.invalid/foto.jpg";
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const dados =
          tabela === "contacts"
            ? [linhaDoContato]
            : { waha_session_name: "sessao-de-teste", provider: "waha" };
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) =>
                  Promise.resolve({ data: dados, error: null }).then(ok);
              }
              if (prop === "maybeSingle") return async () => ({ data: dados, error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      update: () => {
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) =>
                  Promise.resolve({ data: [{ id: CONTATO }], error: null }).then(ok);
              }
              if (prop === "select") {
                return () => Promise.resolve({ data: [{ id: CONTATO }], error: null });
              }
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      upsert: async () => ({ error: null }),
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";

beforeEach(() => {
  pedidos.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
  );
});

function chamar(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/cron/contact-avatars", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
}

describe("cron de fotos: qual endereço vai ao canal", () => {
  it("com wa_lid presente, pede pelo @lid — não pelo telefone do wa_identity", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      // O telefone tem o nono dígito; o wa_id real do contato não tem.
      wa_identity: "phone:+5587999577575",
      wa_lid: LID,
      phone_number: "+5587999577575",
      avatar_storage_path: null,
    };

    await chamar();

    expect(pedidos).toEqual([`${LID}@lid`]);
    // O endereço derivado do telefone é justamente o que não existe no WhatsApp.
    expect(pedidos).not.toContain("5587999577575@c.us");
  });

  it("sem wa_lid, continua caindo no wa_identity — retaguarda preservada", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };

    await chamar();

    expect(pedidos).toEqual(["5511999990000@c.us"]);
  });

  it("wa_identity no formato lid: também resolve para @lid", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: `lid:${LID}`,
      wa_lid: null,
      phone_number: null,
      avatar_storage_path: null,
    };

    await chamar();

    expect(pedidos).toEqual([`${LID}@lid`]);
  });
});
