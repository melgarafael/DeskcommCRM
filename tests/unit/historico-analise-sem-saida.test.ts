import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ler = (arquivo: string) => fs.readFileSync(path.join(process.cwd(), arquivo), "utf8");

describe("análise do histórico não tem caminho de saída", () => {
  it("o handler não importa nem chama canal, tools ou before-send", () => {
    const fonte = ler("lib/agent-engine/agent/history-analysis.ts");
    expect(fonte).not.toMatch(/from\s+["'][^"']*(?:channel-adapter|before-send)/);
    expect(fonte).not.toContain("send_message");
    expect(fonte).not.toContain("buildMcpTurnTools");
  });

  it("o worker registra explicitamente o novo kind", () => {
    const worker = ler("workers/agent-worker/main.ts");
    expect(worker).toContain('handlers.set("history_analysis", createHistoryAnalysisHandler(turnDeps))');
  });

  it("migration e baseline mantêm o kind com contato obrigatório", () => {
    for (const arquivo of [
      "supabase/migrations/20261112071608_9350_historico_analisa_perfis_e_oportunidades.sql",
      "supabase/baseline.sql",
    ]) {
      const sql = ler(arquivo);
      expect(sql).toContain("'approved_reply','history_analysis'");
      expect(sql).toContain("job_queue_turn_needs_contact");
      expect(sql).toContain("fn_enqueue_historico_analise");
    }
  });
});
