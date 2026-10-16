import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { toolPartsAsText } from "@/lib/agent-engine/agent/prune-tool-results";

// The checkpoint call runs without `tools`. Thinking blocks are signed against the conversation they were
// produced in (system + tools + prefix), so replaying them there fails with
// "Invalid signature in thinking block ... bound to a different conversation".
const fita = [
  { role: "user", content: "hi, how much is it?" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking...", providerOptions: { anthropic: { signature: "signature-of-conversation-A" } } },
      { type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: "xxxx" } } },
      { type: "text", text: "Sending it now." },
      { type: "tool-call", toolCallId: "t1", toolName: "send_message", input: { text: "hi" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "t1", toolName: "send_message", output: { type: "text", value: "sent" } }],
  },
] as unknown as ModelMessage[];

describe("toolPartsAsText drops thinking parts", () => {
  it("reasoning + tool-call comes out without reasoning, keeping the text and the flattened tool call", () => {
    const out = toolPartsAsText(fita);
    const parts = out.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]) : []));
    expect(parts.some((p) => ["reasoning", "thinking", "redacted_thinking"].includes(p.type))).toBe(false);
    expect(JSON.stringify(out)).not.toContain("signature-of-conversation-A");
    const text = parts.map((p) => p.text).join("|");
    expect(text).toContain("Sending it now.");
    expect(text).toContain("[ferramenta send_message chamada com");
  });

  it("an assistant message with only reasoning is omitted instead of left empty", () => {
    const only = [{ role: "assistant", content: [{ type: "reasoning", text: "x" }] }] as unknown as ModelMessage[];
    expect(toolPartsAsText(only)).toEqual([]);
  });
});
