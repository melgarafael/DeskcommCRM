import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import { getConversationHandler } from "@/app/api/v1/conversations/_handler";
import { listMessagesHandler } from "@/app/api/v1/messages/_handler";

/**
 * ESCONDER DO INBOX (spec 21, etapa 7 — critérios 1, 2 e 3).
 *
 * Conversa de pessoal não aparece na lista, na busca (nome, telefone E prévia)
 * nem nas contagens. O link direto dá 404 e o histórico recusa junto — a
 * conversa some de tudo, com o histórico inteiro no banco para a volta.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Tirar o `.not("contact_id", ...)` da lista mas manter o da busca: a busca
 *   por prévia acha a conversa escondida (critério 2 acusa pelo `.not`).
 * - Tirar o `.eq("is_personal", false)` da subconsulta de contatos: busca por
 *   nome/telefone volta a achar pessoal.
 * - Manter somando no counts: o badge diverge da lista (critério 3).
 * - Tirar o 404 do `getConversationHandler`: o caso "link direto dá 404" cai.
 * Linha para reverter: `app/api/v1/conversations/_handler.ts`,
 * `app/api/v1/conversations/counts/route.ts`, `app/api/v1/messages/_handler.ts`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const LISTA = semComentarios(fonte("app", "api", "v1", "conversations", "_handler.ts"));
const CONTAS = semComentarios(fonte("app", "api", "v1", "conversations", "counts", "route.ts"));
const HISTORICO = semComentarios(fonte("app", "api", "v1", "messages", "_handler.ts"));

describe("lista do inbox esconde pessoal (critério 1)", () => {
  it("a query principal exclui os contatos pessoais", () => {
    expect(LISTA).toMatch(/idsDeContatosPessoais/);
    expect(LISTA).toMatch(/\.not\("contact_id",\s*"in"/);
  });

  it("a primitiva de ids é a mesma da busca (uma régua só)", () => {
    expect(LISTA).toMatch(/export async function idsDeContatosPessoais/);
    expect(LISTA).toMatch(/\.eq\("is_personal",\s*true\)/);
  });
});

describe("busca zera para pessoal (critério 2: nome, telefone e prévia)", () => {
  it("a subconsulta de contatos filtra pessoal", () => {
    expect(LISTA).toMatch(/\.eq\("is_personal",\s*false\)/);
  });

  it("a prévia segue coberta pelo .not da query principal", () => {
    // Sem ids casados a busca por conteúdo segue sozinha — mas a conversa de
    // pessoal nunca está na query principal para ser achada por ela.
    expect(LISTA).toMatch(/\.not\("contact_id",\s*"in"/);
  });
});

describe("contagem cai junto com a lista (critério 3)", () => {
  it("toda contagem nasce com a mesma exclusão", () => {
    expect(CONTAS).toMatch(/idsDeContatosPessoais/);
    expect(CONTAS).toMatch(/\.not\("contact_id",\s*"in"/);
  });
});

describe("link direto e histórico recusam (defesa em profundidade)", () => {
  interface EloLeitura {
    eq(coluna: string, valor: unknown): EloLeitura;
    limit(n: number): EloLeitura;
    maybeSingle(): Promise<{ data: unknown; error: null }>;
  }
  function banco(conversa: unknown) {
    const q: EloLeitura = {
      eq: () => q,
      limit: () => q,
      async maybeSingle() {
        return { data: conversa, error: null };
      },
    };
    return { from: () => ({ select: () => q }) } as never;
  }
  // O histórico lê em DUAS consultas planas (sem embed, sem `maybeSingle` —
  // o dublê do invariante de paginação traduz a cadeia em SQL literal):
  // conversa → `contact_id`, contato → `is_personal`.
  function bancoHistorico(pessoal: boolean) {
    const q: EloLeitura & {
      then(ok: (v: { data: unknown[]; error: null }) => unknown): unknown;
    } = {
      eq: () => q,
      limit: () => q,
      async maybeSingle() {
        return { data: null, error: null };
      },
      then(ok) {
        return Promise.resolve(
          ok({ data: [{ contact_id: "ct-1", is_personal: pessoal }], error: null }),
        );
      },
    };
    return { from: () => ({ select: () => q }) } as never;
  }

  const ctx = {
    organization_id: "11111111-1111-4111-8111-111111111111",
    requestId: "req-1",
    idioma: "pt-BR",
    actor: { type: "user", id: "user-1" },
  } as never;

  const conversaPessoal = {
    id: "conversa-1",
    organization_id: "11111111-1111-4111-8111-111111111111",
    contacts: { is_personal: true },
  };
  const conversaNormal = {
    id: "conversa-1",
    organization_id: "11111111-1111-4111-8111-111111111111",
    contacts: { is_personal: false },
  };

  it("GET da conversa pessoal dá 404 (some até por link direto)", async () => {
    const err = await getConversationHandler(banco(conversaPessoal), ctx, "conversa-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
  });

  it("GET da conversa normal continua abrindo", async () => {
    const conv = await getConversationHandler(banco(conversaNormal), ctx, "conversa-1");
    expect((conv as { id: string }).id).toBe("conversa-1");
  });

  it("histórico da conversa pessoal é recusado com o mesmo 404", async () => {
    const err = await listMessagesHandler(bancoHistorico(true), ctx, "conversa-1", {
      limit: 50,
    } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("o corte do histórico está no fonte (duas consultas planas, antes de tudo)", () => {
    expect(HISTORICO).toMatch(/\.select\("contact_id"\)/);
    expect(HISTORICO).toMatch(/\.select\("is_personal"\)/);
  });
});
