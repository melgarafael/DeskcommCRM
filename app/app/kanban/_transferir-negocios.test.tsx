import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mover, contagem, etapas } = vi.hoisted(() => ({
  mover: vi.fn(),
  contagem: {
    negocios: 3 as number | null,
    abertos: 3 as number | null,
    carregando: false,
    erro: null as string | null,
  },
  etapas: [
    { id: "e-novo", name: "Novo", is_won: false, is_lost: false },
    { id: "e-andamento", name: "Em andamento", is_won: false, is_lost: false },
  ],
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useNegociosDoFunil: () => contagem,
  useEtapasDoFunil: () => ({ etapas, carregando: false }),
  useMoverNegociosDoFunil: () => ({ mutate: mover, isPending: false }),
}));

import { TransferirNegocios } from "./_transferir-negocios";

const DESTINOS = [{ id: "f-destino", name: "Clínica" }];

function montar(onConcluir = vi.fn()) {
  render(
    <TransferirNegocios
      funilId="f-origem"
      funilNome="Pedidos"
      destinos={DESTINOS}
      onConcluir={onConcluir}
    />,
  );
  return onConcluir;
}

beforeEach(() => {
  vi.clearAllMocks();
  contagem.negocios = 3;
  contagem.abertos = 3;
  contagem.carregando = false;
  contagem.erro = null;
  mover.mockImplementation((_pedido: unknown, opts: { onSuccess?: (r: unknown) => void }) => {
    opts.onSuccess?.({ data: { escolha: "transferir", movidos: 3, restantes: 0, mensagem: null } });
  });
});

describe("confirmação da transferência (#4802, item 3)", () => {
  it("mostra a contagem EXATA que o servidor devolveu", () => {
    montar();
    expect(screen.getByTestId("contagem-de-negocios-f-origem").textContent).toBe(
      "«Pedidos» tem 3 negócios vinculados. Escolha o que fazer com eles antes de continuar.",
    );
  });

  it("doc 400 (B): diz que só os em andamento vão e que os encerrados ficam", () => {
    contagem.negocios = 5;
    contagem.abertos = 3;
    montar();
    const texto = screen.getByTestId("encerrados-ficam-f-origem").textContent ?? "";
    expect(texto).toContain("Transferir leva só os em andamento (3)");
    expect(texto).toContain("Os ganhos e perdidos (2) ficam neste funil");
  });

  it("sem encerrado, a frase dos encerrados não aparece", () => {
    montar();
    expect(screen.queryByTestId("encerrados-ficam-f-origem")).toBeNull();
  });

  it("usa o singular quando o funil tem um negócio só", () => {
    contagem.negocios = 1;
    contagem.abertos = 1;
    montar();
    expect(screen.getByTestId("contagem-de-negocios-f-origem").textContent).toContain("1 negócio vinculado");
  });

  it("não afirma contagem nenhuma antes de o servidor responder", () => {
    contagem.negocios = null;
    contagem.carregando = true;
    montar();
    expect(screen.queryByTestId("contagem-de-negocios-f-origem")).toBeNull();
    expect(screen.getByTestId("negocios-carregando-f-origem")).toBeTruthy();
  });

  it("funil sem negócio não mostra escolha nenhuma", () => {
    contagem.negocios = 0;
    montar();
    expect(screen.queryByTestId("negocios-do-funil-f-origem")).toBeNull();
  });

  it("oferece as três escolhas da issue", () => {
    montar();
    expect(screen.getByTestId("escolha-transferir-funil-f-origem")).toBeTruthy();
    expect(screen.getByTestId("escolha-transferir-etapa-f-origem")).toBeTruthy();
    expect(screen.getByTestId("escolha-remover-f-origem")).toBeTruthy();
  });
});

