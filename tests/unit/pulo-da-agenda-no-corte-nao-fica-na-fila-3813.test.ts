/**
 * O PULO DA AGENDA NO CORTE NÃO DEIXA A LINHA NA FILA (#3813).
 *
 * A linha da mensagem nasce `queued` antes do recheck de agenda do corte
 * (`checkBoundary`). Quando esse recheck pula por `nao_enviar`, o handler
 * relança `AgendaPuladoError` para quem chama registrar o pulo — mas, se a
 * linha ficasse em `queued`, o redrive do watchdog (`redriveQueued`, que lê
 * `sent_via in ('ai','automation','system') and status='queued'`) a mandaria
 * pelo canal: exatamente o que o operador escolheu NÃO mandar.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { AgendaPuladoError, MOTIVO_DO_PULO } from "@/lib/agenda/escolha-no-envio";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { CHAVE_DO_PULO } from "@/lib/inbox/pulo-da-agenda";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

// A 1ª conferência (entrada, antes do INSERT) passa; a 2ª (corte) pula — é o
// compromisso nascendo entre a entrada e o envio.
let conferencias = 0;
vi.mock("@/lib/agenda/efeito", async (original) => ({
  ...(await original<object>()),
  assertAgendaEffectSupabase: vi.fn(async () => {
    conferencias += 1;
    if (conferencias >= 2) {
      throw new AgendaPuladoError({ adiar: true, motivo: "agendado", appointment_id: "ap-1", reavaliar_em: null });
    }
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

let postsAoCanal = 0;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pulo por compromisso no recheck do corte", () => {
  async function disparar(agenda: Array<Record<string, unknown>> = []) {
    conferencias = 0;
    postsAoCanal = 0;
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/sendText")) postsAoCanal += 1;
        return new Response(JSON.stringify({ id: { id: "3EB0X" } }), { status: 200 });
      }),
    );
    const { supabase, mensagens } = criarDubleDoHandler({
      agenda,
      conversation: {
        id: CONV,
        organization_id: ORG,
        contact_id: CONTACT,
        channel_session_id: SESSION,
        is_group: false,
        group_chat_id: null,
        contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
        channel_sessions: {
          provider: "waha",
          waha_session_name: "default",
          status: "WORKING",
          archived_at: null,
          metadata: {},
        },
      },
    });
    const ctx: HandlerCtx = {
      organization_id: ORG,
      actor: { type: "ai_agent", id: "agent-engine", role: "manager" },
      requestId: "req-1",
      proactiveContext: { organizationId: ORG, contactId: CONTACT, escolhaNoEnvio: "nao_enviar" },
    };

    await expect(
      sendMessageHandler(supabase, ctx, { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput),
    ).rejects.toBeInstanceOf(AgendaPuladoError);

    expect(conferencias, "o recheck do corte não rodou — o caso não mede o que diz").toBeGreaterThanOrEqual(2);
    expect(postsAoCanal).toBe(0);
    expect(mensagens).toHaveLength(1);
    return mensagens[0]!;
  }

  it("a linha sai de `queued` (o redrive não a reenvia) e nada vai ao canal", async () => {
    const linha = await disparar();
    expect(linha.status, "linha em `queued` é pedido de reenvio ao watchdog").toBe("failed");
    expect(linha.error_code).toBe(MOTIVO_DO_PULO);
  });

  // #3848 — o selo da Inbox diz QUAL compromisso barrou. O produtor é este ramo:
  // o código do pulo identifica o caso, e o retrato (id + motivo medido + título
  // do momento) viaja no MESMO UPDATE. Sabotagem: tirar a chave do `metadata`
  // deixa este caso vermelho e a bolha sem o compromisso.
  it("o pulo leva o retrato do compromisso que barrou no mesmo UPDATE", async () => {
    const linha = await disparar([
      { id: "ap-1", organization_id: ORG, contact_id: CONTACT, title: "Avaliação inicial" },
    ]);
    expect(linha.metadata).toMatchObject({
      [CHAVE_DO_PULO]: {
        appointment_id: "ap-1",
        motivo: "agendado",
        titulo: "Avaliação inicial",
      },
    });
  });
});
