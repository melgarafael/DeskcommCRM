/**
 * AS FUNÇÕES, CHAMADAS DIRETO — sem `NextRequest`, sem `Response`.
 *
 * `app/api/v1/agenda/tipos/route.test.ts` mede a borda HTTP. Este arquivo mede o
 * contrato de `alterarTipoDeAgendamento` e `desativarTipoDeAgendamento` — o que o
 * servidor MCP chama. O que se prende:
 *
 * 1. **`is_active` continua DESCARTADO no PATCH**: mandar só ele é 422 "Nenhum
 *    campo para alterar.", e nenhuma escrita sai. A volta segue sendo
 *    `/agenda/tipos/reativar`.
 * 2. **A organização B não altera o tipo da A** — 404, e a linha da A termina
 *    como começou (o admin bypassa a RLS; o filtro é a única proteção).
 * 3. **Desativar é `is_active = false`**, nunca delete.
 * 4. **A recusa vem antes da escrita**, e a trilha registra os campos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { alterarSchema, alterarTipoDeAgendamento, desativarTipoDeAgendamento } from "./tipos-de-agendamento";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const TIPO = "44444444-4444-4444-8444-444444444444";
const TIPO_DA_OUTRA = "55555555-5555-4555-8555-555555555555";
const CANAL = "77777777-7777-4777-8777-777777777777";

type Linha = Record<string, unknown> & { id: string; organization_id: string };

function adminFake(linhas: Linha[], canais: Linha[] = []) {
  const escritas: Array<{ op: "update"; campos: Record<string, unknown>; filtros: Record<string, unknown> }> = [];

  const db = {
    from(tabela: string) {
      if (tabela !== "calendar_event_types") {
        const filtros: Record<string, unknown> = {};
        const api = {
          select: () => api,
          eq(k: string, v: unknown) {
            filtros[k] = v;
            return api;
          },
          maybeSingle: async () => ({
            data:
              canais.find((c) => Object.entries(filtros).every(([k, v]) => c[k] === v)) ?? null,
            error: null,
          }),
        };
        return api;
      }
      const filtros: Record<string, unknown> = {};
      let campos: Record<string, unknown> | null = null;
      const api = {
        update(c: Record<string, unknown>) {
          campos = c;
          return api;
        },
        eq(k: string, v: unknown) {
          filtros[k] = v;
          return api;
        },
        select: () => api,
        // A escrita é APLICADA aqui, com os filtros já montados — é o que faz o
        // caso de isolamento medir a função e não o dublê.
        maybeSingle: async () => {
          const alvo = linhas.filter((l) =>
            Object.entries(filtros).every(([k, v]) => l[k] === v),
          );
          if (campos) {
            escritas.push({ op: "update", campos, filtros });
            for (const l of alvo) Object.assign(l, campos);
          }
          return { data: alvo[0] ? { id: alvo[0].id } : null, error: null };
        },
      };
      return api;
    },
  };
  return { escritas, db };
}

function ator(over: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" } as never,
    apiTokenId: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("alterarTipoDeAgendamento", () => {
  it("grava os campos e audita com a lista deles", async () => {
    const linha: Linha = { id: TIPO, organization_id: ORG, reminder_enabled: false };
    const { db } = adminFake([linha]);

    const r = await alterarTipoDeAgendamento(
      db as never,
      ator(),
      alterarSchema.parse({ id: TIPO, reminder_enabled: true, reminder_minutes_before: 120 }),
    );

    expect(r).toEqual({ ok: true, data: { id: TIPO } });
    expect(linha.reminder_enabled).toBe(true);
    expect(linha.reminder_minutes_before).toBe(120);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.tipo_alterado",
        resourceId: TIPO,
        metadata: { campos: ["reminder_enabled", "reminder_minutes_before"] },
      }),
    );
  });

  it("⚠️ `is_active` no PATCH continua DESCARTADO — 422, sem escrita", async () => {
    const linha: Linha = { id: TIPO, organization_id: ORG, is_active: true };
    const { escritas, db } = adminFake([linha]);

    // O Zod descarta a chave sem dizer nada; o que sobra é "nenhum campo".
    const entrada = alterarSchema.parse({ id: TIPO, is_active: false });
    expect(entrada).not.toHaveProperty("is_active");

    const r = await alterarTipoDeAgendamento(db as never, ator(), entrada);

    expect(r).toEqual({
      ok: false,
      code: "validation_failed",
      status: 422,
      message: "Nenhum campo para alterar.",
    });
    expect(escritas).toEqual([]);
    expect(linha.is_active).toBe(true);
  });

  it("canal de OUTRA organização é 422 antes de escrever", async () => {
    const { escritas, db } = adminFake(
      [{ id: TIPO, organization_id: ORG }],
      [{ id: CANAL, organization_id: OUTRA_ORG, provider: "whatsapp_cloud", archived_at: null }],
    );

    const r = await alterarTipoDeAgendamento(
      db as never,
      ator(),
      alterarSchema.parse({ id: TIPO, reminder_channel_session_id: CANAL }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.code, r.status]).toEqual(["validation_failed", 422]);
    expect(escritas).toEqual([]);
  });

  it("tipo da outra organização é 404, e a linha dela termina intacta", async () => {
    const daOutra: Linha = { id: TIPO_DA_OUTRA, organization_id: OUTRA_ORG, reminder_enabled: false };
    const { db } = adminFake([daOutra]);

    const r = await alterarTipoDeAgendamento(
      db as never,
      ator(),
      alterarSchema.parse({ id: TIPO_DA_OUTRA, reminder_enabled: true }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.code, r.status]).toEqual(["not_found", 404]);
    expect(r.message).toBe("Tipo de agendamento não encontrado.");
    expect(daOutra.reminder_enabled).toBe(false);
  });
});

describe("desativarTipoDeAgendamento", () => {
  it("desativa com `is_active = false`, nunca com delete", async () => {
    const linha: Linha = { id: TIPO, organization_id: ORG, is_active: true };
    const { escritas, db } = adminFake([linha]);

    const r = await desativarTipoDeAgendamento(db as never, ator(), { id: TIPO });

    expect(r).toEqual({ ok: true, data: { id: TIPO } });
    expect(linha.is_active).toBe(false);
    expect(escritas[0]?.campos).toEqual({ is_active: false });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agenda.tipo_desativado", resourceId: TIPO }),
    );
  });

  it("tipo de outra organização é 404 e continua ativo", async () => {
    const daOutra: Linha = { id: TIPO_DA_OUTRA, organization_id: OUTRA_ORG, is_active: true };
    const { db } = adminFake([daOutra]);

    const r = await desativarTipoDeAgendamento(db as never, ator(), { id: TIPO_DA_OUTRA });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.code, r.status]).toEqual(["not_found", 404]);
    expect(daOutra.is_active).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });
});
