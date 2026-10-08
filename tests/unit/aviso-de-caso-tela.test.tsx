/**
 * A TELA "AVISO NO WHATSAPP" — o que ela mostra e o que ela recusa a oferecer.
 *
 * ## O que este arquivo prova que o teste da regra não prova
 *
 * `aviso-de-caso-estado-da-tela.test.ts` mede os CÓDIGOS. Aqui mede-se que cada
 * código vira uma frase legível na tela, que o seletor não oferece conexão que
 * não manda texto livre, que o switch fica travado quando a regra diz que não
 * dá para ligar, e que o botão de teste não aparece ativo antes de haver
 * configuração salva.
 *
 * Os dois existem separados porque apagar uma frase e apagar uma regra são
 * defeitos diferentes: o primeiro deixa a pessoa sem explicação, o segundo
 * deixa o switch ligável quando ele não devia.
 *
 * ## Os hooks são mocados; o componente é renderizado de VERDADE
 *
 * Mocar o componente esconderia a peça do único teste que monta esta árvore.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EstadoDoAviso } from "@/hooks/ai/useAvisoDeCaso";

const consulta = vi.fn();
const salvarAviso = vi.fn();
const atualizarAviso = vi.fn();
vi.mock("@/hooks/ai/useAvisoDeCaso", () => ({
  CHAVE_DO_AVISO: ["ai-aviso-de-caso"],
  useAvisoDeCaso: () => consulta(),
  useSalvarAvisoDeCaso: () => ({ mutateAsync: salvarAviso, isPending: false }),
  useTestarAvisoDeCaso: () => ({ mutateAsync: vi.fn(), isPending: false, data: undefined }),
}));

import { AvisoNoWhatsApp } from "@/app/app/ai/cases/avisos/_components/AvisoNoWhatsApp";

const CANAL_QR = "11111111-1111-4111-8111-111111111111";
const CANAL_OFICIAL = "22222222-2222-4222-8222-222222222222";

const LACO_VAZIO = {
  comAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
  semAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
  medianaAteOAvisoMinutos: null,
};

function estado(patch: Partial<EstadoDoAviso> = {}): EstadoDoAviso {
  return {
    config: {
      channel_session_id: CANAL_QR,
      telefone: "+5531998966398",
      rotulo: "Plantão da Ana",
      ligado: true,
      repetir_lembretes_whatsapp: false,
      minutos_lembrete_equipe: [3, 6, 9],
      atualizado_em: "2026-09-18T12:00:00.000Z",
    },
    conexoes: [
      {
        id: CANAL_QR,
        nome: "Plantão",
        status: "WORKING",
        aceitaMensagemLivre: true,
        atendeClientes: false,
      },
      {
        id: CANAL_OFICIAL,
        nome: "Oficial",
        status: "WORKING",
        aceitaMensagemLivre: false,
        atendeClientes: true,
      },
    ],
    avisos: [],
    pode_ligar: true,
    entregas: [],
    laco: LACO_VAZIO,
    ...patch,
  };
}

function montar(
  dados: EstadoDoAviso | undefined,
  extra: { isLoading?: boolean; error?: unknown } = {},
) {
  consulta.mockReturnValue({
    data: dados,
    isLoading: extra.isLoading ?? false,
    isFetching: false,
    refetch: atualizarAviso,
    error: extra.error ?? null,
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AvisoNoWhatsApp />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  salvarAviso.mockReset().mockResolvedValue(undefined);
  atualizarAviso.mockReset();
});

describe("o seletor de conexão", () => {
  it("só oferece quem manda texto livre — a capacidade, nunca o provedor", () => {
    montar(estado());
    // O canal oficial está na lista de conexões e NÃO está no seletor: ele
    // aceitaria a configuração e nunca entregaria um aviso.
    expect(screen.queryByText("Oficial")).toBeNull();
  });

  it("sem nenhuma conexão que sirva, o seletor fica desabilitado", () => {
    montar(
      estado({
        conexoes: [
          {
            id: CANAL_OFICIAL,
            nome: "Oficial",
            status: "WORKING",
            aceitaMensagemLivre: false,
            atendeClientes: true,
          },
        ],
        config: null,
      }),
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});

describe("os avisos de estado viram frase", () => {
  it("cada código tem um bloco próprio, e o bloqueio é marcado no DOM", () => {
    montar(
      estado({
        avisos: [
          { codigo: "sem_endereco_publico", bloqueia: true },
          { codigo: "conexao_atende_clientes", bloqueia: false, dados: { conexao: "Plantão" } },
        ],
      }),
    );
    const bloqueio = screen.getByTestId("alerta-sem_endereco_publico");
    expect(bloqueio.dataset.bloqueia).toBe("sim");
    expect(bloqueio.textContent).toContain("endereço público ainda não foi configurado");

    const alerta = screen.getByTestId("alerta-conexao_atende_clientes");
    expect(alerta.dataset.bloqueia).toBe("nao");
    // Permitido, com alerta — é decisão registrada do dono do produto.
    expect(alerta.textContent).toContain("mais seguro");
  });

  it("o aquecimento mostra os NÚMEROS, que é a informação que faltava", () => {
    montar(
      estado({
        avisos: [
          {
            codigo: "aquecimento",
            bloqueia: false,
            // Meio-dia UTC de propósito: à meia-noite UTC esta data renderiza
            // no DIA ANTERIOR em qualquer fuso a oeste, e o caso reprovaria por
            // fuso da máquina — não por defeito da tela.
            dados: { enviadosHoje: 7, teto: 20, fimEm: "2026-10-12T12:00:00.000Z" },
          },
        ],
      }),
    );
    const bloco = screen.getByTestId("aquecimento-de-hoje");
    expect(bloco.textContent).toContain("7");
    expect(bloco.textContent).toContain("20");
    expect(bloco.textContent).toContain("12/10");
  });

  it("o descarte diz o total e a data — nunca um número que o banco não guarda", () => {
    montar(
      estado({
        avisos: [
          {
            codigo: "descarte_acontecendo",
            bloqueia: false,
            dados: { ignoradas: 3, ultimaEm: "2026-09-17T15:30:00.000Z" },
          },
        ],
      }),
    );
    const bloco = screen.getByTestId("descarte-de-hoje");
    expect(bloco.textContent).toContain("3");
    expect(bloco.textContent).toContain("17/09");
  });

  it("instalação saudável não mostra bloco de alerta nenhum", () => {
    montar(estado());
    expect(screen.queryByTestId("alertas-do-aviso")).toBeNull();
  });
});

describe("o switch e o botão de teste", () => {
  it("o switch fica travado quando a regra diz que não dá para ligar", () => {
    montar(estado({ pode_ligar: false, config: null }));
    expect(screen.getByRole("switch", { name: /^Receber avisos no WhatsApp$/ })).toBeDisabled();
  });

  it("sem endereço público o switch fica travado MESMO com conexão e número salvos", () => {
    // O caso que um `||` entre "o servidor deixa" e "o rascunho está completo"
    // deixaria passar: o aviso nasceria ligado com um link que não abre nada.
    montar(
      estado({
        pode_ligar: false,
        avisos: [{ codigo: "sem_endereco_publico", bloqueia: true }],
      }),
    );
    expect(screen.getByRole("switch", { name: /^Receber avisos no WhatsApp$/ })).toBeDisabled();
  });

  it("com tudo em ordem o switch destrava", () => {
    montar(estado());
    expect(screen.getByRole("switch", { name: /^Receber avisos no WhatsApp$/ })).toBeEnabled();
  });

  it("o botão de teste só fica ativo com configuração SALVA", () => {
    montar(estado({ config: null }));
    expect(screen.getByRole("button", { name: /teste/i })).toBeDisabled();

    montar(estado());
    expect(screen.getAllByRole("button", { name: /teste/i }).at(-1)).toBeEnabled();
  });

  it("o preço do teste está escrito ANTES do clique", () => {
    montar(estado());
    expect(screen.getByText(/conta no limite diário desse número/i)).toBeInTheDocument();
  });
});

describe("a lista de entregas", () => {
  it("vazia, explica o que vai aparecer ali — e não finge que está tudo bem", () => {
    montar(estado());
    expect(screen.getByTestId("entregas-vazias").textContent).toContain("inclusive se ela falhar");
  });

  it("mostra a situação, o destino MASCARADO e a frase do erro", () => {
    montar(
      estado({
        entregas: [
          {
            id: "e1",
            case_id: "c1",
            destino_mascarado: "••••6398",
            status: "falhou",
            erro_codigo: "teto_diario_do_numero",
            tentativas: 3,
            wait_generation: null,
            reminder_minute: null,
            enviado_em: null,
            created_at: "2026-09-17T10:00:00.000Z",
          },
          ...([3, 6, 9] as const).map((minuto) => ({
            id: `e-${minuto}`,
            case_id: "c1",
            destino_mascarado: "••••6398",
            status: "enviado",
            erro_codigo: null,
            tentativas: 1,
            wait_generation: 1,
            reminder_minute: minuto,
            enviado_em: `2026-09-17T10:${String(minuto).padStart(2, "0")}:00.000Z`,
            created_at: `2026-09-17T10:${String(minuto).padStart(2, "0")}:00.000Z`,
          })),
        ],
      }),
    );
    const lista = screen.getByTestId("lista-de-entregas");
    expect(lista.textContent).toContain("••••6398");
    expect(lista.textContent).toContain("limite diário do período de aquecimento");
    expect(lista.textContent).toContain("Aviso de abertura");
    expect(lista.textContent).toContain("Reforço de 3 minutos · Ciclo 1");
    expect(lista.textContent).toContain("Reforço de 6 minutos · Ciclo 1");
    expect(lista.textContent).toContain("Reforço de 9 minutos · Ciclo 1");
    expect(lista.textContent).toContain("Aceito pelo canal");
    expect(screen.getByText(/sem recibo de entrega, não confirma/i)).toBeInTheDocument();
    expect(screen.getAllByTestId("entrega-tipo")).toHaveLength(4);
    // O número inteiro nunca entra nesta lista: quem a lê pode ser `manager`.
    expect(lista.textContent).not.toContain("998966398");
  });
});

describe("o que a tela diz sem ninguém perguntar", () => {
  it("explica a cadência compartilhada entre Central e reforços WhatsApp", () => {
    montar(estado());
    expect(
      screen.getByText(/abertura e os reforços são opções independentes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A Central cria lembretes nos minutos configurados/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /Lembrete 1/i })).toHaveValue(3);
    expect(screen.getByRole("spinbutton", { name: /Lembrete 2/i })).toHaveValue(6);
    expect(screen.getByRole("spinbutton", { name: /Lembrete 3/i })).toHaveValue(9);
  });

  it("o opt-in de reforços salva sem alterar a configuração do aviso inicial", async () => {
    montar(estado());
    const avisoInicial = screen.getByRole("switch", { name: /^Receber avisos no WhatsApp$/ });
    expect(avisoInicial).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("switch", { name: /^Reforçar lembretes no WhatsApp$/ }));
    expect(avisoInicial).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(salvarAviso).toHaveBeenCalledWith(
        expect.objectContaining({
          ligado: true,
          repetir_lembretes_whatsapp: true,
          minutos_lembrete_equipe: [3, 6, 9],
          sem_link: false,
        }),
      ),
    );
  });

  it("adiciona e remove marcos, sem permitir apagar o último", async () => {
    montar(estado());
    fireEvent.click(screen.getByRole("button", { name: "Adicionar minuto" }));
    expect(screen.getByRole("spinbutton", { name: /Lembrete 4/i })).toHaveValue(12);

    fireEvent.click(screen.getByRole("button", { name: /Remover lembrete 2/i }));
    expect(screen.getAllByRole("spinbutton")).toHaveLength(3);
    expect(screen.getByRole("spinbutton", { name: /Lembrete 2/i })).toHaveValue(9);

    fireEvent.click(screen.getByRole("button", { name: /Remover lembrete 2/i }));
    fireEvent.click(screen.getByRole("button", { name: /Remover lembrete 2/i }));
    expect(screen.getByRole("button", { name: /Remover lembrete 1/i })).toBeDisabled();
  });

  it("limita o editor a dez marcos", () => {
    montar(estado());
    for (let i = 0; i < 7; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Adicionar minuto" }));
    }
    expect(screen.getAllByRole("spinbutton")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Adicionar minuto" })).toBeDisabled();
  });

  it("bloqueia salvar valores repetidos ou fora da ordem", () => {
    montar(estado());
    fireEvent.change(screen.getByRole("spinbutton", { name: /Lembrete 2/i }), {
      target: { value: "3" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Cada minuto pode aparecer uma vez só.");
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("atualiza o histórico sob demanda sem recarregar enquanto se digita", () => {
    montar(estado());
    fireEvent.change(screen.getByRole("spinbutton", { name: /Lembrete 1/i }), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Atualizar histórico" }));
    expect(atualizarAviso).toHaveBeenCalledOnce();
    expect(screen.getByRole("spinbutton", { name: /Lembrete 1/i })).toHaveValue(2);
  });

  it("o laço de retorno sem amostra diz que não há amostra, e não mostra zero", () => {
    montar(estado());
    const laco = screen.getByTestId("laco-do-aviso");
    expect(laco.textContent).toContain("Ainda não há casos suficientes");
    expect(laco.textContent).not.toContain("0 min");
  });

  it("com amostra, os dois grupos aparecem lado a lado", () => {
    montar(
      estado({
        laco: {
          comAviso: { casos: 4, respondidos: 3, medianaMinutos: 12 },
          semAviso: { casos: 6, respondidos: 5, medianaMinutos: 190 },
          medianaAteOAvisoMinutos: 1,
        },
      }),
    );
    const laco = screen.getByTestId("laco-do-aviso");
    expect(laco.textContent).toContain("12 min");
    expect(laco.textContent).toContain("190 min");
  });
});

describe("a tela degrada sem mentir", () => {
  it("falha de leitura não vira formulário vazio ligável", () => {
    montar(undefined, { error: new Error("boom") });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/Não foi possível abrir esta tela agora/i)).toBeInTheDocument();
  });
});

describe("seleção do modo local", () => {
  it("bloqueia o teste real enquanto a configuração alterada ainda não foi salva", () => {
    montar(estado());
    const testar = screen.getByRole("button", { name: "Enviar aviso de teste" });
    expect(testar).toBeEnabled();

    fireEvent.click(screen.getByRole("switch", { name: /^Sem link — resolver neste computador$/ }));
    expect(testar).toBeDisabled();
  });

  it("liga sem domínio e volta a bloquear ao desmarcar o modo local", () => {
    montar(estado({ avisos: [{ codigo: "sem_endereco_publico", bloqueia: true }] }));
    const receber = screen.getByRole("switch", { name: /^Receber avisos no WhatsApp$/ });
    expect(receber).toBeDisabled();
    const local = screen.getByRole("switch", {
      name: /^Sem link — resolver neste computador$/,
    });
    fireEvent.click(local);
    expect(receber).toBeEnabled();
    fireEvent.click(local);
    expect(receber).toBeDisabled();
    expect(receber).toHaveAttribute("aria-checked", "false");
  });
});
