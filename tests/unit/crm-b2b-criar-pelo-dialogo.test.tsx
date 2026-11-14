/**
 * Criar pelo diálogo de vínculo (issue #3198, fatia 1 — achado do teste em tela).
 *
 * O defeito: na ficha da empresa, "Adicionar pessoa" com um nome que ainda não
 * existia mostrava um botão "Criar nova pessoa: <nome>" no MEIO do formulário,
 * e o botão "Adicionar" do rodapé ficava desligado. Quem preenchia nome, cargo
 * e decisor e ia ao rodapé, como em qualquer formulário, não tinha clique.
 *
 * O contrato agora: com nada escolhido e algo digitado, o botão PRINCIPAL vira
 * "<rótulo>: <texto>" e cria; com alguém escolhido, ele volta a ligar. E na
 * ficha da pessoa, "Criar contato" só aparece quando o texto é telefone ou
 * e-mail — um nome solto não vira contato sem número.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { BuscarEEscolher, type Opcao } from "@/components/crm-b2b/BuscarEEscolher";
import { telefoneOuEmail } from "@/components/crm-b2b/telefone-ou-email";

afterEach(cleanup);

let linhas: Array<Record<string, unknown>> = [];
beforeEach(() => {
  linhas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: linhas }), { status: 200 })),
  );
});

const mapear = (l: Record<string, unknown>): Opcao => ({
  id: l.id as string,
  titulo: l.full_name as string,
});

function montar(extra: Partial<Parameters<typeof BuscarEEscolher>[0]> = {}) {
  const onConfirmar = vi.fn(async () => null);
  const acao = vi.fn(async () => null);
  const onAbertoChange = vi.fn();
  render(
    <BuscarEEscolher
      aberto
      onAbertoChange={onAbertoChange}
      titulo="Adicionar pessoa"
      endpoint="/api/v1/people"
      mapear={mapear}
      placeholder="Buscar pessoa"
      rotuloConfirmar="Adicionar"
      onConfirmar={onConfirmar}
      criarNovo={{ rotulo: "Criar nova pessoa", acao }}
      {...extra}
    />,
  );
  return { onConfirmar, acao, onAbertoChange };
}

describe("BuscarEEscolher — o botão principal cria quem não existe", () => {
  it("⭐ nome novo: o rodapé vira 'Criar nova pessoa: <nome>', ligado, e cria", async () => {
    const { acao, onConfirmar, onAbertoChange } = montar();
    fireEvent.change(screen.getByPlaceholderText("Buscar pessoa"), {
      target: { value: "William" },
    });

    const botao = await screen.findByRole("button", { name: "Criar nova pessoa: William" });
    await waitFor(() => expect(botao).toBeEnabled());
    // Só um botão de criar: o do meio do formulário não existe mais.
    expect(screen.getAllByRole("button", { name: /Criar nova pessoa/ })).toHaveLength(1);

    fireEvent.click(botao);
    await waitFor(() => expect(acao).toHaveBeenCalledWith("William"));
    expect(onConfirmar).not.toHaveBeenCalled();
    await waitFor(() => expect(onAbertoChange).toHaveBeenCalledWith(false));
  });

  it("escolhendo alguém da lista, o rodapé volta a ser 'Adicionar' e liga — não cria", async () => {
    linhas = [{ id: "p-1", full_name: "William Souza" }];
    const { acao, onConfirmar } = montar();
    fireEvent.change(screen.getByPlaceholderText("Buscar pessoa"), {
      target: { value: "William" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "William Souza" }));

    const adicionar = screen.getByRole("button", { name: "Adicionar" });
    expect(adicionar).toBeEnabled();
    fireEvent.click(adicionar);
    await waitFor(() =>
      expect(onConfirmar).toHaveBeenCalledWith({ id: "p-1", titulo: "William Souza" }),
    );
    expect(acao).not.toHaveBeenCalled();
  });

  it("busca vazia: nada a criar, 'Adicionar' desligado", async () => {
    montar();
    await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar" })).toBeDisabled());
  });

  it("sem `criarNovo` (só ligar), digitar não liga o botão", async () => {
    montar({ criarNovo: undefined });
    fireEvent.change(screen.getByPlaceholderText("Buscar pessoa"), {
      target: { value: "Ninguém" },
    });
    await screen.findByText("Nada encontrado.");
    expect(screen.getByRole("button", { name: "Adicionar" })).toBeDisabled();
  });

  it("`aceita` recusa o texto: não oferece criar (nome solto não vira contato)", async () => {
    const acao = vi.fn(async () => null);
    montar({
      rotuloConfirmar: "Vincular",
      criarNovo: {
        rotulo: "Criar contato",
        acao,
        aceita: (texto) => telefoneOuEmail(texto) !== null,
      },
    });
    const campo = screen.getByPlaceholderText("Buscar pessoa");

    fireEvent.change(campo, { target: { value: "William" } });
    await screen.findByText("Nada encontrado.");
    expect(screen.getByRole("button", { name: "Vincular" })).toBeDisabled();

    fireEvent.change(campo, { target: { value: "(16) 99999-0001" } });
    const criar = await screen.findByRole("button", { name: "Criar contato: (16) 99999-0001" });
    await waitFor(() => expect(criar).toBeEnabled());
  });

  it("`buscaInicial` já vem no campo ao abrir (o nome do contato do WhatsApp)", async () => {
    montar({ buscaInicial: "Ana" });
    expect(screen.getByPlaceholderText("Buscar pessoa")).toHaveValue("Ana");
    expect(await screen.findByRole("button", { name: "Criar nova pessoa: Ana" })).toBeEnabled();
  });
});

describe("telefoneOuEmail — o que vira contato novo", () => {
  it("telefone brasileiro com DDD vira E.164", () => {
    expect(telefoneOuEmail("(16) 99999-0001")).toEqual({ phone_number: "+5516999990001" });
    expect(telefoneOuEmail("+55 16 99999-0001")).toEqual({ phone_number: "+5516999990001" });
  });
  it("e-mail vira e-mail, em caixa baixa", () => {
    expect(telefoneOuEmail(" Ana@Empresa.com.br ")).toEqual({ email: "ana@empresa.com.br" });
  });
  it("nome, número curto ou vazio: null", () => {
    expect(telefoneOuEmail("William")).toBeNull();
    expect(telefoneOuEmail("1234")).toBeNull();
    expect(telefoneOuEmail("  ")).toBeNull();
  });
});

describe("NovoContato — telefone e e-mail no MESMO contato", () => {
  it("⭐ grava um contato só, com os dois, e liga à pessoa", async () => {
    const { NovoContato } = await import("@/components/crm-b2b/NovoContato");
    const chamadas: Array<{ url: string; corpo: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        chamadas.push({ url, corpo: init?.body ? JSON.parse(init.body as string) : null });
        if (url === "/api/v1/contacts") {
          return new Response(JSON.stringify({ data: { contact: { id: "c-9" } } }), { status: 201 });
        }
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }),
    );
    const onFechar = vi.fn();
    render(
      <NovoContato
        inicial={{ telefone: "(16) 99999-0001", email: "" }}
        personId="p-1"
        nome="William"
        onFechar={onFechar}
        onCriado={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Telefone")).toHaveValue("(16) 99999-0001");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "William@Empresa.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() => expect(onFechar).toHaveBeenCalled());
    expect(chamadas).toEqual([
      {
        url: "/api/v1/contacts",
        corpo: {
          name: "William",
          phone_number: "+5516999990001",
          email: "william@empresa.com",
          source: "manual",
        },
      },
      { url: "/api/v1/contacts/c-9/person", corpo: { person_id: "p-1" } },
    ]);
  });

  it("telefone inválido não grava nada e diz por quê", async () => {
    const { NovoContato } = await import("@/components/crm-b2b/NovoContato");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    render(
      <NovoContato
        inicial={{ telefone: "1234", email: "" }}
        personId="p-1"
        nome="William"
        onFechar={vi.fn()}
        onCriado={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Telefone inválido");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("JuntarEmailAoContato — o e-mail da ficha vai para o contato do telefone", () => {
  async function montarJuntar(candidatos: Array<{ id: string; rotulo: string }>) {
    const { JuntarEmailAoContato } = await import("@/components/crm-b2b/JuntarEmailAoContato");
    const f = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const onFeito = vi.fn();
    const onCriarContato = vi.fn();
    render(
      <JuntarEmailAoContato
        email="wilson@empresa.com"
        candidatos={candidatos}
        onFeito={onFeito}
        onCriarContato={onCriarContato}
        onErro={vi.fn()}
      />,
    );
    return { f, onFeito, onCriarContato };
  }

  it("⭐ um telefone sem e-mail: junta direto nele (PATCH com o e-mail)", async () => {
    const { f, onFeito } = await montarJuntar([{ id: "c-1", rotulo: "(11) 99877-6543" }]);
    fireEvent.click(screen.getByRole("button", { name: "Juntar ao contato" }));
    await waitFor(() => expect(onFeito).toHaveBeenCalled());
    expect(f).toHaveBeenCalledWith(
      "/api/v1/contacts/c-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ email: "wilson@empresa.com" }) }),
    );
  });

  it("mais de um: pergunta em qual, e só grava no escolhido", async () => {
    const { f } = await montarJuntar([
      { id: "c-1", rotulo: "(11) 1111-1111" },
      { id: "c-2", rotulo: "(11) 2222-2222" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Juntar ao contato" }));
    expect(f).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "(11) 2222-2222" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(f).toHaveBeenCalledWith("/api/v1/contacts/c-2", expect.anything());
  });

  it("nenhum telefone sem e-mail: oferece criar o contato, sem gravar nada", async () => {
    const { f, onCriarContato } = await montarJuntar([]);
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));
    expect(onCriarContato).toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});
