/**
 * O EDITOR DE SEQUÊNCIA E AS AUTOMAÇÕES NO IDIOMA DE QUEM USA.
 *
 * Três classes de português em todo idioma, medidas no espanhol:
 *
 * - **Texto escrito cru, fora de `t()`:** o placeholder e o botão da regra de resposta, o rótulo acessível da
 *   comparação, o placeholder da etapa e o rótulo dos segmentos do gatilho; nas ações das automações, os exemplos dos
 *   campos, o « — desconectado » da lista de números e o rótulo do segredo.
 * - **Rótulo que a tela passa por `t(rotulo)` mas que não era chave:** sem chave, `t()` devolve o português — o modo
 *   « Texto fixo » da mensagem, os tipos de resposta da pergunta, os nomes de blocos na paleta.
 * - **Valor que É chave mas era desenhado sem `t()`:** os botões de variável da mensagem ({v.label}).
 *
 * E o cartão do e-mail no designer de automação, que não tinha caso no resumo da ação e dizia « send_email » em todo
 * idioma, o português também.
 *
 * Em português, a tela sai como antes (salvo o cartão do e-mail).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider } from "@xyflow/react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/webhooks/useWebhookSources", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  usePipelines: () => ({ data: { data: [] } }),
}));

import { ActionForm } from "@/app/app/ai/followups/[id]/_components/forms/ActionForm";
import { CollectForm } from "@/app/app/ai/followups/[id]/_components/forms/CollectForm";
import { MatchReplyForm } from "@/app/app/ai/followups/[id]/_components/forms/MatchReplyForm";
import { NodePalette } from "@/app/app/ai/followups/[id]/_components/NodePalette";
import { ActionConfigForm, defaultActionConfig } from "@/app/app/webhooks/_components/ActionConfigForm";
import { CaixaDaAutomacao } from "@/app/app/webhooks/automacoes/[id]/_components/CaixaDaAutomacao";
import { PaletaDaAutomacao } from "@/app/app/webhooks/automacoes/[id]/_components/PaletaDaAutomacao";
import type { Idioma } from "@/lib/i18n/idiomas";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { SeletorDeVariavel } from "@/components/variaveis/SeletorDeVariavel";
import { RESOLVEDORES } from "@/lib/variaveis/catalogo";

afterEach(cleanup);

function noIdioma(idioma: Idioma, filho: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <IdiomaProvider locale={idioma}>{filho}</IdiomaProvider>
    </QueryClientProvider>
  );
}

const RESPOSTA = { branches: [{ id: "br_1", label: "Sim", op: "contains", pattern: "sim" }], grace_timeout_ms: 3_600_000 };

describe("a regra de resposta do editor", () => {
  it("em espanhol", () => {
    render(noIdioma("es", <MatchReplyForm config={RESPOSTA as never} onChange={() => {}} />));
    expect(screen.getByPlaceholderText("texto a coincidir")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Agregar regla/ })).toBeTruthy();
    expect(screen.getByLabelText("Comparación de la regla 1")).toBeTruthy();
  });

  it("em português, como antes", () => {
    render(noIdioma("pt-BR", <MatchReplyForm config={RESPOSTA as never} onChange={() => {}} />));
    expect(screen.getByPlaceholderText("texto a casar")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Adicionar regra/ })).toBeTruthy();
    expect(screen.getByLabelText("Comparação da regra 1")).toBeTruthy();
  });
});

describe("os rótulos que a tela passava por t() sem serem chave", () => {
  const TEXTO = { mode: "text", body: "Hola" };
  const PERGUNTA = { key: "confirma", label: "Confirma", type: "select", options: ["a", "b"], required: true, permite_correcao: true };

  it("em espanhol: o modo da mensagem, o tipo da resposta e a paleta", () => {
    render(noIdioma("es", <ActionForm config={TEXTO as never} onChange={() => {}} />));
    expect(screen.getAllByRole("combobox").map((c) => c.textContent)).toContain("Texto fijo");
    cleanup();
    render(noIdioma("es", <CollectForm config={PERGUNTA as never} onChange={() => {}} />));
    expect(screen.getAllByRole("combobox").map((c) => c.textContent)).toContain("Elegir de una lista");
    cleanup();
    render(noIdioma("es", <NodePalette onAdd={() => {}} />));
    expect(screen.getByTestId("palette-add-internal_task").textContent).toContain("Recordatorio interno");
  });

  it("em português, como antes", () => {
    render(noIdioma("pt-BR", <ActionForm config={TEXTO as never} onChange={() => {}} />));
    expect(screen.getAllByRole("combobox").map((c) => c.textContent)).toContain("Texto fixo");
    cleanup();
    render(noIdioma("pt-BR", <CollectForm config={PERGUNTA as never} onChange={() => {}} />));
    expect(screen.getAllByRole("combobox").map((c) => c.textContent)).toContain("Escolha numa lista");
    cleanup();
    render(noIdioma("pt-BR", <NodePalette onAdd={() => {}} />));
    expect(screen.getByTestId("palette-add-internal_task").textContent).toContain("Lembrete interno");
  });
});

/**
 * ─── O DELTA (#3687) — declarado, não escondido ────────────────────────────
 *
 * Até o #3687, `ActionConfigForm` desenhava três botões inline na mensagem da
 * ação: `Nome`, `Telefone` e `Título do lead` — uma lista local, uma por tela.
 * O PR trocou isso DE PROPÓSITO pelo seletor compartilhado: um botão
 * « Inserir variável » que abre a lista do catálogo (`SeletorDeVariavel`),
 * porque a lista local era justamente o defeito que a issue #3687 mediu (a
 * mesma variável existia numa tela e faltava na outra).
 *
 * O TRABALHO É O MESMO, A FORMA MUDOU: escolher a variável e inserir o token no
 * texto. O que este bloco passa a cobrar é o seletor — a lista abre, o item do
 * catálogo está lá com o token e com o rótulo no idioma de quem usa, e clicar
 * insere o token no corpo. As três variáveis antigas continuam alcançáveis:
 * `{{nome}}` e `{{telefone}}` são itens do catálogo e `{{lead.title}}` é item
 * extra da automação. O curinga `{{lead.*}}` NÃO é item de inserir: a marcação
 * não casa com `*` e o token iria literal para o cliente — ele aparece como dica
 * de como escrever o caminho.
 */
