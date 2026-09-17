/**
 * O INTERRUPTOR "CLIENTES PELA AGENDA" — o que a tela promete antes de ligar.
 *
 * Ligar etiqueta de uma vez todo contato que já teve horário, religar também
 * tira a etiqueta de quem ficou sem horário que conte, e desligar depois não
 * tira a etiqueta de ninguém. Por isso a suíte protege, antes de tudo, que
 * LIGAR passa por um diálogo que diz isso — e que cancelar o diálogo não chama
 * a action. O número mostrado depois vem do CORPO da action (o que o banco
 * contou), não de uma releitura.
 *
 * ⚠️ O CORPO TEM QUATRO NÚMEROS INDEPENDENTES. A fixture anterior montava
 * `clientes = ganharam`, e foi isso que escondeu a tela afirmando "Nenhum
 * contato tinha horário marcado ainda" sobre dois clientes: religar sem nada
 * novo devolve `{ganharam: 0, clientes: 2}`, medido num banco real.
 *
 * O quarto número entrou depois, e pelo mesmo modo de falha do lado IRMÃO: uma
 * organização cujo único contato tem horário marcado, todos cancelados,
 * devolve `{ganharam: 0, clientes: 0, perderam: 0}` — e a tela dizia que
 * ninguém tinha horário. O caso estava PINADO aqui como correto
 * (`corpo({ganharam: 0, clientes: 0})`), então nenhum gate reprovava. Ele
 * continua pinado, agora com o quarto número explícito: os dois corpos são
 * diferentes e têm frases diferentes.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const definir = vi.fn();
vi.mock("@/app/actions/settings/definirClientePelaAgenda", () => ({
  definirClientePelaAgenda: (...a: unknown[]) => definir(...a),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ClientePelaAgenda } from "./ClientePelaAgenda";

const corpo = (n: {
  ganharam: number;
  clientes: number;
  perderam?: number;
  soCancelados?: number;
}) => ({
  ok: true,
  ligado: true,
  mudou: true,
  ganharam_etiqueta: n.ganharam,
  perderam_etiqueta: n.perderam ?? 0,
  clientes: n.clientes,
  com_agendamento_que_nao_conta: n.soCancelados ?? 0,
});

async function ligarCom(resposta: ReturnType<typeof corpo>) {
  definir.mockResolvedValue(resposta);
  const user = userEvent.setup();
  render(<ClientePelaAgenda ligadoInicial={false} podeLigar />);
  await user.click(screen.getByTestId("cliente-pela-agenda-interruptor"));
  await user.click(screen.getByTestId("cliente-pela-agenda-confirmar"));
  return screen.findByTestId("cliente-pela-agenda-resultado");
}

beforeEach(() => {
  definir.mockReset();
});

describe("ClientePelaAgenda", () => {
  it("quem não é admin vê o interruptor desabilitado e a razão", () => {
    render(<ClientePelaAgenda ligadoInicial={false} podeLigar={false} />);
    expect(screen.getByTestId("cliente-pela-agenda-interruptor")).toBeDisabled();
    expect(screen.getByText("Só um administrador pode mudar essa regra.")).toBeInTheDocument();
  });

  it("desligada diz o que acontece desligada", () => {
    render(<ClientePelaAgenda ligadoInicial={false} podeLigar />);
    expect(screen.getByTestId("cliente-pela-agenda-estado")).toHaveTextContent(/^Desligado:/);
  });

  it("ligar abre o diálogo, e cancelar não chama a action", async () => {
    const user = userEvent.setup();
    render(<ClientePelaAgenda ligadoInicial={false} podeLigar />);

    await user.click(screen.getByTestId("cliente-pela-agenda-interruptor"));
    expect(screen.getByText("Ligar clientes pela agenda?")).toBeInTheDocument();
    expect(
      screen.getByText(/Desligar depois não tira a etiqueta de ninguém\./),
    ).toBeInTheDocument();
    // Religar TIRA etiqueta, e isso tem de estar escrito antes de confirmar.
    expect(
      screen.getByText(/quem ficou sem horário que conte perde a etiqueta que o sistema tinha posto/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(definir).not.toHaveBeenCalled();
    expect(screen.getByTestId("cliente-pela-agenda-interruptor")).toHaveAttribute("aria-checked", "false");
  });

  it("confirmar mostra quantos contatos ganharam a etiqueta, a partir do corpo da action", async () => {
    definir.mockResolvedValue(corpo({ ganharam: 3, clientes: 3 }));
    const user = userEvent.setup();
    render(<ClientePelaAgenda ligadoInicial={false} podeLigar />);

    await user.click(screen.getByTestId("cliente-pela-agenda-interruptor"));
    await user.click(screen.getByTestId("cliente-pela-agenda-confirmar"));

    await waitFor(() =>
      expect(screen.getByTestId("cliente-pela-agenda-resultado")).toHaveTextContent(
        "3 contatos ganharam a etiqueta “cliente”.",
      ),
    );
    expect(definir).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("cliente-pela-agenda-interruptor")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("cliente-pela-agenda-estado")).toHaveTextContent(/^Ligado:/);
  });

  it("nenhum contato com horário: diz que quem marcar daqui em diante ganha", async () => {
    const resultado = await ligarCom(corpo({ ganharam: 0, clientes: 0 }));
    await waitFor(() =>
      expect(resultado).toHaveTextContent(
        "Nenhum contato tinha horário marcado ainda. Quem marcar daqui em diante ganha a etiqueta.",
      ),
    );
  });

  it("a agenda só tem cancelamento: NÃO diz que ninguém tinha horário marcado", async () => {
    // O corpo medido em Postgres descartável: organização cujo único contato tem
    // horário marcado, todos cancelados →
    // `{clientes: 0, ganharam: 0, perderam: 0, com_agendamento_que_nao_conta: 1}`.
    // Os três primeiros números são iguais aos do caso acima; só o quarto separa
    // "a agenda está vazia" de "a agenda só tem cancelamento".
    const resultado = await ligarCom(corpo({ ganharam: 0, clientes: 0, soCancelados: 1 }));
    expect(resultado).toHaveTextContent(
      "Nenhum contato virou cliente: os horários que existem estão cancelados ou marcados como falta.",
    );
    expect(resultado).not.toHaveTextContent(/Nenhum contato tinha horário/);
  });

  it("religar sem nada novo, com clientes: diz quantos já eram, e NUNCA que ninguém tinha horário", async () => {
    // O corpo medido na sonda P5 da revisão: desligar e religar sem mudança.
    const resultado = await ligarCom(corpo({ ganharam: 0, clientes: 2 }));
    expect(resultado).toHaveTextContent("Nenhum contato novo ganhou a etiqueta: 2 contatos já eram clientes.");
    expect(resultado).not.toHaveTextContent(/Nenhum contato tinha horário/);
  });

  it("ligar com um cliente que já tinha a etiqueta à mão: o singular", async () => {
    const resultado = await ligarCom(corpo({ ganharam: 0, clientes: 1 }));
    expect(resultado).toHaveTextContent("Nenhum contato novo ganhou a etiqueta: 1 contato já era cliente.");
    expect(resultado).not.toHaveTextContent(/Nenhum contato tinha horário/);
  });

  it("religar quando o único cliente perdeu os horários: diz a perda, no singular, e não que ninguém tinha horário", async () => {
    // O corpo da sonda P6: o único horário cancelado com a regra desligada.
    const resultado = await ligarCom(corpo({ ganharam: 0, clientes: 0, perderam: 1 }));
    expect(resultado).toHaveTextContent("Nenhum contato ganhou a etiqueta.");
    expect(resultado).toHaveTextContent(/1 contato perdeu a etiqueta “cliente”:/);
    expect(resultado).not.toHaveTextContent(/Nenhum contato tinha horário/);
    expect(resultado).not.toHaveTextContent(/1 contatos/);
  });

  it("religar diz também quem perdeu a etiqueta, no plural", async () => {
    const resultado = await ligarCom(corpo({ ganharam: 1, clientes: 4, perderam: 2 }));
    expect(resultado).toHaveTextContent("1 contato ganhou a etiqueta “cliente”.");
    expect(resultado).toHaveTextContent(/2 contatos perderam a etiqueta “cliente”:/);
  });

  it("desligar não pede confirmação, e a recusa do banco aparece traduzida", async () => {
    definir.mockResolvedValue({ ok: false, erro: "mfa" });
    const user = userEvent.setup();
    render(<ClientePelaAgenda ligadoInicial podeLigar />);

    await user.click(screen.getByTestId("cliente-pela-agenda-interruptor"));

    expect(definir).toHaveBeenCalledWith(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Confirme a verificação em duas etapas.");
    expect(screen.getByTestId("cliente-pela-agenda-interruptor")).toHaveAttribute("aria-checked", "true");
  });
});
