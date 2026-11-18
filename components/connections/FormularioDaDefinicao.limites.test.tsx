import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * O CONTADOR DO FORMULÁRIO E O BLOQUEIO DO ENVIO (#3635, fatia 2).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O campo cortava o texto em 1024 no `onChange` e mostrava um contador cinza:
 * o operador nunca via o estouro — o texto simplesmente parava de entrar, no
 * meio de uma palavra, sem explicação. E a variável `{{n}}` sem exemplo saía
 * assim mesmo; quem reprovava era a Meta, horas depois.
 *
 * ─── O que estes casos medem (em DOM) ───────────────────────────────────────
 *
 * 1. no limite exato o contador diz `1024/1024` e o envio passa;
 * 2. em 1025 o contador diz `1025/1024`, o campo vira ERRO visível e o envio é
 *    bloqueado com a mensagem do campo culpado;
 * 3. variável sem exemplo bloqueia o envio apontando o NÚMERO da variável.
 */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useLocaleDaOrgAtiva: () => "pt-BR" }));
vi.mock("@/hooks/contacts/useTelefoneExemplo", () => ({
  useTelefoneExemplo: () => "+595 981 000 000",
}));

import { FormularioDaDefinicao, type CorpoDoModelo } from "./FormularioDaDefinicao";

function montar() {
  const enviados: CorpoDoModelo[] = [];
  const { container } = render(<FormularioDaDefinicao onEnviar={(c) => enviados.push(c)} />);
  // Sem nome o botão já nasce desabilitado — o nome não é o que este arquivo mede.
  fireEvent.change(screen.getByLabelText("Nome do modelo"), { target: { value: "boas_vindas" } });
  return { container, enviados, corpo: screen.getByLabelText("Conteúdo") };
}

const contador = (container: HTMLElement, campo: string) =>
  container.querySelector<HTMLElement>(`[data-contador="${campo}"]`);
const erro = (container: HTMLElement, campo: string) =>
  container.querySelector<HTMLElement>(`[data-erro-do-campo="${campo}"]`);
const enviar = () => screen.getByRole("button", { name: "Enviar para revisão" });

describe("o contador do corpo", () => {
  it("mostra `1024/1024` no limite e deixa enviar", () => {
    const { container, enviados, corpo } = montar();

    fireEvent.change(corpo, { target: { value: "a".repeat(1024) } });

    expect(contador(container, "corpo")?.textContent).toBe("1024/1024");
    expect(contador(container, "corpo")?.getAttribute("data-excedido")).toBeNull();
    expect(erro(container, "corpo")).toBeNull();
    expect(enviar()).toBeEnabled();
    fireEvent.click(enviar());
    expect(enviados).toHaveLength(1);
  });

  it("em `1025` o contador mostra o estouro e vira ERRO visível que BLOQUEIA", () => {
    const { container, enviados, corpo } = montar();

    fireEvent.change(corpo, { target: { value: "a".repeat(1025) } });

    // O texto NÃO é mais cortado no `onChange`: quem digita 1025 precisa VER que
    // passou, e não descobrir que o campo parou de aceitar no meio da palavra.
    expect((corpo as HTMLTextAreaElement).value).toHaveLength(1025);
    expect(contador(container, "corpo")?.textContent).toBe("1025/1024");
    expect(contador(container, "corpo")?.getAttribute("data-excedido")).toBe("true");

    const mensagem = erro(container, "corpo");
    expect(mensagem, "o campo culpado tem de dizer o que estourou").not.toBeNull();
    expect(mensagem?.textContent).toContain("1025");
    expect(mensagem?.textContent).toContain("1024");

    expect(enviar()).toBeDisabled();
    fireEvent.click(enviar());
    expect(enviados).toHaveLength(0);
  });

  it("voltar para dentro do limite libera o envio de novo", () => {
    const { container, enviados, corpo } = montar();

    fireEvent.change(corpo, { target: { value: "a".repeat(1025) } });
    expect(enviar()).toBeDisabled();

    fireEvent.change(corpo, { target: { value: "a".repeat(1024) } });
    expect(erro(container, "corpo")).toBeNull();
    expect(enviar()).toBeEnabled();
    fireEvent.click(enviar());
    expect(enviados).toHaveLength(1);
  });
});

describe("os outros campos também contam", () => {
  it("rodapé e cabeçalho mostram o próprio limite e o próprio erro", () => {
    const { container } = montar();

    fireEvent.change(screen.getByLabelText("Rodapé"), { target: { value: "b".repeat(61) } });
    fireEvent.change(screen.getByLabelText("Cabeçalho de texto"), {
      target: { value: "c".repeat(61) },
    });

    expect(contador(container, "rodape")?.textContent).toBe("61/60");
    expect(contador(container, "cabecalhoTexto")?.textContent).toBe("61/60");
    expect(erro(container, "rodape")).not.toBeNull();
    expect(erro(container, "cabecalhoTexto")).not.toBeNull();
    expect(enviar()).toBeDisabled();
  });
});

describe("as variáveis do corpo", () => {
  it("variável sem exemplo BLOQUEIA o envio apontando o número", () => {
    const { container, enviados, corpo } = montar();

    fireEvent.change(corpo, { target: { value: "Olá {{1}}, seu pedido {{2}} saiu" } });

    // O campo de exemplo aparece junto com a variável — o operador vê a exigência.
    expect(screen.getByLabelText("Exemplo do valor 1")).toBeTruthy();
    expect(screen.getByLabelText("Exemplo do valor 2")).toBeTruthy();

    // Uma mensagem POR variável sem amostra — as duas, com o número de cada.
    const avisos = () =>
      Array.from(container.querySelectorAll('[data-erro-do-campo="exemploDaVariavel"]'))
        .map((e) => e.textContent ?? "")
        .join(" | ");
    expect(avisos()).toContain("1");
    expect(avisos()).toContain("2");
    expect(enviar()).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Exemplo do valor 1"), {
      target: { value: "Ana" },
    });
    // Ainda falta a 2: continuar bloqueado, e apontando SÓ a 2.
    expect(avisos()).toContain("2");
    expect(avisos()).not.toContain("variável 1 ");
    expect(enviar()).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Exemplo do valor 2"), {
      target: { value: "1234" },
    });
    expect(erro(container, "exemploDaVariavel")).toBeNull();
    expect(enviar()).toBeEnabled();
    fireEvent.click(enviar());
    expect(enviados).toHaveLength(1);
  });

  it("corpo sem variável não pede exemplo nenhum", () => {
    const { container, enviados, corpo } = montar();

    fireEvent.change(corpo, { target: { value: "Só texto, sem variável" } });

    expect(erro(container, "exemploDaVariavel")).toBeNull();
    expect(screen.queryByLabelText("Exemplo do valor 1")).toBeNull();
    fireEvent.click(enviar());
    expect(enviados).toHaveLength(1);
  });
});
