/**
 * A prévia INTEIRA da mensagem, em tempo real, e sem divergir do envio (#2446).
 *
 * Fora da janela de 24h o atendente escolhe um modelo aprovado e preenche os
 * campos sem ver o resultado: o painel mostrava só os campos com o rótulo do
 * slot, e o erro de preenchimento (valor no campo errado, frase sem sentido)
 * só aparecia depois, na bolha da conversa — quando já não há como corrigir.
 *
 * Os quatro casos prendem o critério da issue, cada um por uma metade:
 *
 *   1. selecionar o modelo mostra a prévia COMPLETA (cabeçalho, corpo, rodapé,
 *      botões);
 *   2. digitar substitui cada `{{n}}` na hora, e o que continua vazio aparece
 *      como `{{n}}` DESTACADO — sumir com o buraco esconderia o que falta;
 *   3. cabeçalho de mídia desenha a imagem a partir do link informado;
 *   4. a prévia sai da MESMA função que monta o texto do envio
 *      (`renderTemplateBody`), então prévia e mensagem enviada não têm como
 *      divergir — e o caso que prende isto é o cabeçalho `{{1}}` × corpo `{{1}}`,
 *      duas chaves iguais em endereços diferentes.
 *
 * O envio desabilitado enquanto falta valor já é assegurado em
 * `JanelaFechadaAviso.test.tsx` e volta aqui junto: uma prévia que enseja o
 * clique prematuro seria pior que nenhuma.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderTemplateBody } from "@/lib/channels/meta/render-template";

const mutate = vi.fn();

/** Cabeçalho `{{1}}` e corpo `{{1}}`: mesma `key`, endereço diferente. */
const COMPONENTES_PROMO = [
  { type: "HEADER", format: "TEXT", text: "Olá {{1}}" },
  { type: "BODY", text: "Seu cupom {{1}} vale até {{2}}." },
  { type: "FOOTER", text: "Mensagem automática." },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Quero participar" },
      { type: "URL", text: "Ver oferta", url: "https://loja.exemplo/oferta-{{1}}" },
    ],
  },
];

/** Um slot por endereço — a MESMA lista que a rota entrega à tela. */
const SLOTS_PROMO = [
  { key: "1", expects: "text", onde: "cabeçalho", valueKey: "header:1" },
  { key: "1", expects: "text", onde: "corpo", valueKey: "1" },
  { key: "2", expects: "text", onde: "corpo", valueKey: "2" },
  { key: "1", expects: "url_suffix", onde: "botão 2 (url)", valueKey: "button1:1" },
];

const COMPONENTES_AVISO = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Aviso automático." },
  { type: "FOOTER", text: "Equipe comercial" },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Entendi" }] },
];

const MODELOS = [
  {
    name: "promo_oferta",
    language: "pt_BR",
    status: "APPROVED",
    slots: SLOTS_PROMO,
    savedValues: {},
    components: COMPONENTES_PROMO,
  },
  {
    name: "aviso_debriefing_adv",
    language: "pt_BR",
    status: "APPROVED",
    slots: [{ key: "1", expects: "image", onde: "cabeçalho", valueKey: "header:1" }],
    savedValues: {},
    components: COMPONENTES_AVISO,
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: { data: { templates: MODELOS } } }),
}));

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate, isPending: false }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// A fonte é rótulo neutro (`templates-fonte`): a cerca `lint:channels` proíbe
// nomear canal fora de `lib/channels/`, então o teste mocka a resolução.
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

const PROMO = "promo_oferta|pt_BR";
const AVISO = "aviso_debriefing_adv|pt_BR";

async function escolher(user: ReturnType<typeof userEvent.setup>, valor: string) {
  await user.selectOptions(screen.getByRole("combobox"), valor);
}

/** O texto da prévia, no que ela declara ser a mensagem. */
function caixaDaPrevia(): HTMLElement {
  return screen.getByTestId("previa-modelo");
}

