// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import type * as Channels from "@/lib/channels";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdapter, provedoresQueConferemNumero } from "@/lib/channels";
import { PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { openSharedContactConversation } from "./open-shared-contact-conversation";
vi.mock("@/lib/channels", async (original) => ({
  ...(await original<typeof Channels>()),
  getAdapter: vi.fn(),
  provedoresQueConferemNumero: vi.fn(),
  resolveSessionRef: () => "sessao-fixture",
}));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: vi.fn(),
  escolherSessaoParaEnvio: vi.fn(),
}));
const ORG = "11111111-1111-4111-8111-111111111111",
  CONTACT = "22222222-2222-4222-8222-222222222222",
  SESSION = "33333333-3333-4333-8333-333333333333";
const check = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  check.mockReset();
  check.mockResolvedValue(null);
  vi.mocked(getAdapter).mockReturnValue({ numeroTemConta: check } as never);
  vi.mocked(provedoresQueConferemNumero).mockReturnValue([PROVIDERS_DE_TELEFONE[0]]);
  vi.mocked(ensureConversation).mockResolvedValue("conversa-fixture");
});
function banco(recebeu = false) {
  const filters: { table: string; key: string; value: unknown }[] = [];
  const db = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          filters.push({ table, key, value });
          return chain;
        },
        limit: () => chain,
        maybeSingle: async () => ({
          error: null,
          data:
            table === "channel_sessions"
              ? {
                  id: SESSION,
                  provider: PROVIDERS_DE_TELEFONE[0],
                  status: "WORKING",
                  metadata: null,
                }
              : table === "contacts"
                ? { id: CONTACT, is_personal: false, phone_number: "+12025550123" }
                : table === "conversations" && recebeu
                  ? { id: "anterior" }
                  : table === "messages" && recebeu
                    ? { id: "recebida" }
                    : null,
        }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, filters };
}
it("false definitivo recusa antes de criar conversa", async () => {
  check.mockResolvedValue(false);
  await expect(
    openSharedContactConversation(banco().db, ORG, {
      channel_session_id: SESSION,
      contact_id: CONTACT,
    }),
  ).rejects.toThrow("numero_sem_whatsapp");
  expect(ensureConversation).not.toHaveBeenCalled();
  expect(check).toHaveBeenCalledWith({
    organizationId: ORG,
    sessionRef: "sessao-fixture",
    phone: "+12025550123",
  });
});
it.each([true, null])("resposta %s abre normalmente", async (resposta) => {
  check.mockResolvedValue(resposta);
  expect(
    await openSharedContactConversation(banco().db, ORG, {
      channel_session_id: SESSION,
      contact_id: CONTACT,
    }),
  ).toMatchObject({ conversation_id: "conversa-fixture" });
});
it("erro de transporte é desconhecido e não impede abertura", async () => {
  check.mockRejectedValue(Error("rede"));
  await openSharedContactConversation(banco().db, ORG, {
    channel_session_id: SESSION,
    contact_id: CONTACT,
  });
  expect(ensureConversation).toHaveBeenCalledOnce();
});
it("canal sem capacidade não consulta", async () => {
  vi.mocked(provedoresQueConferemNumero).mockReturnValue([]);
  await openSharedContactConversation(banco().db, ORG, {
    channel_session_id: SESSION,
    contact_id: CONTACT,
  });
  expect(check).not.toHaveBeenCalled();
});
it("histórico recebido na mesma sessão evita consulta e mantém filtros de organização", async () => {
  const { db, filters } = banco(true);
  await openSharedContactConversation(db, ORG, {
    channel_session_id: SESSION,
    contact_id: CONTACT,
  });
  expect(check).not.toHaveBeenCalled();
  for (const table of ["contacts", "channel_sessions", "conversations", "messages"])
    expect(filters).toContainEqual({ table, key: "organization_id", value: ORG });
  expect(filters).toContainEqual({ table: "messages", key: "direction", value: "inbound" });
});