const ABRIR_SELETOR = { es: "Insertar variable", pt: "Inserir variável" } as const;

/** O item da lista: o nome acessível concatena o token e o rótulo do catálogo. */
function itemDoSeletor(token: string, rotulo: string) {
  return screen.getByRole("button", {
    name: (nome) => nome.includes(token) && nome.includes(rotulo),
  });
}

/** O corpo do e-mail guardado em estado: clicar no item tem de mexer no texto. */
function EmailComCorpo() {
  const [acao, setAcao] = useState(() => defaultActionConfig("send_email"));
  return <ActionConfigForm action={acao} onChange={setAcao} />;
}

describe("as ações de uma automação", () => {
  it("em espanhol: os exemplos, o segredo e o seletor de variável", async () => {
    const user = userEvent.setup();
    render(noIdioma("es", <ActionConfigForm action={defaultActionConfig("add_tag")} onChange={() => {}} />));
    expect(screen.getByPlaceholderText("bienvenida, nuevo-lead")).toBeTruthy();
    cleanup();
    render(noIdioma("es", <ActionConfigForm action={defaultActionConfig("call_webhook")} onChange={() => {}} />));
    expect(screen.getByText("Secreto (opcional)")).toBeTruthy();
    expect(screen.getByPlaceholderText("una contraseña solo tuya")).toBeTruthy();
    cleanup();
    render(noIdioma("es", <ActionConfigForm action={defaultActionConfig("send_email")} onChange={() => {}} />));
    // O botão do seletor é texto de tela: em espanhol, espanhol.
    await user.click(screen.getByRole("button", { name: ABRIR_SELETOR.es }));
    // A variável que antes era o botão « Nombre » agora é item do catálogo, com
    // a descrição traduzida — o token e o rótulo têm de estar os dois.
    expect(itemDoSeletor("{{nome}}", "Nombre del contacto, tal como está en el registro")).toBeTruthy();
  });

  it("em português, como antes", async () => {
    const user = userEvent.setup();
    render(noIdioma("pt-BR", <ActionConfigForm action={defaultActionConfig("add_tag")} onChange={() => {}} />));
    expect(screen.getByPlaceholderText("boas-vindas, novo-lead")).toBeTruthy();
    cleanup();
    render(noIdioma("pt-BR", <EmailComCorpo />));
    await user.click(screen.getByRole("button", { name: ABRIR_SELETOR.pt }));
    expect(itemDoSeletor("{{nome}}", "Nome do contato, como está no cadastro")).toBeTruthy();
    expect(itemDoSeletor("{{telefone}}", "Telefone do contato, como está no cadastro")).toBeTruthy();
    // O efeito do botão antigo continua sendo o do seletor: o token entra no corpo.
    await user.click(itemDoSeletor("{{nome}}", "Nome do contato, como está no cadastro"));
    const corpo = screen
      .getAllByRole("textbox")
      .find((campo) => (campo as HTMLTextAreaElement).value === "{{nome}}");
    expect(corpo).toBeTruthy();
  });

  it("o curinga {{lead.*}} é só dica e não insere (iria literal ao cliente); {{lead.title}}, como o botão antigo, insere", async () => {
    const user = userEvent.setup();
    render(noIdioma("pt-BR", <EmailComCorpo />));
    await user.click(screen.getByRole("button", { name: ABRIR_SELETOR.pt }));
    const lista = screen.getByRole("dialog", { name: ABRIR_SELETOR.pt });

    // A dica existe, com o caminho escrito por extenso, e não é botão.
    const dica = within(lista).getByText(/\{\{lead\.nome_do_campo\}\}/);
    expect(dica).toBeTruthy();
    expect(within(lista).queryByRole("button", { name: (nome) => nome.includes("{{lead.*}}") })).toBeNull();
    // Clicar nela não escreve nada no corpo.
    await user.click(dica);
    expect(
      screen.getAllByRole("textbox").some((campo) => (campo as HTMLTextAreaElement).value.includes("lead")),
    ).toBe(false);

    // O título do card continua a um clique, e o token que entra é o que o motor resolve.
    await user.click(itemDoSeletor("{{lead.title}}", "Título do lead"));
    const corpo = screen
      .getAllByRole("textbox")
      .find((campo) => (campo as HTMLTextAreaElement).value === "{{lead.title}}");
    expect(corpo).toBeTruthy();
  });

  it("nenhum item inserível do seletor tem `*`, em nenhuma fonte: o token sairia literal", async () => {
    const user = userEvent.setup();
    for (const fonte of RESOLVEDORES) {
      render(noIdioma("pt-BR", <SeletorDeVariavel fonte={fonte} onInserir={() => {}} />));
      await user.click(screen.getByRole("button", { name: ABRIR_SELETOR.pt }));
      const lista = screen.getByRole("dialog", { name: ABRIR_SELETOR.pt });
      const itens = within(lista).queryAllByRole("button");
      expect(itens.length, `a lista de ${fonte} abriu vazia`).toBeGreaterThan(0);
      expect(
        itens.map((b) => b.textContent ?? "").filter((texto) => texto.includes("*")),
        `fonte ${fonte}`,
      ).toEqual([]);
      cleanup();
    }
  });
});

