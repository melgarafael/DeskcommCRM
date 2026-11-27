import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { decidirElegibilidadeDaConversaViaSupabase } from "./consulta-supabase";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-08-27T12:00:00Z");
const DIA = 24 * 60 * 60 * 1000;
const TTL = 21 * DIA;

/**
 * Dublê mínimo do supabase-js: `.from().select().eq().eq().maybeSingle()`.
 * `resposta` é o que `maybeSingle` devolve.
 */
function adminStub(resposta: { data: unknown; error: { message: string } | null }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(resposta),
  };
  return { from: vi.fn(() => chain) } as never;
}

function linha(over: Record<string, unknown> = {}) {
  return {
    bot_silenced_until: null,
    assignee_kind: "ai",
    contacts: { force_human: false, ai_authorized_at: null, phone_number: null },
    channel_sessions: { metadata: {} },
    organizations: { status: "active" },
    ...over,
  };
}

describe("decidirElegibilidadeDaConversaViaSupabase", () => {
  it("canal 'open' (sem ai_gate): permite mesmo sem autorização", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(adminStub({ data: linha(), error: null }), {
      organizationId: ORG,
      conversationId: CONV,
      agora: AGORA,
      ttlMs: TTL,
    });
    // #3534: a decisão do transporte carrega também `contatoDaEquipe` (a régua
    // que o medidor de clima precisa). Aqui o contato não tem etiqueta de equipe.
    expect(d).toEqual({
      permite: true,
      motivo: "gate_aberto",
      bloqueioPorAllowlist: false,
      contatoDaEquipe: false,
    });
  });

  it("canal 'allowlist' + contato NÃO autorizado: NÃO permite (bloqueioPorAllowlist)", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({
        data: linha({ channel_sessions: { metadata: { ai_gate: "allowlist" } } }),
        error: null,
      }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toMatchObject({ permite: false, motivo: "sem_autorizacao", bloqueioPorAllowlist: true });
  });

  it("canal 'allowlist' + autorizado dentro da janela: permite", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({
        data: linha({
          channel_sessions: { metadata: { ai_gate: "allowlist" } },
          contacts: {
            force_human: false,
            ai_authorized_at: new Date(AGORA.getTime() - 3 * DIA).toISOString(),
            phone_number: null,
          },
        }),
        error: null,
      }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toMatchObject({ permite: true, motivo: "autorizado" });
  });

  it("canal 'allowlist' + autorização expirada: NÃO permite (bloqueioPorAllowlist)", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({
        data: linha({
          channel_sessions: { metadata: { ai_gate: "allowlist" } },
          contacts: {
            force_human: false,
            ai_authorized_at: new Date(AGORA.getTime() - 40 * DIA).toISOString(),
            phone_number: null,
          },
        }),
        error: null,
      }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toMatchObject({ permite: false, motivo: "autorizacao_expirada", bloqueioPorAllowlist: true });
  });

  it("bot_silenced_until='infinity' (handoff/pausa manual): NÃO permite, e NÃO é bloqueioPorAllowlist", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({ data: linha({ bot_silenced_until: "infinity" }), error: null }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toMatchObject({ permite: false, motivo: "conversa_silenciada", bloqueioPorAllowlist: false });
  });

  it("force_human do contato: NÃO permite em qualquer canal", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({
        data: linha({ contacts: { force_human: true, ai_authorized_at: null, phone_number: null } }),
        error: null,
      }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toMatchObject({ permite: false, motivo: "force_human" });
  });

  it("pré-go-live: permite somente o telefone cadastrado no próprio canal", async () => {
    const metadata = {
      ai_gate: "allowlist",
      ai_gate_mode: "pre_go_live",
      ai_test_phone_numbers: ["+5585987654321"],
    };
    const permitido = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({
        data: linha({
          channel_sessions: { metadata },
          contacts: {
            force_human: false,
            ai_authorized_at: null,
            phone_number: "+5585987654321",
          },
        }),
        error: null,
      }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    const bloqueado = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({
        data: linha({
          channel_sessions: { metadata },
          contacts: {
            force_human: false,
            ai_authorized_at: AGORA.toISOString(),
            phone_number: "+5585987654000",
          },
        }),
        error: null,
      }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );

    expect(permitido?.motivo).toBe("numero_de_teste");
    expect(bloqueado).toMatchObject({ permite: false, motivo: "fora_da_lista_de_teste" });
  });

  it("org suspensa: NÃO permite, com org_nao_operante", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({ data: linha({ organizations: { status: "suspended" } }), error: null }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toEqual({
      permite: false,
      motivo: "org_nao_operante",
      bloqueioPorAllowlist: false,
      contatoDaEquipe: false,
    });
  });

  it("embed da org ausente: NÃO permite (falha fechada)", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({ data: linha({ organizations: null }), error: null }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d?.motivo).toBe("org_nao_operante");
  });

  it("dono humano + modo 'IA com o dono' ligado: o transporte também permite (#3967)", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(
      adminStub({ data: linha({ assignee_kind: "user", metadata: { ai_com_dono: true } }), error: null }),
      { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
    );
    expect(d).toMatchObject({ permite: true, motivo: "gate_aberto" });
  });

  it("pré-go-live social: a identidade do contato chega ao gate — só a conta da lista passa", async () => {
    const testador = "instagram:6af9e0ef28984e27de07bef4:1011223655361506";
    const decidir = (identidade: string | null) =>
      decidirElegibilidadeDaConversaViaSupabase(
        adminStub({
          data: linha({
            channel_sessions: {
              metadata: {
                ai_gate: "allowlist", ai_gate_mode: "pre_go_live",
                ai_test_phone_numbers: [], ai_test_social_identities: [testador],
              },
            },
            contacts: { force_human: false, ai_authorized_at: null, phone_number: null, social_identity: identidade },
          }),
          error: null,
        }),
        { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
      );
    expect(await decidir(testador)).toMatchObject({ permite: true, motivo: "numero_de_teste" });
    expect(await decidir("instagram:0123456789abcdef01234567:1011223655361506"))
      .toMatchObject({ permite: false, motivo: "fora_da_lista_de_teste" });
    expect(await decidir(null)).toMatchObject({ permite: false, motivo: "fora_da_lista_de_teste" });
  });

  it("conversa inexistente → null", async () => {
    const d = await decidirElegibilidadeDaConversaViaSupabase(adminStub({ data: null, error: null }), {
      organizationId: ORG,
      conversationId: CONV,
      agora: AGORA,
      ttlMs: TTL,
    });
    expect(d).toBeNull();
  });

  it("canal com teto + contagem que falha: o gate passa e o aviso cai no logger do projeto", async () => {
    // A conversa vem do embed; a contagem (`from("messages")`) devolve erro.
    const conversa = {
      select: () => conversa,
      eq: () => conversa,
      maybeSingle: () =>
        Promise.resolve({
          data: linha({
            contacts: { force_human: false, ai_authorized_at: null, phone_number: null, email: null },
            channel_sessions: { metadata: {}, provider: "webchat" },
          }),
          error: null,
        }),
    };
    const contagem = {
      select: () => contagem,
      eq: () => contagem,
      neq: () => Promise.resolve({ count: null, error: { message: "banco fora" } }),
    };
    const admin = {
      from: vi.fn((t: string) => (t === "messages" ? contagem : conversa)),
    } as never;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const d = await decidirElegibilidadeDaConversaViaSupabase(admin, {
        organizationId: ORG,
        conversationId: CONV,
        agora: AGORA,
        ttlMs: TTL,
      });
      expect(d).toMatchObject({ permite: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        organization_id: ORG,
        conversation_id: CONV,
        erro: "banco fora",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("erro de banco → LANÇA (fail-closed: o chamador trata como 'não responder')", async () => {
    await expect(
      decidirElegibilidadeDaConversaViaSupabase(
        adminStub({ data: null, error: { message: "column contacts.ai_authorized_at does not exist" } }),
        { organizationId: ORG, conversationId: CONV, agora: AGORA, ttlMs: TTL },
      ),
    ).rejects.toThrow(/ai_authorized_at/);
  });
});
