/**
 * #3813 — A ESCOLHA DO FLUXO CHEGA À GUARDA DE AGENDA DO TICK.
 *
 * `createSupabaseAdminClient(...).assertAgenda` é a guarda que o motor do
 * follow-up roda antes de avançar cada passo. Ela chamava
 * `assertAgendaEffectSupabase` SEM `escolhaNoEnvio`: a guarda lia o padrão
 * (`adiar`) e um fluxo em `nao_enviar` esperava o compromisso passar e então
 * enviava. Os testes do turno usam um dublê no lugar desta guarda — sem este
 * arquivo, apagar a leitura da escolha aqui deixava a suíte verde.
 */
import { describe, expect, it, vi } from "vitest";

const leitura = vi.hoisted(() => ({ escolha: "nao_enviar" as string }));
const guarda = vi.hoisted(() => ({ chamadas: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/agenda/escolha-no-envio-leitura", () => ({
  escolhaDoFluxo: vi.fn(async () => leitura.escolha),
  escolhaDoFluxoPg: vi.fn(async () => leitura.escolha),
}));

vi.mock("@/lib/agenda/efeito", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("@/lib/agenda/efeito")),
  assertAgendaEffectSupabase: vi.fn(async (_db: unknown, ctx: Record<string, unknown>) => {
    guarda.chamadas.push(ctx);
  }),
}));

const ENROLLMENT = {
  id: "enr-1",
  organization_id: "org-1",
  contact_id: "contato-1",
  current_node_id: "no-1",
};

describe("a escolha do fluxo no tick do follow-up (#3813)", () => {
  it.each(["nao_enviar", "enviar", "adiar"])("`%s` publicado chega à guarda de agenda do tick", async (escolha) => {
    leitura.escolha = escolha;
    guarda.chamadas.length = 0;
    const { createSupabaseAdminClient } = await import("@/lib/followup/engine");

    await createSupabaseAdminClient({} as never).assertAgenda?.(ENROLLMENT as never);

    expect(guarda.chamadas).toHaveLength(1);
    expect(guarda.chamadas[0]).toMatchObject({
      organizationId: "org-1",
      contactId: "contato-1",
      enrollmentId: "enr-1",
      nodeId: "no-1",
      escolhaNoEnvio: escolha,
    });
  });
});