/**
 * ─── A BUSCA DO SELETOR IGNORA ACENTO (#4481) ──────────────────────────────
 *
 * O filtro do seletor comparava `.toLowerCase()` com `.toLowerCase()`: dobra a
 * caixa, não o acento. `lower('Á')` continua `'á'`, que não é `'a'` — então só
 * casava com acento e grafia idênticos, nos dois sentidos. Em português isso é
 * o caso comum: a chave nasce sem acento (`saudacao`) e o rótulo nasce com ele
 * (« como está no cadastro »), e o atendente digita das duas formas.
 *
 * A regra é a mesma do resto do repo (`termoSemAcento`), e o teste cobra as
 * duas direções no MESMO caso: sem acento achando o acentuado e com acento
 * achando o sem acento.
 */
describe("a busca do seletor de variável", () => {
  const ROTULO_DO_NOME = "Nome do contato, como está no cadastro";

  it("digitar sem acento acha o item acentuado, e digitar com acento acha o item sem acento", async () => {
    const user = userEvent.setup();
    render(noIdioma("pt-BR", <SeletorDeVariavel fonte="campanha" onInserir={() => {}} />));
    await user.click(screen.getByRole("button", { name: ABRIR_SELETOR.pt }));
    const lista = screen.getByRole("dialog", { name: ABRIR_SELETOR.pt });
    const campo = within(lista).getByRole("textbox");
    const itemDeChave = (chave: string) =>
      within(lista).getByRole("button", { name: (nome) => nome.includes(`{{${chave}}}`) });

    // A chave é `saudacao` (sem acento) e nada no rótulo repete esse termo.
    await user.type(campo, "saudacao");
    expect(itemDeChave("saudacao")).toBeTruthy();

    // Sem acento no termo, o rótulo que escreve « está » tem de aparecer.
    await user.clear(campo);
    await user.type(campo, "esta");
    expect(
      within(lista).getByRole("button", {
        name: (nome) => nome.includes("{{nome}}") && nome.includes(ROTULO_DO_NOME),
      }),
    ).toBeTruthy();

    // O INVERSO: acento digitado, chave sem acento.
    await user.clear(campo);
    await user.type(campo, "saudação");
    expect(itemDeChave("saudacao")).toBeTruthy();
  });
});

