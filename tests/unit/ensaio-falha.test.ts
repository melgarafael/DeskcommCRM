// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PlaybookPlatformMissingError } from "@/lib/agent-engine/agent/playbook-ensure";
import {
  classificarFalhaDoEnsaio,
  CODIGO_ENSAIO_FALHOU,
  CODIGO_PLAYBOOK_PLATFORM_AUSENTE,
  MSG_ENSAIO_FALHOU,
  MSG_PLAYBOOK_PLATFORM_AUSENTE,
  STATUSES_DO_RUN,
} from "@/lib/ai/agents/ensaio-falha";

const CHECK_NO_BASELINE =
  /CONSTRAINT "ai_agent_runs_status_check" CHECK \(\("status" = ANY \(ARRAY\[([^\]]+)\]\)\)\)/;

describe("classificarFalhaDoEnsaio", () => {
  it("playbook ausente não culpa modelo, credencial nem materiais", () => {
    const falha = classificarFalhaDoEnsaio(new PlaybookPlatformMissingError());
    expect(falha).toEqual({
      code: CODIGO_PLAYBOOK_PLATFORM_AUSENTE,
      message: MSG_PLAYBOOK_PLATFORM_AUSENTE,
    });
    expect(falha.message).not.toMatch(/modelo|credencial|materiais/i);
    expect(falha.code).toBe("playbook_platform_missing");
  });

  it("erro genérico fica curto e sem o detalhe interno", () => {
    const falha = classificarFalhaDoEnsaio(
      new Error("AI_GATEWAY_API_KEY ausente sk-ant-abc\n    at foo.ts:1"),
    );
    expect(falha).toEqual({
      code: CODIGO_ENSAIO_FALHOU,
      message: MSG_ENSAIO_FALHOU,
    });
    expect(falha.message).not.toContain("AI_GATEWAY");
    expect(falha.message).not.toMatch(/modelo|credencial|materiais/i);
  });

  it("STATUSES_DO_RUN é exatamente o CHECK de ai_agent_runs", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    const m = sql.match(CHECK_NO_BASELINE);
    expect(m?.[1]).toBeTruthy();
    const doBanco = [...(m?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(doBanco).toEqual([...STATUSES_DO_RUN]);
    expect(STATUSES_DO_RUN).toContain("failed");
    expect(STATUSES_DO_RUN).not.toContain("error");
    expect(STATUSES_DO_RUN).not.toContain("ok");
  });
});
