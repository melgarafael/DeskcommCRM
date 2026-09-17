// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODIGO_PLAYBOOK_PLATFORM_AUSENTE,
  ensurePlatformPlaybook,
  PlaybookPlatformMissingError,
} from "@/lib/agent-engine/agent/playbook-ensure";
import { seedPlatformPlaybook } from "@/lib/agent-engine/agent/playbook-seed";

vi.mock("@/lib/agent-engine/agent/playbook-seed", () => ({
  seedPlatformPlaybook: vi.fn(),
  PLATFORM_PLAYBOOK_PATH: "/nao-lido-neste-teste",
}));

const pool = { connect: vi.fn() } as never;

describe("ensurePlatformPlaybook", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
    vi.mocked(seedPlatformPlaybook).mockReset();
  });

  it("delega ao seed existente e devolve seeded/kept sem segundo writer", async () => {
    vi.mocked(seedPlatformPlaybook).mockResolvedValueOnce("seeded");
    await expect(ensurePlatformPlaybook(pool, log, { origem: "ensaio" })).resolves.toBe(
      "seeded",
    );
    expect(seedPlatformPlaybook).toHaveBeenCalledTimes(1);
    expect(seedPlatformPlaybook).toHaveBeenCalledWith(pool, undefined);
    expect(log.info).toHaveBeenCalledWith("playbook platform seedado", {
      origem: "ensaio",
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/Sigilium|sk-|prompt/i);

    vi.mocked(seedPlatformPlaybook).mockResolvedValueOnce("kept");
    await expect(ensurePlatformPlaybook(pool, log, { origem: "ensaio" })).resolves.toBe(
      "kept",
    );
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("playbook existente (kept) não pede overwrite nem path específico", async () => {
    vi.mocked(seedPlatformPlaybook).mockResolvedValue("kept");
    await expect(ensurePlatformPlaybook(pool)).resolves.toBe("kept");
    expect(seedPlatformPlaybook).toHaveBeenCalledWith(pool, undefined);
  });

  it("duas inicializações concorrentes só chamam o seed com lock — sem writer próprio", async () => {
    let inflight = 0;
    let maxInflight = 0;
    vi.mocked(seedPlatformPlaybook).mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return "kept";
    });
    const [a, b] = await Promise.all([
      ensurePlatformPlaybook(pool, log, { origem: "boot" }),
      ensurePlatformPlaybook(pool, log, { origem: "ensaio" }),
    ]);
    expect(a).toBe("kept");
    expect(b).toBe("kept");
    expect(seedPlatformPlaybook).toHaveBeenCalledTimes(2);
    expect(maxInflight).toBeGreaterThanOrEqual(1);
  });

  it("falha do seed vira erro específico, log sanitizado, sem stack nem chave", async () => {
    vi.mocked(seedPlatformPlaybook).mockRejectedValueOnce(
      new Error("sk-ant-SECRET\n    at playbook-seed.ts:40:3"),
    );
    await expect(ensurePlatformPlaybook(pool, log, { origem: "ensaio" })).rejects.toBeInstanceOf(
      PlaybookPlatformMissingError,
    );
    expect(log.error).toHaveBeenCalledWith("playbook platform indisponivel", {
      code: CODIGO_PLAYBOOK_PLATFORM_AUSENTE,
      origem: "ensaio",
    });
    const dump = JSON.stringify(log.error.mock.calls);
    expect(dump).not.toMatch(/sk-ant|SECRET|playbook-seed\.ts/);
    expect(dump).not.toContain("stack");
  });
});
