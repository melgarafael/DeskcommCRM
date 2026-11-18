/**
 * O passo "modelo de mensagem" mostra, para um modelo aprovado COM variável, de
 * onde sai cada `{{n}}` — e o que a pessoa escolhe chega ao grafo. Sem esta
 * tela, o mapa só existiria escrito à mão no banco (invariante 6: configuração
 * com superfície).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ActionForm } from "./ActionForm";

const COM_VARIAVEIS = "11111111-1111-4111-8111-111111111111";
const SEM_VARIAVEIS = "22222222-2222-4222-8222-222222222222";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  // Sem grupo (#3245): a barra e o slash-menu são os de antes dos grupos.
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({ data: [], isLoading: false, isError: false }),
}));
// Um campo do NEGÓCIO e um do CONTATO (#2791): o envio lê só
// `crm_leads.custom_fields`, então o seletor só pode oferecer o primeiro.
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  usePipelines: () => ({
    data: {
      data: [
        {
          id: "ffffffff-0000-4000-8000-00000000000f",
          settings: {
            fields: [
              { key: "modelo_cafeteira", label: "Modelo", type: "text" },
              { key: "cidade", label: "Cidade", type: "text", escopo: "contato" },
            ],
          },
        },
      ],
    },
  }),
}));

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});
vi.mock("@/hooks/followup/useModelosAprovadosDoFluxo", () => ({
  useModelosAprovadosDoFluxo: () => ({
    isLoading: false,
    isError: false,
    data: [
      {
        id: COM_VARIAVEIS,
        name: "confirmacao_pedido",
        language: "es",
        texto: "Olá {{1}}! Recebemos seu pedido: {{2}}",
        variaveis: [
          {
            chave: "1",
            marcador: "{{1}}",
            antes: "Olá ",
            depois: "! Recebemos",
            noCabecalho: false,
          },
          { chave: "2", marcador: "{{2}}", antes: "seu pedido: ", depois: "", noCabecalho: false },
        ],
      },
      {
        id: SEM_VARIAVEIS,
        name: "lembrete",
        language: "es",
        texto: "Ainda tem interesse?",
        variaveis: [],
      },
    ],
  }),
}));

function montar(config: Parameters<typeof ActionForm>[0]["config"]) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ActionForm config={config} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

describe("passo de modelo com variáveis", () => {
  it("⭐ mostra uma origem por variável, e a mudança chega ao grafo com o mapa inteiro", () => {
    const onChange = montar({
      mode: "template",
      template_id: COM_VARIAVEIS,
      template_values: {
        "1": { kind: "contact_first_name" },
        "2": { kind: "lead_custom", key: "produto" },
      },
    });

    expect(screen.getByText("De onde sai cada variável")).toBeInTheDocument();
    expect(screen.getAllByText("{{1}}").length).toBeGreaterThan(0);
    expect(screen.getAllByText("{{2}}").length).toBeGreaterThan(0);

    // `producto` não é campo declarado no funil: a tela mostra a chave livre.
    const chave = screen.getByLabelText("Chave do campo do negócio");
    expect(chave).toHaveValue("produto");
    fireEvent.change(chave, { target: { value: "produto_nome" } });

    expect(onChange).toHaveBeenLastCalledWith({
      mode: "template",
      template_id: COM_VARIAVEIS,
      template_values: {
        "1": { kind: "contact_first_name" },
        "2": { kind: "lead_custom", key: "produto_nome" },
      },
    });
  });

  it("modelo sem variável não mostra o mapa", () => {
    montar({ mode: "template", template_id: SEM_VARIAVEIS });
    expect(screen.queryByText("De onde sai cada variável")).toBeNull();
  });

  it("⭐ o seletor oferece campo do negócio, nunca campo do contato", async () => {
    montar({
      mode: "template",
      template_id: COM_VARIAVEIS,
      template_values: { "1": { kind: "contact_first_name" } },
    });

    fireEvent.click(screen.getByRole("combobox", { name: /\{\{2\}\}/ }));
    const lista = await screen.findByRole("listbox");
    const opcoes = within(lista)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");

    expect(opcoes).toContain("Modelo (modelo_cafeteira)");
    expect(opcoes.some((o) => o.includes("cidade"))).toBe(false);
  });
});
