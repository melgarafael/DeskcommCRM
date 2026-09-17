import { beforeEach, expect, it, vi } from "vitest";
import type { OutboundEnvelope } from "../types";
const mocks = vi.hoisted(() => ({ send: vi.fn(), credentials: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("./service", () => ({ channelCredentials: mocks.credentials }));
import { socialAdapter } from "../adapters/social";
const envelope: OutboundEnvelope = {
  organizationId: "org-a",
  sessionRef: "ig-page-a",
  to: "00012345678901234567",
  kind: "text",
  body: "Resposta de teste",
  idempotencyKey: "message-a",
};
beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({ message_id: "hub-1", status: "queued" });
  mocks.credentials
    .mockReset()
    .mockResolvedValue({ client: { send: mocks.send }, status: "WORKING" });
});
it("endereça pela identidade opaca, sem usar o telefone e sem aceitar grupo", () => {
  const recipient = {
    isGroup: false,
    groupChatId: null,
    phoneNumber: "+5511999999999",
    waIdentity: null,
  };
  expect(socialAdapter.resolveRecipient(recipient)).toBeNull();
  expect(socialAdapter.resolveRecipient({ ...recipient, providerRecipientId: envelope.to })).toBe(
    envelope.to,
  );
  expect(
    socialAdapter.resolveRecipient({
      ...recipient,
      isGroup: true,
      providerRecipientId: envelope.to,
    }),
  ).toBeNull();
});
it("revalida a autoridade antes do transporte e mantém o aceite pendente", async () => {
  const guard = vi.fn(async () => {
    expect(mocks.send).not.toHaveBeenCalled();
  });
  expect(await socialAdapter.send({ ...envelope, beforeSend: guard })).toEqual({
    externalId: "socios_hub:hub-1",
  });
  expect(guard).toHaveBeenCalledOnce();
  expect(mocks.credentials).toHaveBeenCalledWith({}, "org-a", "ig-page-a");
  expect(mocks.send).toHaveBeenCalledWith(
    "ig-page-a",
    envelope.to,
    { type: "text", text: { body: envelope.body } },
    "message-a",
  );
  expect(socialAdapter.acceptedStatus).toBe("sending");
});
it("não envia depois que o humano revoga a autoridade", async () => {
  await expect(
    socialAdapter.send({
      ...envelope,
      beforeSend: async () => {
        throw new Error("human_takeover");
      },
    }),
  ).rejects.toThrow("human_takeover");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("recusa canal desconectado e intenção sem chave idempotente", async () => {
  await expect(socialAdapter.send({ ...envelope, idempotencyKey: undefined })).rejects.toThrow(
    "social_idempotency_required",
  );
  mocks.credentials.mockResolvedValue({ status: "STOPPED" });
  await expect(socialAdapter.send(envelope)).rejects.toThrow("social_channel_disconnected");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("documento usa o tipo document do contrato público", async () => {
  await socialAdapter.send({
    ...envelope,
    kind: "document",
    media: {
      url: "https://cdn.example/file.pdf",
      filename: "file.pdf",
      mime: "application/pdf",
    },
  });
  expect(mocks.send.mock.calls[0]![2]).toMatchObject({ type: "media", media: { kind: "document" } });
});
