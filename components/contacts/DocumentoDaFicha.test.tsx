/**
 * O DOCUMENTO NA FICHA DO CONTATO — cadastrado e, enfim, visível.
 *
 * O defeito: o CPF era gravado (cifra + hash) e nenhuma tela o mostrava. O GET
 * da ficha só decifra com o cabeçalho `x-decrypt-purpose`, e ninguém o mandava.
 * O ponto destes casos é o que sai do NAVEGADOR e o que ele mostra:
 *
 *   - o número não é pedido sem clique (nenhum GET ao montar);
 *   - o clique pede a ficha COM o cabeçalho de propósito;
 *   - quem não pode ver não ganha o botão, e a recusa do servidor é dita
 *     como recusa — falha de rede não vira "sem permissão".
 *
 * CPF fictício (gerado pelo dígito verificador), nunca de pessoa real.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentoDaFicha, PROPOSITO_DA_FICHA } from "./DocumentoDaFicha";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));

const CONTATO = "33333333-3333-4333-8333-333333333333";

function pintar(props: Partial<Parameters<typeof DocumentoDaFicha>[0]> = {}) {
  render(
    <dl>
      <DocumentoDaFicha
        contatoId={CONTATO}
        temDocumento
        rotulo="CPF"
        podeVer
        mascararComoCpf
        {...props}
      />
    </dl>,
  );
}

beforeEach(() => {
  get.mockReset();
});

describe("sem documento", () => {
  it("mostra o traço, como os outros campos vazios, e não oferece Mostrar", () => {
    pintar({ temDocumento: false });
    expect(screen.getByText("CPF")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mostrar" })).not.toBeInTheDocument();
  });
});

describe("com documento", () => {
  it("diz que há CPF sem pedir o número ao montar", () => {
    pintar();
    expect(screen.getByText("Cadastrado")).toBeInTheDocument();
    expect(get, "a ficha pediu o número sem ninguém clicar").not.toHaveBeenCalled();
  });

  it("Mostrar pede a ficha com o cabeçalho de propósito e exibe com máscara", async () => {
    get.mockResolvedValue({ data: { cpf_decrypted: "52998224725" } });
    const user = userEvent.setup();
    pintar();

    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/api/v1/contacts/${CONTATO}`, {
      headers: { "x-decrypt-purpose": PROPOSITO_DA_FICHA },
    });
    await waitFor(() =>
      expect(screen.getByTestId("documento-revelado")).toHaveTextContent("529.982.247-25"),
    );
  });

  it("o valor gravado com máscara (fichas antigas) sai igual ao de 11 dígitos", async () => {
    get.mockResolvedValue({ data: { cpf_decrypted: "529.982.247-25" } });
    const user = userEvent.setup();
    pintar();

    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    await waitFor(() =>
      expect(screen.getByTestId("documento-revelado")).toHaveTextContent("529.982.247-25"),
    );
  });

  it("fora do Brasil o documento sai como veio, sem máscara de CPF", async () => {
    get.mockResolvedValue({ data: { cpf_decrypted: "123456789" } });
    const user = userEvent.setup();
    pintar({ rotulo: "NIF", mascararComoCpf: false });

    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    await waitFor(() =>
      expect(screen.getByTestId("documento-revelado")).toHaveTextContent("123456789"),
    );
  });

  it("Ocultar tira o número da tela", async () => {
    get.mockResolvedValue({ data: { cpf_decrypted: "52998224725" } });
    const user = userEvent.setup();
    pintar();

    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    await screen.findByTestId("documento-revelado");
    await user.click(screen.getByRole("button", { name: "Ocultar" }));

    expect(screen.queryByTestId("documento-revelado")).not.toBeInTheDocument();
    expect(screen.getByText("Cadastrado")).toBeInTheDocument();
  });

  it("quem não é gerente não ganha o botão e lê por quê", () => {
    pintar({ podeVer: false });
    expect(screen.queryByRole("button", { name: "Mostrar" })).not.toBeInTheDocument();
    expect(screen.getByText("Só gerente ou administrador vê o número.")).toBeInTheDocument();
  });

  it("a recusa do servidor (`cpf_decrypt_denied`) é dita como recusa", async () => {
    get.mockResolvedValue({ data: { cpf_decrypted: null, cpf_decrypt_denied: true } });
    const user = userEvent.setup();
    pintar();

    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Você não tem permissão para ver este documento.",
    );
    expect(screen.queryByTestId("documento-revelado")).not.toBeInTheDocument();
  });

  it("falha de rede NÃO vira 'sem permissão'", async () => {
    get.mockRejectedValue(new Error("rede"));
    const user = userEvent.setup();
    pintar();

    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Não foi possível mostrar agora. Tente de novo.",
    );
  });

  it("decifra vazia (RPC ausente, chave não semeada) também é indisponibilidade", async () => {
    get.mockResolvedValue({ data: { cpf_decrypted: null } });
    const user = userEvent.setup();
    pintar();

    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Não foi possível mostrar agora. Tente de novo.",
    );
  });
});
