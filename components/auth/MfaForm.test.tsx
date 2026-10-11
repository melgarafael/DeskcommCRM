/**
 * A TELA DE VERIFICAÇÃO EM DUAS ETAPAS NÃO PODE FICAR PRESA EM "VERIFICANDO".
 *
 * `verifyMfa` fala com o GoTrue duas vezes (desafio e verificação) e ainda
 * grava a auditoria de `auth.mfa_failed` ANTES de responder — nenhuma dessas
 * chamadas tem timeout próprio. Como `startTransition` com função assíncrona só
 * sai de `isPending` quando a promessa assenta, bastava um desses passos não
 * responder para o botão ficar em "Verificando…" indefinidamente.
 *
 * E o travamento é pior do que parece: o campo de código fica `disabled`
 * enquanto pendente, então a pessoa não consegue nem tentar de novo. A única
 * saída era recarregar a página — num momento em que ela está tentando ENTRAR.
 *
 * Os casos abaixo fecham o conserto: o teto tira a tela do estado preso, o
 * caminho normal de recusa continua dizendo "código inválido", e a guarda do
 * redirecionamento segue reconhecendo o sinal do servidor — senão quem ACERTA
 * o código ficaria preso lendo "não consegui verificar".
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MfaForm } from "./MfaForm";
import { TETO_DA_ESPERA_MS, ehRedirecionamentoDoServidor } from "./teto-da-espera";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/app/actions/auth/verifyMfa", () => ({ verifyMfa: vi.fn() }));

const { verifyMfa } = await import("@/app/actions/auth/verifyMfa");

/**
 * Digita os 6 dígitos — o `onComplete` do TOTPInput dispara o envio sozinho.
 *
 * `fireEvent.change` e não manipulação crua do DOM: os campos do TOTPInput são
 * CONTROLADOS (`value={c}` vem do estado do pai), e o React substitui o setter
 * de `value` do elemento. Escrever nele direto não produz o evento que o React
 * escuta — o teste parecia digitar e nada acontecia.
 */
function digitarCodigo(valor = "123456") {
  for (let i = 0; i < valor.length; i++) {
    const campo = screen.getByLabelText(`Dígito ${i + 1}`);
    act(() => {
      fireEvent.change(campo, { target: { value: valor[i]! } });
    });
  }
}

describe("MfaForm — a espera tem teto", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(verifyMfa).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sai de 'Verificando' e explica, quando a verificação não responde", async () => {
    // A ação que NUNCA assenta — é o estado que travava a tela.
    vi.mocked(verifyMfa).mockImplementation(() => new Promise(() => {}));

    render(<MfaForm />);
    digitarCodigo();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TETO_DA_ESPERA_MS + 500);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não consegui verificar o código agora. Tente novamente.",
    );
    // E, o que mais importa: o botão VOLTOU. Com ele preso em "Verificando…" o
    // campo fica `disabled` e não há segunda tentativa.
    expect(screen.getByRole("button", { name: "Verificar" })).toBeInTheDocument();
  });

  it("o código inválido continua dizendo que é inválido, e não o texto do teto", async () => {
    // Controle de que o teto não sequestrou o caminho normal: quando a ação
    // RESPONDE recusando, a frase tem de ser a de sempre.
    vi.mocked(verifyMfa).mockResolvedValue({ ok: false, error: "mfa_invalid" });

    render(<MfaForm />);
    digitarCodigo();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Código inválido. Tente novamente.");
  });
});

/**
 * A guarda do redirecionamento é testada AQUI, na função pura, e não dirigindo
 * o formulário: relançar de dentro de `startTransition` vira rejeição não
 * tratada no ambiente de teste, porque não existe o runtime do Next para
 * capturá-la — o vermelho seria do harness, não do produto. A regra que importa
 * é a decisão, e ela é pura.
 */
describe("a guarda do redirecionamento do servidor", () => {
  it("reconhece o sinal de redirect e ignora erro comum", () => {
    expect(
      ehRedirecionamentoDoServidor(
        Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/app;307;" }),
      ),
    ).toBe(true);
    expect(ehRedirecionamentoDoServidor(new Error("tempo_esgotado"))).toBe(false);
    expect(ehRedirecionamentoDoServidor(null)).toBe(false);
    // `digest` que não é string não pode passar por acidente.
    expect(ehRedirecionamentoDoServidor({ digest: 123 })).toBe(false);
  });
});
