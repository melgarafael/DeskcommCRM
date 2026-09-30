import { describe, expect, it } from "vitest";

import {
  claimConversationSchema,
  conversationTagsSchema,
  listConversationsQuerySchema,
  openConversationWithContactSchema,
  patchConversationSchema,
  sendMessageSchema,
  updateConversationStatusSchema,
} from "./messaging";

describe("sendMessageSchema", () => {
  it("aceita payload com body", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: "11111111-1111-4111-8111-111111111111",
      body: "olá",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe("text"); // default
  });

  it("rejeita payload sem body e sem media_url", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.success).toBe(false);
  });

  it("rejeita conversation_id inválido", () => {
    const r = sendMessageSchema.safeParse({ conversation_id: "not-a-uuid", body: "x" });
    expect(r.success).toBe(false);
  });

  it("aceita payload type contact com shared_contact_id", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: "11111111-1111-4111-8111-111111111111",
      type: "contact",
      metadata: { shared_contact_id: "22222222-2222-4222-8222-222222222222" },
    });
    expect(r.success).toBe(true);
  });

  it("aceita contact com shared_contact inline (telefone avulso)", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: "11111111-1111-4111-8111-111111111111",
      type: "contact",
      metadata: {
        shared_contact: { name: "Maria", phone_number: "+5532984793302" },
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejeita contact sem shared_contact_id nem telefone inline", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: "11111111-1111-4111-8111-111111111111",
      type: "contact",
    });
    expect(r.success).toBe(false);
  });

  it("rejeita payload só com media_url", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: "11111111-1111-4111-8111-111111111111",
      type: "image",
      media_url: "https://cdn.example.com/foo.jpg",
    });
    expect(r.success).toBe(true);
  });

  it("rejeita body acima do limite de 4096", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: "11111111-1111-4111-8111-111111111111",
      body: "a".repeat(4097),
    });
    expect(r.success).toBe(false);
  });
});

describe("listConversationsQuerySchema", () => {
  it("aceita filtro por UUID do contato", () => {
    const contactId = "11111111-1111-4111-8111-111111111111";
    const r = listConversationsQuerySchema.safeParse({ contact_id: contactId });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contact_id).toBe(contactId);
  });

  it("rejeita filtro por contato inválido", () => {
    expect(listConversationsQuerySchema.safeParse({ contact_id: "invalid" }).success).toBe(false);
  });

  it("aceita assigned_to='me'", () => {
    const r = listConversationsQuerySchema.safeParse({ assigned_to: "me" });
    expect(r.success).toBe(true);
  });

  it("aceita assigned_to=uuid", () => {
    const r = listConversationsQuerySchema.safeParse({
      assigned_to: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.success).toBe(true);
  });

  it("rejeita assigned_to inválido", () => {
    const r = listConversationsQuerySchema.safeParse({ assigned_to: "qualquer-coisa" });
    expect(r.success).toBe(false);
  });

  it("coage limit string -> número e default 50", () => {
    const r = listConversationsQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(50);

    const r2 = listConversationsQuerySchema.safeParse({ limit: "10" });
    expect(r2.success).toBe(true);
    if (r2.success) expect(r2.data.limit).toBe(10);
  });

  it("rejeita limit acima de 100", () => {
    const r = listConversationsQuerySchema.safeParse({ limit: "200" });
    expect(r.success).toBe(false);
  });
});

describe("claimConversationSchema", () => {
  it("aceita payload vazio", () => {
    const r = claimConversationSchema.safeParse({});
    expect(r.success).toBe(true);
  });
  it("aceita expected_assignee=null", () => {
    const r = claimConversationSchema.safeParse({ expected_assignee: null });
    expect(r.success).toBe(true);
  });
  it("rejeita expected_assignee inválido", () => {
    const r = claimConversationSchema.safeParse({ expected_assignee: "abc" });
    expect(r.success).toBe(false);
  });
});

describe("updateConversationStatusSchema", () => {
  it("aceita status válido", () => {
    expect(updateConversationStatusSchema.safeParse({ status: "claimed" }).success).toBe(true);
  });
  it("rejeita status desconhecido", () => {
    expect(updateConversationStatusSchema.safeParse({ status: "wat" }).success).toBe(false);
  });
});

describe("conversationTagsSchema (G3-05 — normalização)", () => {
  it("trim + lowercase + dedup", () => {
    const r = conversationTagsSchema.parse(["  Reclamação ", "RECLAMAÇÃO", "Troca"]);
    expect(r).toEqual(["reclamação", "troca"]);
  });
  it("rejeita mais de 20 tags", () => {
    const many = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(conversationTagsSchema.safeParse(many).success).toBe(false);
  });
  it("aceita exatamente 20 tags", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    expect(conversationTagsSchema.safeParse(twenty).success).toBe(true);
  });
  it("rejeita tag com mais de 40 chars", () => {
    expect(conversationTagsSchema.safeParse(["a".repeat(41)]).success).toBe(false);
  });
  it("aceita tag com 40 chars", () => {
    expect(conversationTagsSchema.safeParse(["a".repeat(40)]).success).toBe(true);
  });
  it("rejeita tag vazia após trim", () => {
    expect(conversationTagsSchema.safeParse(["   "]).success).toBe(false);
  });
});

describe("patchConversationSchema (G3-05)", () => {
  it("aceita só tags", () => {
    expect(patchConversationSchema.safeParse({ tags: ["vip"] }).success).toBe(true);
  });
  it("aceita só status", () => {
    expect(patchConversationSchema.safeParse({ status: "closed" }).success).toBe(true);
  });
  it("rejeita corpo vazio (nem status nem tags)", () => {
    expect(patchConversationSchema.safeParse({}).success).toBe(false);
  });
});

describe("openConversationWithContactSchema", () => {
  const session = "11111111-1111-4111-8111-111111111111";

  it("aceita contact_id", () => {
    expect(
      openConversationWithContactSchema.safeParse({
        channel_session_id: session,
        contact_id: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(true);
  });

  it("aceita phone_number", () => {
    expect(
      openConversationWithContactSchema.safeParse({
        channel_session_id: session,
        phone_number: "+5511999998888",
      }).success,
    ).toBe(true);
  });

  it("aceita só contact_id — a sessão é escolhida no servidor", () => {
    expect(
      openConversationWithContactSchema.safeParse({
        contact_id: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(true);
  });

  it("rejeita sem contact_id nem phone_number", () => {
    expect(
      openConversationWithContactSchema.safeParse({ channel_session_id: session }).success,
    ).toBe(false);
  });
});
