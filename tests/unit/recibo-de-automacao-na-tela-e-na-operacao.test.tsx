import { render } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { ActivityTab } from "@/app/app/webhooks/_components/ActivityTab";
import type { AutomationRuleRunRow } from "@/hooks/webhooks/useAutomationRules";
import {
  falhaDeExecucaoParaRecibo,
  resultadoParaRecibo,
} from "@/lib/automation/resultado-para-recibo";
import { execucoesDasRegras } from "@/lib/operacao/regras-automaticas";

const estado = vi.hoisted(() => ({ runs: [] as AutomationRuleRunRow[] }));
vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useAutomationRuns: () => ({ data: { data: estado.runs }, isLoading: false, refetch: vi.fn() }),
  useResendAutomationRun: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useLocaleDeData: () => undefined,
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PESSOAL = "Pessoa Sintética pessoa.sintetica@example.test +5511999990000";

/** Leitura dublada; o componente e a operação usada pelo MCP são os reais.
 * A prova de RLS/duas organizações continua sendo a de Postgres, não este dublê.
 */
async function lerNosDoisLados(acao: AutomationRuleRunRow["actions_result"][number]) {
  const run: AutomationRuleRunRow = {
    id: "recibo-sintetico",
    organization_id: "empresa-sintetica",
    rule_id: "regra-sintetica",
    event_id: null,
    status: "failed",
    actions_result: [acao],
    error: null,
    created_at: "2026-10-26T12:00:00Z",
    automation_rules: { name: "Regra sintética" },
  };
  const consulta = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [run], error: null }),
  };
  const supabase = { from: vi.fn().mockReturnValue(consulta) } as unknown as SupabaseClient;
  const operacao = await execucoesDasRegras(
    {
      supabase,
      organizationId: run.organization_id,
      actor: { type: "user", id: "operador-sintetico" },
      requestId: "pedido-sintetico",
    },
    { limite: 10 },
  );
  expect(consulta.eq).toHaveBeenCalledWith("organization_id", run.organization_id);
  estado.runs = [run];
  const tela = render(<ActivityTab />);
  return { operacao, texto: tela.container.textContent ?? "" };
}

describe("o recibo protegido conserva uma causa útil para a tela e a operação do MCP", () => {
  it("a exceção mantém classe e código técnico nos dois leitores, sem a frase pessoal", async () => {
    const erro = Object.assign(new TypeError(PESSOAL), { code: "ECONNRESET" });
    const { texto, operacao } = await lerNosDoisLados(
      falhaDeExecucaoParaRecibo("call_webhook", erro),
    );
    expect(texto).toContain("Não foi possível concluir a ação");
    expect(texto).toContain("Detalhe técnico: TypeError · ECONNRESET");
    expect(operacao[0]?.falhas).toEqual([{ acao: "call_webhook", erro: "ECONNRESET" }]);
    expect(texto).not.toContain(PESSOAL);
    expect(JSON.stringify(operacao)).not.toContain(PESSOAL);
  });

  it("a falha com motivo conhecido mantém a explicação da ação, sem o texto do transporte", async () => {
    const { texto, operacao } = await lerNosDoisLados(
      resultadoParaRecibo({
        type: "notify_team",
        status: "failed",
        detail: { reason: "whatsapp_falhou", error: PESSOAL },
      }),
    );
    expect(texto).toContain("Detalhe técnico: whatsapp_falhou");
    expect(texto).not.toContain("Não foi possível concluir a ação");
    expect(operacao[0]?.falhas).toEqual([{ acao: "notify_team", erro: "whatsapp_falhou" }]);
    expect(texto).not.toContain(PESSOAL);
    expect(JSON.stringify(operacao)).not.toContain(PESSOAL);
  });
});
