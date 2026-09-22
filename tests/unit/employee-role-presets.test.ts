import { describe, expect, it } from "vitest";

import {
  EMPLOYEE_ROLE_IDS,
  EMPLOYEE_ROLE_PRESETS,
  employeeRoleById,
  employeeRoleFromConfig,
} from "@/lib/ai/agents/employee-roles";
import { agentMcpCreateSchema } from "@/lib/ai/agents/validation";

describe("catálogo de funcionários digitais", () => {
  it("oferece as funções empresariais prometidas sem ids duplicados", () => {
    expect(EMPLOYEE_ROLE_PRESETS.map((role) => role.id)).toEqual(EMPLOYEE_ROLE_IDS);
    expect(new Set(EMPLOYEE_ROLE_IDS).size).toBe(EMPLOYEE_ROLE_IDS.length);
    expect(EMPLOYEE_ROLE_IDS).toEqual([
      "sdr",
      "bdr",
      "closer",
      "atendimento",
      "financeiro",
      "administrativo",
    ]);
  });

  it("entrega treinamento e próximo resultado para toda função", () => {
    for (const role of EMPLOYEE_ROLE_PRESETS) {
      expect(role.systemPrompt.length).toBeGreaterThan(300);
      expect(role.mission.length).toBeGreaterThan(30);
      expect(role.outcomes.length).toBeGreaterThanOrEqual(3);
      expect(role.handoffKeywords.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("resolve a função salva no config e degrada dados antigos para personalizado", () => {
    expect(employeeRoleFromConfig({ employee_role: "closer" })?.title).toBe("Closer");
    expect(employeeRoleFromConfig({})).toBeNull();
    expect(employeeRoleById("inventado")).toBeNull();
  });

  it("aceita a função no contrato canônico de criação", () => {
    const result = agentMcpCreateSchema.safeParse({
      name: "SDR",
      description: "Qualificação comercial",
      priority: 600,
      employee_role: "sdr",
      version: {
        system_prompt: EMPLOYEE_ROLE_PRESETS[0]!.systemPrompt,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credential_id: null,
        channel_session_id: null,
      },
    });

    expect(result.success).toBe(true);
  });
});
