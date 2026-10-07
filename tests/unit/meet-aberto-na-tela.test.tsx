/**
 * A OPÇÃO EXISTE NA TELA, GRAVA, E O AVISO FICA AO LADO DELA (#2063).
 *
 * O mantenedor mediu no head do PR: `git grep "google_meet_acesso_aberto|
 * AVISO_MEET_ABERTO"` em `app/` e `components/` dava ZERO — a camada pura
 * (oauth + transporte + schema) estava pronta e a parte visível não existia.
 * Estes casos são a prova do contrário, e os dois defeitos que cada um fecha:
 *
 *   1. opção na tela E GRAVA — o interruptor chama a action com o valor novo e
 *      o estado novo vem do CORPO da resposta, nunca do clique. Uma opção que
 *      só renderiza (sem gravar) é o defeito que o PR estava denunciando;
 *   2. o AVISO DE RISCO está no MESMO `<section>` do interruptor — ao lado,
 *      não em outra tela nem num diálogo. É a única troca de segurança por
 *      conveniência desta tela, e o risco se diz onde ele se liga.
 *
 * O terceiro caso é controle: sem permissão o interruptor não mexe, e a frase
 * aparece — ele é verde com e sem a mudança, e existe para que o vermelho do
 * primeiro não passe por acaso.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AVISO_MEET_ABERTO, MeetComAcessoAberto } from "@/components/agenda/MeetComAcessoAberto";

/** O espião tem de nascer ANTES dos mocks: `vi.mock` é içado para o topo. */
const definir = vi.hoisted(() => vi.fn());

vi.mock("@/app/actions/settings/definirMeetAberto", () => ({
  definirMeetAberto: (...args: unknown[]) => definir(...args),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

afterEach(() => {
  cleanup();
  definir.mockReset();
});

describe("a opção 'Google Meet com acesso aberto' na tela de configurações", () => {
  it("existe e GRAVA: o interruptor chama a action com o valor novo e o estado vem do corpo", async () => {
    definir.mockResolvedValue({ ok: true, ligado: true, mudou: true });
    render(<MeetComAcessoAberto ligadoInicial={false} podeMudar />);

    const interruptor = screen.getByTestId("meet-acesso-aberto-interruptor");
    expect(interruptor, "a opção não está na tela").toHaveAttribute("aria-checked", "false");

    fireEvent.click(interruptor);

    expect(definir, "o clique não foi para a action").toHaveBeenCalledWith(true);
    // O estado vem da RESPOSTA (`ligado` do banco), não do clique — é o que
    // a action devolve quando o banco recusou.
    await waitFor(() => expect(interruptor).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(interruptor);
    await waitFor(() => expect(definir).toHaveBeenCalledWith(false));
  });

  it("o aviso de risco aparece JUNTO da opção — mesmo section, encostado no interruptor", () => {
    render(<MeetComAcessoAberto ligadoInicial={false} podeMudar />);

    const aviso = screen.getByTestId("meet-acesso-aberto-aviso");
    expect(aviso).toHaveTextContent(AVISO_MEET_ABERTO);

    // "Junto" medido, não impresso: o aviso e o interruptor estão no MESMO
    // cartão da tela, um logo após o outro. Um aviso em outra tela não conta.
    const cartao = aviso.closest("section");
    expect(cartao, "o aviso saiu do cartão da opção").not.toBeNull();
    expect(cartao).toContainElement(screen.getByTestId("meet-acesso-aberto-interruptor"));
    expect(cartao).toContainElement(screen.getByTestId("meet-acesso-aberto"));
  });

  it("sem permissão: o interruptor não mexe e a tela diz por quê (controle)", () => {
    render(<MeetComAcessoAberto ligadoInicial={false} podeMudar={false} />);

    expect(screen.getByTestId("meet-acesso-aberto-interruptor")).toBeDisabled();
    expect(screen.getByText("Só um gerente ou administrador pode mudar essa regra.")).toBeTruthy();
    expect(definir).not.toHaveBeenCalled();
  });

  it("a opção está LIGADA na tela de Configurações › Tipos de agendamento", () => {
    // Renderizar o componente sozinho provaria uma tela que ninguém monta.
    // Aqui se mede a costura: o cartão entra no `_client` da tela e a página
    // lê a chave do banco e manda para ele — é esta linha que sumiu do PR.
    const client = fs.readFileSync(
      join(__dirname, "..", "..", "app", "app", "settings", "tenant", "agenda", "_client.tsx"),
      "utf8",
    );
    expect(client, "_client.tsx deixou de renderizar o cartão da opção").toMatch(
      /<MeetComAcessoAberto[\s\S]*?ligadoInicial=\{meetAbertoLigado\}[\s\S]*?podeMudar=\{podeMudarMeetAberto\}/,
    );

    const pagina = fs.readFileSync(
      join(__dirname, "..", "..", "app", "app", "settings", "tenant", "agenda", "page.tsx"),
      "utf8",
    );
    expect(pagina, "page.tsx deixou de ler a chave do banco").toContain(
      "meetAbertoLigado={meetAbertoLigado(org?.settings)}",
    );
  });

  it("a action recusa: a frase do erro aparece e o estado NÃO muda", async () => {
    definir.mockResolvedValue({ ok: false, erro: "mfa" });
    render(<MeetComAcessoAberto ligadoInicial={false} podeMudar />);

    fireEvent.click(screen.getByTestId("meet-acesso-aberto-interruptor"));

    await waitFor(() =>
      expect(screen.getByTestId("meet-acesso-aberto-erro")).toHaveTextContent(
        "Confirme a verificação em duas etapas.",
      ),
    );
    expect(screen.getByTestId("meet-acesso-aberto-interruptor")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
