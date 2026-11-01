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
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { EstadoDoAviso } from "@/hooks/ai/useAvisoDeCaso";

const consulta = vi.fn();
vi.mock("@/hooks/ai/useAvisoDeCaso", () => ({
  CHAVE_DO_AVISO: ["ai-aviso-de-caso"],
  useAvisoDeCaso: () => consulta(),
  useSalvarAvisoDeCaso: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoverAvisoDeCaso: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
      resposta_whatsapp_habilitada: false,
      atualizado_em: "2026-09-18T12:00:00.000Z",
    },
    conexoes: [
      { id: CANAL_QR, nome: "Plantão", status: "WORKING", aceitaMensagemLivre: true, atendeClientes: false },
      { id: CANAL_OFICIAL, nome: "Oficial", status: "WORKING", aceitaMensagemLivre: false, atendeClientes: true },
    ],
    avisos: [],
    pode_ligar: true,
    entregas: [],
    laco: LACO_VAZIO,
    ...patch,
  };
}

function montar(dados: EstadoDoAviso | undefined, extra: { isLoading?: boolean; error?: unknown } = {}) {
  consulta.mockReturnValue({ data: dados, isLoading: extra.isLoading ?? false, error: extra.error ?? null });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AvisoNoWhatsApp />
    </QueryClientProvider>,
  );
}

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
          { id: CANAL_OFICIAL, nome: "Oficial", status: "WORKING", aceitaMensagemLivre: false, atendeClientes: true },
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
    expect(bloqueio.textContent).toContain("endereço público do sistema ainda não foi configurado");

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

  it("o texto do descarte segue a opção de responder casos pelo WhatsApp", () => {
    const descarte = (comandos: number) =>
      estado({
        avisos: [
          {
            codigo: "descarte_acontecendo",
            bloqueia: false,
            dados: { ignoradas: 3, ultimaEm: "2026-09-17T15:30:00.000Z", comandos },
          },
        ],
      });
    const { unmount } = montar(descarte(0));
    expect(screen.getByTestId("alerta-descarte_acontecendo").textContent).toContain(
      "não chega ao CRM",
    );
    expect(screen.getByTestId("alerta-descarte_acontecendo").textContent).not.toContain("RESPONDER");
    unmount();
    montar(descarte(1));
    expect(screen.getByTestId("alerta-descarte_acontecendo").textContent).toContain("RESPONDER");
  });

  it("instalação saudável não mostra bloco de alerta nenhum", () => {
    montar(estado());
    expect(screen.queryByTestId("alertas-do-aviso")).toBeNull();
  });
});

describe("o switch e o botão de teste", () => {
  it("o switch fica travado quando a regra diz que não dá para ligar", () => {
    montar(estado({ pode_ligar: false, config: null }));
    expect(screen.getByRole("switch", { name: "Receber avisos no WhatsApp" })).toBeDisabled();
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
    expect(screen.getByRole("switch", { name: "Receber avisos no WhatsApp" })).toBeDisabled();
  });

  it("com tudo em ordem o switch destrava", () => {
    montar(estado());
    expect(screen.getByRole("switch", { name: "Receber avisos no WhatsApp" })).toBeEnabled();
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
    const vazia = screen.getByTestId("entregas-vazias");
    expect(vazia.textContent).toContain("Ainda não há avisos de casos nesta lista");
    expect(vazia.textContent).toContain("inclusive se falharem");
    expect(screen.getByRole("heading", { name: "Últimos avisos de casos" })).toBeInTheDocument();
    expect(screen.getByText(/o resultado dos avisos de transferência para atendimento humano/i).textContent)
      .toContain("respectivo item da Central de alertas");
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
            enviado_em: null,
            created_at: "2026-09-17T10:00:00.000Z",
          },
        ],
      }),
    );
    const lista = screen.getByTestId("lista-de-entregas");
    expect(lista.textContent).toContain("••••6398");
    expect(lista.textContent).toContain("limite diário do período de aquecimento");
    // O número inteiro nunca entra nesta lista: quem a lê pode ser `manager`.
    expect(lista.textContent).not.toContain("998966398");
  });
});

describe("o que a tela diz sem ninguém perguntar", () => {
  it("distingue o caso que não repete do novo episódio de transferência", () => {
    montar(estado());
    expect(screen.getByText(/o aviso não se repete/i).textContent)
      .toContain("Quando o cliente responde e o caso volta a esperar você");
    const transferencia = screen.getByText(/nas transferências para atendimento humano/i);
    expect(transferencia.textContent).toContain("uma tentativa de aviso por episódio");
    expect(transferencia.textContent).toContain("sem resumo da conversa");
    expect(transferencia.textContent).toContain(
      "Depois de retomar o atendimento automático, uma nova transferência pode gerar outro aviso",
    );
    expect(transferencia.textContent).toContain("Consulte o resultado na Central de alertas");
    expect(transferencia.textContent).toContain("responda ao cliente pelo CRM");
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

describe("a remoção do destinatário (issue #3338)", () => {
  it("só aparece com configuração SALVA — antes disso não há o que remover", () => {
    montar(estado({ config: null }));
    expect(screen.queryByRole("button", { name: /remover destinatário/i })).toBeNull();

    montar(estado());
    expect(
      screen.getAllByRole("button", { name: /remover destinatário/i }).at(-1),
    ).toBeInTheDocument();
  });

  it("a confirmação diz a consequência ANTES de apagar, e dá como voltar atrás", () => {
    montar(estado());
    fireEvent.click(screen.getByRole("button", { name: "Remover destinatário" }));

    const bloco = screen.getByTestId("confirmar-remocao");
    expect(bloco.textContent).toContain("volta a ser um número comum");
    // A configuração apagada também é lida pela Agenda e pela ação "Mensagem
    // para a equipe": a confirmação tem de dizer que esses envios param junto.
    expect(bloco.textContent).toContain("Agenda");
    expect(bloco.textContent).toContain("Mensagem para a equipe");
    expect(screen.getByRole("button", { name: "Manter" })).toBeInTheDocument();

    // Desistir fecha a pergunta e não é remoção nenhuma.
    fireEvent.click(screen.getByRole("button", { name: "Manter" }));
    expect(screen.queryByTestId("confirmar-remocao")).toBeNull();
  });

  it("a remoção é OUTRA coisa que o switch: a tela diz isso", () => {
    montar(estado());
    expect(screen.getByText(/sai da configuração e volta a entrar no Inbox/i)).toBeInTheDocument();
  });
});

describe("a tela degrada sem mentir", () => {
  it("falha de leitura não vira formulário vazio ligável", () => {
    montar(undefined, { error: new Error("boom") });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/Não foi possível abrir esta tela agora/i)).toBeInTheDocument();
  });
});
