import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSchema, referenceSchema, safeSource } from "@/lib/instagram/schema";
const reserve = vi.fn().mockResolvedValue("reservation");
const settle = vi.fn();
const evidence = vi.fn();
vi.mock("@/lib/billing/ai-allowance", () => ({
  reserveSubscriptionAi: (...a: unknown[]) => reserve(...a),
  settleSubscriptionAi: (...a: unknown[]) => settle(...a),
  recordSubscriptionAiEvidence: (...a: unknown[]) => evidence(...a),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/env", () => ({ env: { OPENAI_API_KEY: "test-only" } }));
import {
  createImage,
  research,
  imageCostCents,
  textCostCents,
  IMAGE_MODEL,
} from "@/lib/instagram/ai";
const input = {
  id: "10000000-0000-4000-8000-000000000011",
  kind: "post" as const,
  niche: "Confeitaria",
  brief: "Uma imagem de bolo artesanal",
  format: "feed" as const,
  caption: "",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("Instagram input and sources", () => {
  it("rejects tenant injection and extra fields", () => {
    expect(createSchema.safeParse({ ...input, organization_id: "foreign" }).success).toBe(false);
  });
  it("normalizes handles and rejects URLs and commands", () => {
    expect(referenceSchema.parse("@exemplo")).toBe("exemplo");
    for (const v of ["https://instagram.com/a", "a b", "x);DROP TABLE"]) {
      expect(referenceSchema.safeParse(v).success).toBe(false);
    }
  });
  it("does not render unsafe source URLs", () => {
    expect(safeSource("javascript:alert(1)")).toBe(false);
    expect(safeSource("https://user:secret@example.com")).toBe(false);
    expect(safeSource("https://example.com/post")).toBe(true);
  });
  it("measures only actual image tokens", () => {
    expect(imageCostCents({ input_tokens: 100, output_tokens: 1000 })).toBe(3.05);
    expect(imageCostCents({})).toBeNull();
    expect(imageCostCents({ input_tokens: -1, output_tokens: 100 })).toBeNull();
  });
});
describe("generation", () => {
  it("uses requested model and keeps credentials in server headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          usage: { input_tokens: 100, output_tokens: 1000 },
          data: [{ b64_json: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await createImage("org", input);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(init.body)).toMatchObject({ model: IMAGE_MODEL, n: 1, size: "1024x1280" });
    expect(init.redirect).toBe("error");
    expect(settle).toHaveBeenCalledWith({}, "org", "reservation", 3.05);
  });
  it("does not retry an ambiguous provider failure", async () => {
    const f = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", f);
    await expect(createImage("org", input)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({}, "org", "reservation", null);
  });
  it("does not expose provider body or secret on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret provider message", { status: 403 })),
    );
    await expect(createImage("org", input)).rejects.toThrow("A IA não concluiu");
    expect(settle).toHaveBeenCalledWith({}, "org", "reservation", 0);
  });
  it("rejects invented trends without source citations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Viral em todo lugar!" }],
              },
            ],
          }),
        ),
      ),
    );
    await expect(
      research("org", {
        id: input.id,
        kind: "research",
        niche: "Bolos",
        brief: "Bolos recentes",
        references: [],
      }),
    ).rejects.toThrow("fontes verificáveis");
  });
});

describe("metered research", () => {
  const response = {
    service_tier: "default",
    usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 500 } },
    output: [{ type: "web_search_call", status: "completed" }],
  };
  it("adds the search fee to measured tokens including cache and tier", () => {
    expect(textCostCents(response)).toBeCloseTo(1.023);
    expect(textCostCents({ ...response, service_tier: "priority" })).toBeCloseTo(1.046);
  });
  it("keeps incomplete usage pending rather than charging zero", () => {
    expect(textCostCents({})).toBeNull();
    expect(
      textCostCents({ ...response, output: [{ type: "web_search_call", status: "failed" }] }),
    ).toBeNull();
    expect(textCostCents({ ...response, service_tier: "auto" })).toBeNull();
  });
});
