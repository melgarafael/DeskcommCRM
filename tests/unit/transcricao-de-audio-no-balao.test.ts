import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// O que o balão mostra é provado por render em tests/unit/inbox-media-renderer.test.tsx.
// Aqui fica só o que o render não alcança: a listagem da API entrega as colunas.
const handler = fs.readFileSync(
  path.resolve(__dirname, "../../app/api/v1/messages/_handler.ts"),
  "utf8",
);

describe("transcrição de áudio no balão da inbox (#2057)", () => {
  it("o SELECT de mensagens do inbox (MSG_COLS) traz as colunas de transcrição", () => {
    const cols = /const MSG_COLS\s*=\s*"([^"]+)"/.exec(handler)?.[1];
    expect(cols).toBeDefined();
    expect(cols).toContain("media_derived_text");
    expect(cols).toContain("media_derived_status");
  });
});
