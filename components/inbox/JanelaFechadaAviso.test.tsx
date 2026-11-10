/**
 * Fora da janela de 24h, o modelo é a única saída — e ele não sai sem os valores.
 *
 * Em 21/09/2026 este painel ofereceu `aviso_debriefing_adv` (cabeçalho de
 * imagem, um slot) e enviou com os valores vazios. A rota recusou com
 * `template_missing_values: 1`, gravou a linha como `failed` e devolveu 200; o
 * painel mostrou "Modelo enviado". O operador acreditou que tinha falado com o
 * cliente.
 *
 * Os dois casos abaixo prendem as duas metades do conserto: o botão espera o
 * formulário, e o que sai leva os valores com a chave que o montador do payload
 * usa (`header:1`, não `1` — cabeçalho de mídia e `{{1}}` do corpo têm a mesma
 * `key` e só o endereço os separa).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

const mutate = vi.fn();

const salvos: { valores: Record<string, string> } = { valores: {} };

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({
    data: {
      data: {
        templates: [
          {
            name: "aviso_debriefing_adv",
            language: "pt_BR",
            status: "APPROVED",
            slots: [
              { key: "1", expects: "image", onde: "cabeçalho", valueKey: "header:1" },
            ],
            savedValues: salvos.valores,
            components: [{ type: "BODY", text: "Aviso automático." }],
          },
        ],
      },
    },
  }),
}));

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate, isPending: false }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// A fonte das definições é resolvida por um rótulo neutro (`templates-fonte`),
// e a cerca `lint:channels` proíbe nomear o canal fora de `lib/channels/`. O
// teste mocka a resolução em vez de passar o nome, que é também como o
// componente deve ser lido: ele nunca interpreta esse valor.
vi.mock("@/lib/channels/templates-fonte", () => ({
  fonteDeTemplates: () => "oficial",
  rotaDeTemplates: () => "/api/v1/channels/templates",
}));

import { JanelaFechadaAviso } from "./JanelaFechadaAviso";

function montar() {
  return render(
    <JanelaFechadaAviso
      conversationId="c1"
      provider="canal-com-definicoes"
      motivo="Janela fechada."
    />,
  );
}

describe("JanelaFechadaAviso", () => {
  beforeEach(() => {
    mutate.mockClear();
    salvos.valores = {};
  });

  it("não deixa enviar enquanto o modelo tem valor em branco", async () => {
    const user = userEvent.setup();
    montar();

    await user.selectOptions(
      screen.getByRole("combobox"),
      "aviso_debriefing_adv|pt_BR",
    );

    expect(screen.getByRole("button", { name: /Enviar modelo/ })).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("envia os valores na chave do endereço do slot", async () => {
    const user = userEvent.setup();
    montar();

    await user.selectOptions(
      screen.getByRole("combobox"),
      "aviso_debriefing_adv|pt_BR",
    );
    await user.type(screen.getByRole("textbox"), "https://exemplo.com/capa.jpg");

    const botao = screen.getByRole("button", { name: /Enviar modelo/ });
    expect(botao).toBeEnabled();
    await user.click(botao);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      type: "template",
      template_name: "aviso_debriefing_adv",
      template_language: "pt_BR",
      template_values: { "header:1": "https://exemplo.com/capa.jpg" },
    });
  });

  it("o link salvo no modelo já vem preenchido e libera o envio", async () => {
    salvos.valores = { "header:1": "https://exemplo.com/salva.jpg" };
    const user = userEvent.setup();
    montar();

    await user.selectOptions(
      screen.getByRole("combobox"),
      "aviso_debriefing_adv|pt_BR",
    );

    expect(screen.getByRole("textbox")).toHaveValue("https://exemplo.com/salva.jpg");
    expect(screen.getByRole("button", { name: /Enviar modelo/ })).toBeEnabled();
  });

  async function enviarERecusar(error_code: string, error_message: string) {
    salvos.valores = { "header:1": "https://exemplo.com/salva.jpg" };
    const user = userEvent.setup();
    montar();
    await user.selectOptions(screen.getByRole("combobox"), "aviso_debriefing_adv|pt_BR");
    await user.click(screen.getByRole("button", { name: /Enviar modelo/ }));
    const { onSuccess } = mutate.mock.calls[0]![1] as { onSuccess: (r: unknown) => void };
    act(() => onSuccess({ data: { status: "failed", error_code, error_message } }));
    return vi.mocked(toast.error).mock.calls.at(-1) as [string, { description: string }];
  }

  it("modelo recusado com texto cru do canal: o aviso não mostra o endereço interno", async () => {
    const [titulo, opcoes] = await enviarERecusar(
      "canal_x_error", "fetch failed http://servico-interno:3000/api/sendText",
    );
    expect(titulo).toBe("Não consegui enviar o modelo.");
    expect(opcoes.description).toBe("Não foi possível enviar esta mensagem.");
  });

  it("o caso de 21/09: falta o valor do cabeçalho, e o aviso diz isso", async () => {
    const [, opcoes] = await enviarERecusar("canal_x_error", "template_missing_values: 1");
    expect(opcoes.description).toBe("Falta o valor de uma variável do modelo para este contato.");
  });

  it("modelo recusado pela plataforma (132000): a causa, não 'confira a conexão'", async () => {
    const [, opcoes] = await enviarERecusar(
      "meta_error", "meta_132000: (#132000) Number of parameters does not match the expected number of params",
    );
    expect(opcoes.description).toBe("Os valores enviados não batem com as variáveis do modelo.");
  });

  it("modelo recusado com código sem frase nossa (100): o texto da plataforma", async () => {
    const [, opcoes] = await enviarERecusar("meta_error", "meta_100: Parameter name is missing or empty");
    expect(opcoes.description).toBe("(#100) Parameter name is missing or empty");
  });

  it("modelo recusado pelo modo de teste: o aviso conta a frase nossa", async () => {
    const [, opcoes] = await enviarERecusar(
      "pre_go_live", "Envio automático bloqueado pelo modo de teste do canal.",
    );
    expect(opcoes.description).toBe("Envio automático bloqueado pelo modo de teste do canal.");
  });
});
