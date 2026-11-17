/**
 * #4364 — o botão "+" escolhe VÁRIOS anexos de uma vez.
 *
 * O arraste já entregava a lista desde a v1.95.0 (`onDrop` →
 * `escolherArquivos(Array.from(files))`), mas o menu "+" parava no primeiro
 * arquivo: `e.target.files?.[0]` e nenhum `multiple` nos dois inputs. Quem não
 * sabia do arraste — e no celular ele não existe — anexava um por um.
 *
 * O que este arquivo segura:
 *   1. os DOIS inputs aceitam vários (`multiple`): são dois gestos diferentes
 *      (fotos/vídeos e documento) com o mesmo defeito, e consertar só um deixa
 *      o outro quebrado sem ninguém notar;
 *   2. a escolha de dois arquivos chega ao `onPick` numa chamada SÓ, na ordem
 *      em que o operador selecionou — um `[0]` esquecido derruba aqui;
 *   3. o caso de UM arquivo continua igual (controle positivo): o conserto não
 *      pode mudar o contrato de quem anexa um só.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AttachMenu } from "@/components/inbox/composer/AttachMenu";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const arquivo = (nome: string, tipo = "application/pdf") =>
  new File(["conteudo"], nome, { type: tipo });

/** O input de documento, pelo `accept` — os dois vivem fora do popover. */
const inputDeDocumento = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[type="file"][accept*=".pdf"]')!;
const inputDeMidia = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[type="file"][accept*="image"]')!;

/**
 * Os nomes que o `onPick` recebeu em cada chamada, achatados numa lista por
 * chamada. O `unknown` é de propósito: se o menu voltar a entregar UM arquivo
 * solto no lugar da lista, o caso cai como asserção (`[["contrato.pdf"]]` ×
 * `[["contrato.pdf","proposta.pdf"]]`) em vez de estourar num `TypeError` — o
 * vermelho tem de dizer o que faltou, não que o teste não sabia ler a entrada.
 */
const nomesPorChamada = (calls: unknown[][]) =>
  calls.map(([recebido]) =>
    (Array.isArray(recebido) ? recebido : [recebido])
      .filter((f): f is File => f instanceof File)
      .map((f) => f.name),
  );

describe("o botão + aceita vários anexos (#4364)", () => {
  it("os dois inputs do menu são `multiple`", async () => {
    const { container } = render(<AttachMenu onPick={vi.fn()} />);

    expect(inputDeMidia(container)).toHaveAttribute("multiple");
    expect(inputDeDocumento(container)).toHaveAttribute("multiple");
  });

  it("⭐ dois arquivos escolhidos chegam ao onPick na MESMA chamada", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn<(files: File[]) => void>();
    const { container } = render(<AttachMenu onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: /anexar/i }));
    await user.click(await screen.findByRole("button", { name: "Documento" }));
    fireEvent.change(inputDeDocumento(container), {
      target: { files: [arquivo("contrato.pdf"), arquivo("proposta.pdf")] },
    });

    // Uma chamada com os DOIS na ordem da seleção: o `[0]` de antes devolveria
    // só o contrato, e a proposta sumiria sem aviso.
    expect(nomesPorChamada(onPick.mock.calls)).toEqual([["contrato.pdf", "proposta.pdf"]]);
  });

  it("controle: UM arquivo continua chegando sozinho, numa chamada", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn<(files: File[]) => void>();
    const { container } = render(<AttachMenu onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: /anexar/i }));
    await user.click(await screen.findByRole("button", { name: "Documento" }));
    fireEvent.change(inputDeDocumento(container), {
      target: { files: [arquivo("unico.pdf")] },
    });

    expect(nomesPorChamada(onPick.mock.calls)).toEqual([["unico.pdf"]]);
  });
});
