/**
 * O diálogo de "Editar texto" (#4596) carrega o texto guardado, salva pela
 * rota irmã `/texto` e NÃO deixa salvar quando o que voltou não é o arquivo.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({
  leitura: { origem: "arquivo", conteudo: "Trocas em 7 dias." } as { origem: string; conteudo: string | null },
  puts: [] as Array<{ caminho: string; corpo: unknown }>,
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({ data: api.leitura })),
    put: vi.fn(async (caminho: string, corpo: unknown) => {
      api.puts.push({ caminho, corpo });
      return { data: { id: "x" } };
    }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { EditarTextoDialog } from "./EditarTextoDialog";

const FONTE = "66666666-6666-4666-8666-666666666666";

function montar(onSalvo = vi.fn()) {
  render(
    <IdiomaProvider locale="pt-BR">
      <EditarTextoDialog sourceId={FONTE} nome="Política" aberto onFechar={vi.fn()} onSalvo={onSalvo} />
    </IdiomaProvider>,
  );
  return onSalvo;
}

beforeEach(() => {
  api.leitura = { origem: "arquivo", conteudo: "Trocas em 7 dias." };
  api.puts = [];
});

describe("EditarTextoDialog", () => {
  it("abre com o texto guardado e salva o texto editado na rota /texto", async () => {
    const onSalvo = montar();
    const campo = (await screen.findByDisplayValue("Trocas em 7 dias.")) as HTMLTextAreaElement;

    fireEvent.change(campo, { target: { value: "Trocas em 30 dias." } });
    fireEvent.click(screen.getByTestId("texto-editar-salvar"));

    await waitFor(() => expect(onSalvo).toHaveBeenCalled());
    expect(api.puts).toEqual([
      { caminho: `/api/v1/ai/knowledge/sources/${FONTE}/texto`, corpo: { texto: "Trocas em 30 dias." } },
    ]);
  });

  it("se o arquivo não pôde ser lido (veio do índice), não deixa salvar por cima", async () => {
    api.leitura = { origem: "indice", conteudo: "pedaço do índice" };
    montar();

    await waitFor(() =>
      expect((screen.getByTestId("texto-editar-campo") as HTMLTextAreaElement).value).toBe(""),
    );
    expect((screen.getByTestId("texto-editar-salvar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("texto apagado por inteiro: salvar fica desligado", async () => {
    montar();
    const campo = await screen.findByDisplayValue("Trocas em 7 dias.");
    fireEvent.change(campo, { target: { value: "   " } });
    expect((screen.getByTestId("texto-editar-salvar") as HTMLButtonElement).disabled).toBe(true);
  });
});
