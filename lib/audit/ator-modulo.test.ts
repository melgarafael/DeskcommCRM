/**
 * O AUDIT DE UM MÓDULO GRAVA O TOKEN E O SLUG — E NENHUM CAMPO DE PESSOA (spec 33, F2, tarefa 6).
 *
 * `actor_user_id` tem FK para `auth.users`; o id do ator `module` é o de `api_tokens`. Mandá-lo para lá
 * estoura a FK e a linha de audit some em silêncio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

import { auditMcpToolCall } from "@/lib/mcp/audit";
import type { McpContext } from "@/lib/mcp/types";

import { auditDoModulo, metadataDoModulo } from "./ator-modulo";

const TOKEN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const SLUG = "acme/comanda";

const ctxDoModulo = {
  organizationId: "bcc12320-f555-4fef-8d90-38a0ac5950e0",
  apiTokenId: TOKEN_ID,
  requestId: "req-1",
  actor: { type: "module", id: TOKEN_ID, slug: SLUG },
} as unknown as McpContext;

describe("auditDoModulo", () => {
  it("devolve o token e o slug para o ator módulo", () => {
    expect(auditDoModulo({ type: "module", id: TOKEN_ID, slug: SLUG })).toEqual({
      actor_api_token_id: TOKEN_ID,
      module: SLUG,
    });
  });

  it.each([
    { type: "user", id: "u-1" },
    { type: "api_token", id: "t-1" },
    { type: "ai_agent", id: "run-1", role: "agent" },
    { type: "webhook_source", id: "regra-1" },
  ] as const)("devolve nada para %o", (ator) => {
    expect(auditDoModulo(ator as never)).toBeNull();
    expect(metadataDoModulo(ator as never)).toEqual({});
  });
});

describe("metadataDoModulo com a pessoa do JWT de contexto (F3)", () => {
  const PESSOA = "bbbbbbbb-2222-4222-8222-222222222222";

  it("leva person_id na metadata quando o ator traz a pessoa", () => {
    expect(metadataDoModulo({ type: "module", id: TOKEN_ID, slug: SLUG, pessoaId: PESSOA })).toEqual({
      actor_api_token_id: TOKEN_ID,
      module: SLUG,
      person_id: PESSOA,
    });
  });

  it("sem pessoa, não traz person_id", () => {
    expect(metadataDoModulo({ type: "module", id: TOKEN_ID, slug: SLUG })).not.toHaveProperty("person_id");
  });

  it("a pessoa nunca vira campo de pessoa do audit", () => {
    expect(auditDoModulo({ type: "module", id: TOKEN_ID, slug: SLUG, pessoaId: PESSOA })).toEqual({
      actor_api_token_id: TOKEN_ID,
      module: SLUG,
    });
  });
});

describe("auditMcpToolCall com ator módulo", () => {
  beforeEach(() => auditSpy.mockClear());

  it("grava o id do token e o slug, e nenhum campo de pessoa", async () => {
    await auditMcpToolCall({
      ctx: ctxDoModulo,
      toolName: "crm_list_leads",
      args: {},
      durationMs: 3,
      success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.actorApiTokenId).toBe(TOKEN_ID);
    expect(e.metadata.actor_api_token_id).toBe(TOKEN_ID);
    expect(e.metadata.module).toBe(SLUG);
    expect(e.metadata.actor_type).toBe("module");
    // Nenhum campo de pessoa recebe o id do token.
    expect(e.actorUserId).toBeNull();
    expect(e.actorAuthSessionId ?? null).toBeNull();
    for (const [chave, valor] of Object.entries(e)) {
      if (/user/i.test(chave)) expect(valor ?? null).toBeNull();
    }
  });
});
