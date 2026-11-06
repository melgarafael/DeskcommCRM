import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { contactListQuerySchema } from "@/lib/schemas/contacts";

/**
 * `GET /api/v1/contacts?blocked=yes|no` — A LISTA DE QUEM PEDIU PARA NÃO SER
 * INCOMODADO, e a de quem não pediu opt-out.
 *
 * Sem o filtro, o bloqueio (opt-out) existia só como etiqueta na linha: para
 * saber quem pediu era preciso percorrer a lista inteira a olho. O filtro
 * responde só pelo opt-out, não pela exclusão de campanha nem por anonimizados.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o `.eq("is_blocked", …)` do handler: `yes` e `no` devolvem os dois
 *   contatos — os dois casos do handler caem.
 * - Inverter (`q.blocked === "no"`): os mesmos dois caem, trocados.
 * Linha para reverter: `app/api/v1/contacts/_handler.ts`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "11111111-1111-4111-8111-111111111111";

function contato(id: string, bloqueado: boolean) {
  return {
    id,
    organization_id: ORG,
    kind: "person",
    name: null,
    display_name: bloqueado ? "Pediu para sair" : "Cliente",
    email: null,
    email_normalized: null,
    phone_number: "+5511999999999",
    cpf_hash: null,
    birthdate: null,
    is_blocked: bloqueado,
    blocked_reason: bloqueado ? "opt_out" : null,
    is_personal: false,
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
 * provaria a chamada, não o comportamento.
 */
function banco() {
  const linhas = [contato("ct-bloqueado", true), contato("ct-livre", false)];
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

const ids = (r: { contacts: Array<{ id: string }> }) => r.contacts.map((c) => c.id).sort();

describe("?blocked filtra pelo opt-out", () => {
  it("blocked=yes: SÓ quem pediu para não ser incomodado", async () => {
    const r = await listContactsHandler(banco(), ctx(), { blocked: "yes" });
    expect(ids(r)).toEqual(["ct-bloqueado"]);
  });

  it("blocked=no: SÓ quem não pediu opt-out", async () => {
    const r = await listContactsHandler(banco(), ctx(), { blocked: "no" });
    expect(ids(r)).toEqual(["ct-livre"]);
  });

  it("controle: sem o parâmetro a lista segue com os dois, como sempre", async () => {
    const r = await listContactsHandler(banco(), ctx(), {});
    expect(ids(r)).toEqual(["ct-bloqueado", "ct-livre"]);
  });
});

describe("o schema e a rota", () => {
  it("valor inventado é 422, não silêncio", () => {
    expect(contactListQuerySchema.safeParse({ blocked: "true" }).success).toBe(false);
    expect(contactListQuerySchema.safeParse({ blocked: "yes" }).success).toBe(true);
  });

  it("a rota GET repassa ?blocked ao handler", () => {
    const src = semComentarios(fonte("app", "api", "v1", "contacts", "route.ts"));
    expect(src).toMatch(/blocked: url\.searchParams\.get\("blocked"\)/);
  });

  it("a exportação também: exportar é exportar o que a lista mostra", () => {
    const src = semComentarios(fonte("app", "api", "v1", "contacts", "export", "route.ts"));
    expect(src).toMatch(/blocked: url\.searchParams\.get\("blocked"\)/);
  });
});
