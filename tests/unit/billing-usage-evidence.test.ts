import { expect, it } from "vitest";
import { usageEvidence } from "@/lib/billing/usage-evidence";
it("retains per-call references even when one step has missing usage", () => {
  const result = usageEvidence({
    steps: [
      {
        response: { id: "resp_first" },
        usage: { inputTokens: 3, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 0 } },
        providerMetadata: { openai: { serviceTier: "flex" } },
      },
      { response: { id: "resp_second" }, usage: { outputTokens: 2 } },
    ],
  });
  expect(result.steps).toHaveLength(2);
  expect(result.steps[0]).toMatchObject({
    responseId: "resp_first",
    inputTokens: 3,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
    serviceTier: "flex",
  });
  expect(result.steps[1]).toMatchObject({
    responseId: "resp_second",
    inputTokens: null,
    outputTokens: 2,
  });
});
it("does not persist customer content, raw metadata, headers or malformed values", () => {
  const evidence = usageEvidence({
    text: "private answer",
    request: { body: "private prompt" },
    response: { id: "bad id\nsecret", headers: { authorization: "secret" } },
    usage: { inputTokens: NaN, outputTokens: -1 },
    providerMetadata: { openai: { serviceTier: "bad secret", apiKey: "secret" } },
  });
  expect(evidence).toEqual({
    version: 1,
    steps: [
      {
        responseId: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        serviceTier: null,
      },
    ],
  });
});
it("keeps absent steps distinct from measured zero", () => {
  expect(usageEvidence(null)).toEqual({ version: 1, steps: [] });
  expect(usageEvidence({ steps: [] })).toEqual({ version: 1, steps: [] });
  expect(usageEvidence({ usage: { inputTokens: 0, outputTokens: 0 } }).steps[0]?.inputTokens).toBe(
    0,
  );
});