describe("transferência em massa", () => {
  it("transfere para o funil escolhido sem etapa — o servidor decide a etapa de entrada", async () => {
    const usuario = userEvent.setup();
    const onConcluir = montar();

    await usuario.selectOptions(screen.getByTestId("destino-do-funil-f-origem"), "f-destino");
    await usuario.click(screen.getByTestId("aplicar-escolha-f-origem"));

    expect(mover.mock.calls[0]?.[0]).toEqual({
      id: "f-origem",
      corpo: { escolha: "transferir", funil_id: "f-destino", etapa_id: null },
    });
    expect(onConcluir).toHaveBeenCalledWith({ movidos: 3, restantes: 0 });
  });

  it("transfere para a ETAPA escolhida — não para a primeira do destino", async () => {
    const usuario = userEvent.setup();
    const onConcluir = montar();

    await usuario.click(screen.getByTestId("escolha-transferir-etapa-f-origem"));
    await usuario.selectOptions(screen.getByTestId("destino-do-funil-f-origem"), "f-destino");
    await usuario.selectOptions(screen.getByTestId("destino-da-etapa-f-origem"), "e-andamento");
    await usuario.click(screen.getByTestId("aplicar-escolha-f-origem"));

    expect(mover.mock.calls[0]?.[0]).toEqual({
      id: "f-origem",
      corpo: { escolha: "transferir", funil_id: "f-destino", etapa_id: "e-andamento" },
    });
    expect(onConcluir).toHaveBeenCalledWith({ movidos: 3, restantes: 0 });
  });

  it("doc 400 (B): os encerrados que ficaram viram aviso, e o painel recebe quantos restaram", async () => {
    const usuario = userEvent.setup();
    mover.mockImplementation((_pedido: unknown, opts: { onSuccess?: (r: unknown) => void }) => {
      opts.onSuccess?.({ data: { escolha: "transferir", movidos: 3, restantes: 2, mensagem: null } });
    });
    const onConcluir = montar();

    await usuario.click(screen.getByTestId("aplicar-escolha-f-origem"));

    expect(onConcluir).toHaveBeenCalledWith({ movidos: 3, restantes: 2 });
    expect(screen.getByTestId("aviso-da-escolha-f-origem").textContent).toBe(
      "2 negócios ganhos ou perdidos continuam neste funil.",
    );
  });

  it("não deixa transferir para etapa sem escolher a etapa", async () => {
    const usuario = userEvent.setup();
    montar();

    await usuario.click(screen.getByTestId("escolha-transferir-etapa-f-origem"));
    await usuario.selectOptions(screen.getByTestId("destino-do-funil-f-origem"), "f-destino");

    const botao = screen.getByTestId("aplicar-escolha-f-origem") as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
  });

  it("#4852: escolher 'remover' NOMEIA o que vai junto e avisa que não tem volta", async () => {
    const usuario = userEvent.setup();
    montar();

    // Antes de escolher, o aviso não existe (ele não é decoração da tela).
    expect(screen.queryByTestId("aviso-remover-f-origem")).toBeNull();

    await usuario.click(screen.getByTestId("escolha-remover-f-origem"));

    const aviso = screen.getByTestId("aviso-remover-f-origem");
    const texto = aviso.textContent ?? "";
    // A frase tem de dizer as DUAS coisas: o que é apagado junto e que não volta.
    expect(texto).toContain("Não tem volta");
    for (const junto of ["anexos", "vínculos", "reativações", "escores de risco", "conversões de anúncio"]) {
      expect(texto).toContain(junto);
    }
    // E continua prometendo só o que de fato fica.
    expect(texto).toContain("Contatos, conversas e o histórico do contato continuam");
  });

  it("remover manda só a escolha — nada de funil de destino", async () => {
    const usuario = userEvent.setup();
    mover.mockImplementation((_pedido: unknown, opts: { onSuccess?: (r: unknown) => void }) => {
      opts.onSuccess?.({ data: { escolha: "remover", movidos: 3, restantes: 0, mensagem: null } });
    });
    const onConcluir = montar();

    await usuario.click(screen.getByTestId("escolha-remover-f-origem"));
    await usuario.click(screen.getByTestId("aplicar-escolha-f-origem"));

    expect(mover.mock.calls[0]?.[0]).toEqual({ id: "f-origem", corpo: { escolha: "remover" } });
    expect(onConcluir).toHaveBeenCalledWith({ movidos: 3, restantes: 0 });
  });

  it("a recusa do servidor aparece INTEIRA, sem 'erro ao transferir'", async () => {
    const usuario = userEvent.setup();
    mover.mockImplementation(
      (_pedido: unknown, opts: { onError?: (e: unknown) => void }) => {
        opts.onError?.(new Error("«Clínica» está arquivado e não recebe negócio."));
      },
    );
    const onConcluir = montar();

    await usuario.click(screen.getByTestId("aplicar-escolha-f-origem"));

    expect(screen.getByTestId("erro-da-escolha-f-origem").textContent).toBe(
      "«Clínica» está arquivado e não recebe negócio.",
    );
    expect(onConcluir).not.toHaveBeenCalled();
  });
});
