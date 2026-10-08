import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

/**
 * ENVIO RECUSADO PARA PESSOAL (spec 21, etapa 11 — critério 7).
 *
 * Toda rota de envio recusa contato marcado, manual ou automática, no mesmo
 * ponto onde o bloqueio já é recusado — sem exceção para gerente (gerente
 * marca e desmarca, mas não envia para marcado). O cartão compartilhado de
 * pessoal também não sai. O encontro humano (`humanMeetingCommand`) também
 * veta: pessoal não recebe nem por lá.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Liberar para gerente (`if role==manager skip`): o caso "todo papel" cai —
 *   a recusa está no handler, antes de qualquer olhar para o ator.
 * - Tirar o `or is_personal` do `readStopFlags`: o caso do encontro cai.
 * - Tirar a recusa do cartão: o caso do cartão cai.
 * Linha para reverter: `app/api/v1/messages/_handler.ts` (recusa + cartão) e
 * `lib/agent-engine/guardrails/before-send.ts` (encontro).
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

function conversa(pessoal: boolean) {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    last_inbound_at: new Date().toISOString(),
    contacts: {
      phone_number: "+5511999999999",
      wa_identity: null,
      wa_lid: null,
      is_blocked: false,
      is_personal: pessoal,
    },
    channel_sessions: { provider: "zernio", status: "WORKING", archived_at: null },
  };
}

const texto = (): SendMessageInput =>
  ({ conversation_id: CONV, type: "text", body: "oi" }) as SendMessageInput;

async function erroDoEnvio(actor: HandlerCtx["actor"], pessoal: boolean) {
  const { supabase } = criarDubleDoHandler({ conversation: conversa(pessoal) });
  const ctx: HandlerCtx = { organization_id: ORG, actor, requestId: "req-1" };
  return sendMessageHandler(supabase, ctx, texto()).catch((e: unknown) => e);
}

describe("envio para pessoal é recusado em todo papel (critério 7)", () => {
  it("atendente leva 403", async () => {
    const err = await erroDoEnvio({ type: "user", id: USER }, true);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("integração por token leva 403 (sem passar pela janela de 24h)", async () => {
    const err = await erroDoEnvio({ type: "api_token", id: "tok-1" }, true);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("agente de IA leva 403", async () => {
    const err = await erroDoEnvio({ type: "ai_agent", id: "ag-1", role: "agent" }, true);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("a mensagem diz pessoal, sem vazar dado do contato", async () => {
    const err = (await erroDoEnvio({ type: "user", id: USER }, true)) as ApiError;
    expect(err.message).toMatch(/pessoal/i);
    expect(err.message).not.toMatch(/5511999999999/);
  });

  it("contato normal não é afetado pelo veto (segue para o canal)", async () => {
    // Não prova o envio ponta a ponta (isso é do canal); prova que o veto de
    // pessoal não tranca quem não é pessoal — o erro, se houver, não é 403.
    const err = await erroDoEnvio({ type: "user", id: USER }, false).catch((e: unknown) => e);
    if (err instanceof ApiError) expect(err.status).not.toBe(403);
  });
});

describe("cartão e encontro também vetam", () => {
  it("o ramo do cartão relê o contato com is_personal e recusa", () => {
    const src = semComentarios(fonte("app", "api", "v1", "messages", "_handler.ts"));
    expect(src).toMatch(/is_anonymized,\s*is_blocked,\s*is_personal/);
    expect(src).toMatch(/row\.is_personal === true/);
  });

  it("readStopFlags veta pessoal nos dois ramos (inclusive encontro)", () => {
    const src = semComentarios(
      fonte("lib", "agent-engine", "guardrails", "before-send.ts"),
    );
    expect(src).toMatch(/is_blocked or is_personal/);
    expect(src).toMatch(/is_blocked or force_human or is_personal/);
  });
});
