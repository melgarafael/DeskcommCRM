import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { contactListQuerySchema } from "@/lib/schemas/contacts";

/**
 * LISTA DE CONTATOS EXCLUI PESSOAL POR PADRÃO + FILTRO "PESSOAIS"
 * (spec 21, etapa 13).
 *
 * `listContactsHandler` exclui pessoais por padrão; `?pessoais=true` lista SÓ
 * pessoais (a tela do filtro e o desmarcar). O MCP search herda o padrão, sem
 * parâmetro novo na ferramenta.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Default invertido (`.eq("is_personal", true)` sempre): a lista de Contatos
 *   esvazia para todo mundo — o caso "padrão exclui" cai.
 * - Tirar o filtro: pessoal aparece na lista e o mesmo caso cai.
 * - `z.coerce.boolean()` no schema: `?pessoais=false` vira `true` (toda string
 *   não-vazia é truthy) — o caso do schema cai.
 * Linha para reverter: `app/api/v1/contacts/_handler.ts`,
 * `lib/schemas/contacts.ts`, `app/api/v1/contacts/route.ts`,
 * `hooks/contacts/useContactList.ts`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "11111111-1111-4111-8111-111111111111";

function contato(id: string, pessoal: boolean) {
  return {
    id,
    organization_id: ORG,
    kind: "person",
    name: null,
    display_name: pessoal ? "Mãe" : "Cliente",
    email: null,
    email_normalized: null,
    phone_number: "+5511999999999",
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

/**
 * Fake que HONRA os filtros `.eq()` (não só registra): sem isso, o teste
 * provaria a chamada, não o comportamento — e o default invertido passaria.
 */
function banco() {
  const linhas = [contato("ct-pessoal", true), contato("ct-livre", false)];
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
              data: linhas.filter((r) =>
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

function ctx() {
  return {
    organization_id: ORG,
    actor: { type: "user", id: "u-1" },
    requestId: "req-1",
  } as never;
}

describe("lista padrão exclui; ?pessoais=true lista só pessoais", () => {
  it("padrão: pessoal não aparece, o normal aparece", async () => {
    const r = await listContactsHandler(banco(), ctx(), {});
    expect(r.contacts.map((c) => c.id)).toEqual(["ct-livre"]);
  });

  it("pessoais=true: SÓ pessoais", async () => {
    const r = await listContactsHandler(banco(), ctx(), { pessoais: true });
    expect(r.contacts.map((c) => c.id)).toEqual(["ct-pessoal"]);
  });

  it("pessoais=false explícito comporta-se como o padrão", async () => {
    const r = await listContactsHandler(banco(), ctx(), { pessoais: false });
    expect(r.contacts.map((c) => c.id)).toEqual(["ct-livre"]);
  });
});

describe("o schema entende os dois mundos (URL e MCP)", () => {
  it("ausente = excluir (o padrão da lista e do MCP search)", () => {
    expect(contactListQuerySchema.parse({}).pessoais).toBe(false);
  });

  it('"true"/"false" da URL decidem de verdade', () => {
    expect(contactListQuerySchema.parse({ pessoais: "true" }).pessoais).toBe(true);
    expect(contactListQuerySchema.parse({ pessoais: "false" }).pessoais).toBe(false);
  });

  it("boolean de verdade (MCP direto) também vale", () => {
    expect(contactListQuerySchema.parse({ pessoais: true }).pessoais).toBe(true);
  });

  it("valor inventado é 422, não silêncio", () => {
    expect(contactListQuerySchema.safeParse({ pessoais: "sim" }).success).toBe(false);
  });
});

describe("o parâmetro atravessa a rota e o hook", () => {
  it("a rota GET repassa ?pessoais ao handler", () => {
    const src = semComentarios(fonte("app", "api", "v1", "contacts", "route.ts"));
    expect(src).toMatch(/pessoais/);
  });

  it("o hook manda ?pessoais=true só quando ligado", () => {
    const src = semComentarios(fonte("hooks", "contacts", "useContactList.ts"));
    expect(src).toMatch(/pessoais/);
    expect(src).toMatch(/qs\.set\("pessoais", "true"\)/);
  });
});
