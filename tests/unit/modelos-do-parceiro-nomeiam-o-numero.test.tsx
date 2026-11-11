/**
 * A ABA DE MODELOS DO PARCEIRO NOMEIA O NÚMERO.
 *
 * A frase dizia "este número" e não dizia QUAL — e foi isso que escondeu o
 * defeito de `tests/unit/modelos-seguem-o-numero.test.ts`: a conexão foi
 * reapontada para outra conta, os modelos da anterior seguiram listados, e
 * nada na tela permitia notar. Ver o número ao lado da lista transforma
 * "modelos estranhos" em "modelos de outro número".
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const consultas = vi.hoisted(() => ({ chaves: [] as Array<{ chave: unknown[]; enabled: boolean }> }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[]; enabled?: boolean }) => {
    consultas.chaves.push({ chave: o.queryKey, enabled: o.enabled !== false });
    if (o.queryKey[0] === "canal-parceiro-cabecalho") {
      return o.enabled === false
        ? { data: undefined, isLoading: false }
        : { data: { phone_number: "+5511955554444", account_id: "conta-1" }, isLoading: false };
    }
    return { data: { data: { templates: [] } }, isLoading: false };
  },
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

import { TemplatesParceiroClient } from "@/components/connections/TemplatesParceiroClient";

describe("modelos do parceiro: de qual número são", () => {
  it("⭐ a aba do parceiro mostra o número da conexão ao lado da frase", () => {
    consultas.chaves = [];
    render(<TemplatesParceiroClient />);
    expect(screen.getByTestId("numero-dos-modelos").textContent).toBe("+5511955554444");
  });

  it("a mesma tela usada por OUTRA rota não pergunta pelo número do parceiro", () => {
    consultas.chaves = [];
    render(<TemplatesParceiroClient rota="/api/v1/channels/outra/templates" />);
    expect(screen.queryByTestId("numero-dos-modelos")).toBeNull();
    const cabecalho = consultas.chaves.find((c) => c.chave[0] === "canal-parceiro-cabecalho");
    expect(cabecalho?.enabled).toBe(false);
  });
});
