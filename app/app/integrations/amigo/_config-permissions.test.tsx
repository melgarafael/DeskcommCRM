import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AmigoConfig } from "./_config";
import { agentOperations } from "@/lib/amigo/agent-permissions";
const config = {
  configured: true,
  active: false,
  connection_id: "11111111-1111-4111-8111-111111111111",
  token_last4: "1234",
  validated_at: "2026-11-07T12:00:00Z",
  default_place_id: 1,
  timezone: "America/Fortaleza",
  reminders_enabled: false,
  last_sync_at: null,
  last_error: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("apresenta as opções e salva a escolha do administrador", async () => {
  const calls: Array<{ operation?: string; agent_operations?: string[] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return new Response(
        JSON.stringify({
          data: body.operation
            ? { data: [{ id: 1, name: "Unidade" }] }
            : { ...config, agent_operations: body.agent_operations },
        }),
      );
    }),
  );
  render(<AmigoConfig config={config} canConfigure onChange={() => {}} />);
  const checkbox = screen.getByRole("checkbox", { name: "Agendar consulta" });
  expect(checkbox).toBeChecked();
  fireEvent.click(checkbox);
  expect(screen.getByRole("checkbox", { name: /Consultar aniversariantes/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
  await waitFor(() => expect(calls.some((c) => Array.isArray(c.agent_operations))).toBe(true));
  const saved = calls.find((c) => Array.isArray(c.agent_operations))!.agent_operations!;
  expect(saved).not.toContain("attendance_create");
  expect(saved).toContain("events");
  expect(saved).toHaveLength(agentOperations.length - 3);
});
