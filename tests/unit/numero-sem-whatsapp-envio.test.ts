// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import { limparMemoCheckExists } from "@/lib/waha/resolve-contact-whatsapp-id";
import { fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";
import { PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const ORG = "11111111-1111-4111-8111-111111111111",
  CONV = "22222222-2222-4222-8222-222222222222";
afterEach(() => {
  limparMemoCheckExists();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function enviar(existe: boolean | null) {
  vi.stubEnv("WAHA_API_BASE_URL", "http://canal-fixture.test");
  vi.stubEnv("WAHA_API_KEY", "fixture");
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("check-exists"))
      return existe === null
        ? new Response("{}", { status: 503 })
        : Response.json({ numberExists: existe });
    return Response.json({ id: "mensagem-fixture" });
  });
  vi.stubGlobal("fetch", fetcher);
  const { supabase, capturas } = criarDubleDoHandler({
    conversation: {
      id: CONV,
      organization_id: ORG,
      contact_id: "33333333-3333-4333-8333-333333333333",
      channel_session_id: "44444444-4444-4444-8444-444444444444",
      is_group: false,
      group_chat_id: null,
      contacts: { phone_number: "+12025550123", wa_identity: null, is_blocked: false },
      channel_sessions: {
        provider: PROVIDERS_DE_TELEFONE[0],
        waha_session_name: "fixture",
        status: "WORKING",
        archived_at: null,
      },
    },
  });
  const message = await sendMessageHandler(
    supabase,
    {
      organization_id: ORG,
      actor: { type: "user", id: "55555555-5555-4555-8555-555555555555" },
      requestId: "numero-fixture",
    },
    { conversation_id: CONV, type: "text", body: "Teste isolado" },
  );
  return { message, capturas, fetcher };
}
it("resposta definitiva fica failed com código e frase próprios, sem chamar envio", async () => {
  const { message, fetcher } = await enviar(false);
  expect(message).toMatchObject({
    status: "failed",
    error_code: "numero_sem_whatsapp",
    error_message: "Este número não tem WhatsApp.",
    metadata: { falha_de_envio: { natureza: "permanente" } },
  });
  expect(fraseDaFalhaDeCanal(message.error_code)).toBe("Este número não tem WhatsApp.");
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/send"))).toBe(false);
});
it("consulta desconhecida ainda permite enviar a mensagem", async () => {
  const { message, fetcher } = await enviar(null);
  expect(message.status).toBe("sent");
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/sendText"))).toBe(true);
});
