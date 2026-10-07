import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { idsDeContatosPessoais } from "@/app/api/v1/conversations/_handler";

/**
 * ISOLAMENTO ENTRE ORGANIZAÇÕES (spec 21 — anti-pattern 10).
 *
 * A org A marca o contato; a org B, com o MESMO telefone, não muda nada: a
 * lista da B continua cheia e os ids de pessoais da A nunca carregam os da B.
 * Toda query da feature filtra `organization_id` manualmente (service role
 * bypassa RLS).
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Tirar o `.eq("organization_id", ...)` dos ids pessoais: a lista da A
 *   passa a esconder conversa da B — o caso "ids são da org" cai.
 * - Tirar o filtro de org da lista: a B enxerga contato da A — o caso
 *   "a B nada muda" cai.
 * Linha para reverter: `app/api/v1/contacts/_handler.ts`,
 * `app/api/v1/conversations/_handler.ts` (`idsDeContatosPessoais`).
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FONE = "+5511999999999";

function contato(org: string, id: string, pessoal: boolean) {
  return {
    id,
    organization_id: org,
    kind: "person",
    name: null,
    display_name: id,
    email: null,
    email_normalized: null,
    phone_number: FONE,
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_personal: pessoal,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    last_activity_at: "2026-10-02T00:00:00.000Z",
    first_service_at: null,
  };
}

const LINHAS = [
  contato(ORG_A, "a-pessoal", true),
  contato(ORG_A, "a-livre", false),
  contato(ORG_B, "b-pessoal", true),
  contato(ORG_B, "b-livre", false),
];

/** Fake que honra `.eq()` de organização e de pessoal, como o PostgREST. */
function banco() {
  return {
    from: (tabela: string) => ({
      select: () => {
        if (tabela === "conversations") {
          const q: {
            eq: () => unknown;
            in: () => unknown;
            order: () => Promise<{ data: unknown[]; error: null }>;
          } = {
            eq: () => q,
            in: () => q,
            order: () => Promise.resolve({ data: [], error: null }),
          };
          return q;
        }
        const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
        const q: {
          eq: (coluna: string, valor: unknown) => unknown;
          is: () => unknown;
          or: () => unknown;
          contains: () => unknown;
          order: () => unknown;
          limit: () => unknown;
          then: (ok: (v: unknown) => unknown) => unknown;
        } = {
          eq: (coluna, valor) => {
            filtros.push((r) => r[coluna] === valor);
            return q;
          },
          is: () => q,
          or: () => q,
          contains: () => q,
          order: () => q,
          limit: () => q,
          then: (ok) =>
            Promise.resolve({
              data: LINHAS.filter((r) =>
                filtros.every((f) => f(r as unknown as Record<string, unknown>)),
              ),
              error: null,
            }).then(ok),
        };
        return q;
      },
    }),
  } as never;
}

function ctx(org: string) {
  return {
    organization_id: org,
    actor: { type: "user", id: "u-1" },
    requestId: "req-1",
  } as never;
}

describe("org A marca; org B com o mesmo telefone nada muda", () => {
  it("lista padrão da A: só o livre da A", async () => {
    const r = await listContactsHandler(banco(), ctx(ORG_A), {});
    expect(r.contacts.map((c) => c.id)).toEqual(["a-livre"]);
  });

  it("lista padrão da B: só o livre da B (nada da A vaza para cá)", async () => {
    const r = await listContactsHandler(banco(), ctx(ORG_B), {});
    expect(r.contacts.map((c) => c.id).sort()).toEqual(["b-livre"]);
  });

  it("filtro pessoais da A: só o pessoal da A", async () => {
    const r = await listContactsHandler(banco(), ctx(ORG_A), { pessoais: true });
    expect(r.contacts.map((c) => c.id)).toEqual(["a-pessoal"]);
  });

  it("ids de pessoais da A não carregam os da B", async () => {
    const ids = await idsDeContatosPessoais(banco(), ORG_A);
    expect(ids).toEqual(["a-pessoal"]);
  });
});