describe("o cartão do e-mail no designer de automação", () => {
  const caixa = (idioma: Idioma, config: Record<string, unknown>) => {
    // Só o que o cartão lê; o resto das props do React Flow não muda o que ele desenha.
    const props = {
      id: "acao-1",
      selected: false,
      data: { kind: "acao", acao: { type: "send_email", config } },
    } as unknown as ComponentProps<typeof CaixaDaAutomacao>;
    return render(
      noIdioma(
        idioma,
        <ReactFlowProvider>
          <CaixaDaAutomacao {...props} />
        </ReactFlowProvider>,
      ),
    );
  };

  it("diz o assunto, ou pede o e-mail — nunca o tipo cru", () => {
    caixa("es", { destinatario: "contato", assunto: "", corpo: "", formato: "texto" });
    expect(screen.getByTestId("caixa-acao-1").textContent).toContain("Escribe el correo");
    expect(screen.getByTestId("caixa-acao-1").textContent).not.toContain("send_email");
    cleanup();
    caixa("pt-BR", { destinatario: "contato", assunto: "Boas-vindas", corpo: "", formato: "texto" });
    expect(screen.getByTestId("caixa-acao-1").textContent).toContain("“Boas-vindas”");
    expect(screen.getByTestId("caixa-acao-1").textContent).not.toContain("send_email");
  });
});

// #2642 — a ação nova caiu na mesma classe do e-mail: cartão com o tipo cru e nome da paleta sem chave.
describe("a mensagem para a equipe no designer de automação", () => {
  it("o cartão diz o destino, nunca o tipo cru", () => {
    const props = {
      id: "acao-1",
      selected: false,
      data: { kind: "acao", acao: { type: "notify_team", config: {} } },
    } as unknown as ComponentProps<typeof CaixaDaAutomacao>;
    render(noIdioma("es", <ReactFlowProvider><CaixaDaAutomacao {...props} /></ReactFlowProvider>));
    expect(screen.getByTestId("caixa-acao-1").textContent).toContain("WhatsApp del equipo");
    expect(screen.getByTestId("caixa-acao-1").textContent).not.toContain("notify_team");
  });

  it("a paleta traduz o nome", () => {
    render(noIdioma("es", <PaletaDaAutomacao evento="lead.won" temCondicoes={false} onAdd={() => {}} />));
    expect(screen.getByTestId("paleta-notify_team").textContent).toContain("Mensaje para el equipo");
  });
});