describe("prévia em tempo real do modelo na janela fechada", () => {
  beforeEach(() => {
    mutate.mockClear();
  });

  it("sem modelo escolhido não há prévia — nada a mostrar ainda", async () => {
    montar();
    expect(screen.queryByTestId("previa-modelo")).toBeNull();
  });

  it("ao selecionar, a prévia mostra a mensagem COMPLETA: cabeçalho, corpo, rodapé e botões", async () => {
    const user = userEvent.setup();
    montar();
    await escolher(user, PROMO);

    const previa = caixaDaPrevia();
    expect(previa).toBeInTheDocument();
    // Cada pedaço na sua place — um só bloco de texto não prova que os quatro
    // componentes foram lidos.
    expect(screen.getByTestId("previa-cabecalho")).toHaveTextContent("Olá");
    expect(screen.getByTestId("previa-corpo")).toHaveTextContent(
      "Seu cupom {{1}} vale até {{2}}.",
    );
    expect(screen.getByTestId("previa-rodape")).toHaveTextContent("Mensagem automática.");
    expect(screen.getByTestId("previa-botoes")).toHaveTextContent("Quero participar");
    expect(screen.getByTestId("previa-botoes")).toHaveTextContent("Ver oferta");
  });

  it("conforme digita, cada {{n}} vira o valor na hora e o que falta continua destacado", async () => {
    const user = userEvent.setup();
    montar();
    await escolher(user, PROMO);

    // Antes de digitar, TODO placeholder está lá — e destacado, não sumido.
    expect(screen.getByTestId("previa-corpo")).toHaveTextContent("{{1}}");
    expect(screen.getAllByTestId("parametro-em-falta").length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText("corpo — {{1}}"), "R$20");

    expect(screen.getByTestId("previa-corpo")).toHaveTextContent("Seu cupom R$20 vale até {{2}}.");
    // O que ainda falta continua visível como `{{2}}`, e continua marcado.
    const falta = screen.getAllByTestId("parametro-em-falta").map((n) => n.textContent);
    expect(falta).toContain("{{2}}");
    // Os OUTROS `{{1}}` — do cabeçalho e do sufixo do botão — continuam
    // faltando: mesma `key`, endereço diferente, e cada um avisa por si.
    expect(screen.getByTestId("previa-corpo").textContent).not.toContain("{{1}}");
    expect(screen.getByTestId("previa-cabecalho").textContent).toContain("{{1}}");
    expect(screen.getByTestId("previa-botoes").textContent).toContain("{{1}}");
  });

  it("cabeçalho de mídia desenha a imagem do link informado", async () => {
    const user = userEvent.setup();
    montar();
    await escolher(user, AVISO);

    // Sem link não há o que desenhar — e dizer isso é melhor que um retângulo
    // de imagem quebrada.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("previa-midia")).toHaveTextContent(/link/i);

    await user.type(screen.getByRole("textbox"), "https://exemplo.com/capa.jpg");

    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://exemplo.com/capa.jpg");
  });

  it("envio desabilitado enquanto houver campo obrigatório vazio", async () => {
    const user = userEvent.setup();
    montar();
    await escolher(user, PROMO);

    expect(screen.getByRole("button", { name: /Enviar modelo/ })).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("⭐ a prévia sai da MESMA função que monta o texto do envio — nunca divergem", async () => {
    const user = userEvent.setup();
    montar();
    await escolher(user, PROMO);

    await user.type(screen.getByLabelText("cabeçalho — {{1}}"), "Ana");
    await user.type(screen.getByLabelText("corpo — {{1}}"), "R$20");
    await user.type(screen.getByLabelText("corpo — {{2}}"), "30/11");
    await user.type(screen.getByLabelText(/sufixo da URL/), "black-friday");

    const botao = screen.getByRole("button", { name: /Enviar modelo/ });
    expect(botao).toBeEnabled();
    await user.click(botao);

    expect(mutate).toHaveBeenCalledTimes(1);
    const enviado = mutate.mock.calls[0]![0] as {
      template_values: Record<string, string>;
    };
    // Endereços diferentes, mesmo `key`: cabeçalho e corpo não podem trocar de valor.
    expect(enviado.template_values).toEqual({
      "header:1": "Ana",
      "1": "R$20",
      "2": "30/11",
      "button1:1": "black-friday",
    });

    // O texto do envio é o que `renderTemplateBody` monta (é ele que a cadeia
    // before_send avalia como "o texto que o LEAD vai ler"). A prévia tem de
    // conter exatamente esse texto, parte por parte.
    const textoDoEnvio = renderTemplateBody(
      COMPONENTES_PROMO,
      enviado.template_values,
      { name: "promo_oferta", language: "pt_BR" },
    );
    expect(textoDoEnvio).toBe("Olá Ana\n\nSeu cupom R$20 vale até 30/11.");

    const previa = caixaDaPrevia().textContent ?? "";
    for (const parte of textoDoEnvio.split("\n\n")) {
      expect(previa).toContain(parte);
    }
    // E a parte que o envio NÃO leva (rodapé e botões) está na prévia, porque a
    // prévia promete a mensagem inteira — só a substituição é que é compartilhada.
    expect(previa).toContain("Mensagem automática.");
    expect(previa).toContain("https://loja.exemplo/oferta-black-friday");
  });
});
