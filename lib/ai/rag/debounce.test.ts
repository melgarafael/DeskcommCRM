import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  set: vi.fn(async (..._args: unknown[]) => {
    throw new Error("redis unavailable");
  }),
  del: vi.fn(async (..._args: unknown[]) => {
    throw new Error("redis unavailable");
  }),
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(options: Record<string, unknown>) {
      state.options = options;
    }
    set(key: string, value: string, options: Record<string, unknown>) {
      return state.set(key, value, options);
    }
    del(key: string) {
      return state.del(key);
    }
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    UPSTASH_REDIS_REST_URL: "https://redis.example",
    UPSTASH_REDIS_REST_TOKEN: "token",
  },
}));

describe("rag debounce", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.options = undefined;
  });

  it("falha rápido no Redis e usa fallback local sem lançar", async () => {
    const { acquireDebounce } = await import("./debounce");

    await expect(acquireDebounce("org-a:agent-a:event-a", 30)).resolves.toBe(true);
    await expect(acquireDebounce("org-a:agent-a:event-a", 30)).resolves.toBe(false);
    expect(state.set).toHaveBeenCalledWith("org-a:agent-a:event-a", "1", { nx: true, ex: 30 });
    expect(state.options).toMatchObject({ retry: false });
  });

  it("não falha a liberação quando Redis está indisponível", async () => {
    const { acquireDebounce, releaseDebounce } = await import("./debounce");
    const key = "org-b:agent-b:event-b";

    await acquireDebounce(key, 30);
    await expect(releaseDebounce(key)).resolves.toBeUndefined();
  });
});
