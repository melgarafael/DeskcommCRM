import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "./client";

describe("WahaClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("não inclui o corpo potencialmente sensível da resposta na exceção", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("phone=+5511999999999 token=secret", { status: 500 }),
      ),
    );

    await expect(
      new WahaClient("https://waha.example", "api-key").sendMedia("session", "chat", {
        endpoint: "sendImage",
        payload: { url: "https://example/image.jpg" },
      }),
    ).rejects.toThrow("waha_500");

    await expect(
      new WahaClient("https://waha.example", "api-key").sendMedia("session", "chat", {
        endpoint: "sendImage",
        payload: { url: "https://example/image.jpg" },
      }),
    ).rejects.not.toThrow("secret");
  });

  it("interrompe uma chamada que não responde dentro do timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      ),
    );

    const pending = new WahaClient("https://waha.example", "api-key").sendMessage(
      "session",
      "chat",
      "olá",
    );
    const rejection = expect(pending).rejects.toThrow("waha_timeout");
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
  });
});
