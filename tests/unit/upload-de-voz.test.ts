import { describe, expect, it, vi } from "vitest";

const { createAdminClientMock, uploadMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  uploadMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: createAdminClientMock,
}));

import { uploadDeVoz } from "@/lib/agent-engine/agent/inbound-turn";

describe("uploadDeVoz", () => {
  it("sobe pro bucket whatsapp-media com o path organizationId/conversationId/... — o prefixo que isMediaPathOwnedBy exige", async () => {
    uploadMock.mockResolvedValue({ error: null });
    createAdminClientMock.mockReturnValue({ storage: { from: () => ({ upload: uploadMock }) } });

    const path = await uploadDeVoz({
      tenantId: "org1",
      conversationId: "conv1",
      jobId: "job1",
      seq: 2,
      audio: Buffer.from("fake-mp3"),
      mimeType: "audio/mpeg",
    });

    expect(path).toBe("org1/conv1/voz-agente-job1-2.mp3");
    expect(uploadMock).toHaveBeenCalledWith(
      "org1/conv1/voz-agente-job1-2.mp3",
      expect.any(Buffer),
      { contentType: "audio/mpeg", upsert: true },
    );
  });

  // Achado na revisão de código, antes da Fase 7: com `upsert: false`, um
  // envio que sintetiza e sobe o áudio mas falha no TRANSPORTE (WAHA fora)
  // trava para sempre — o retry rotaciona o ledger e sintetiza de novo, mas
  // o path é determinístico (tenantId/conversationId/jobId/seq, não o id da
  // linha do ledger), e o Storage recusaria o upload por já existir.
  it("usa upsert:true — um retry que sintetiza de novo não pode travar porque o path antigo já existe", async () => {
    uploadMock.mockResolvedValue({ error: null });
    createAdminClientMock.mockReturnValue({ storage: { from: () => ({ upload: uploadMock }) } });

    await uploadDeVoz({
      tenantId: "org1",
      conversationId: "conv1",
      jobId: "job1",
      seq: 2,
      audio: Buffer.from("fake-mp3"),
      mimeType: "audio/mpeg",
    });

    const [, , opcoes] = uploadMock.mock.calls[0]!;
    expect((opcoes as { upsert: boolean }).upsert).toBe(true);
  });

  it("erro do Storage lança — nunca devolve um path que não existe", async () => {
    uploadMock.mockResolvedValue({ error: { message: "bucket indisponível" } });
    createAdminClientMock.mockReturnValue({ storage: { from: () => ({ upload: uploadMock }) } });

    await expect(
      uploadDeVoz({
        tenantId: "org1",
        conversationId: "conv1",
        jobId: "job1",
        seq: 1,
        audio: Buffer.from("x"),
        mimeType: "audio/mpeg",
      }),
    ).rejects.toThrow(/voz_upload_failed/);
  });
});
