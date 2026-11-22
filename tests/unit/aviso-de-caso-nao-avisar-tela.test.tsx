/**
 * A TELA DO AVISO, com a marca "Não enviar aviso de caso" por membro (#4989).
 *
 * O que se mede aqui é o que a pessoa vê e o CORPO que sai ao salvar: a marca
 * viaja só para quem a pessoa mexeu (um membro que a tela não mostrou não perde
 * a marca por omissão), o número de quem está marcado continua editável (ele
 * ainda serve ao aviso de proposta) e as frases que deixariam de ser verdade
 * mudaram.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

import type { EstadoDoAviso } from "@/hooks/ai/useAvisoDeCaso";

const consulta = vi.fn();
const salvarRegistrado = vi.fn(async (_corpo: Record<string, unknown>) => undefined);
const marcasRegistradas = vi.fn(async (_corpo: Record<string, unknown>) => undefined);
vi.mock("@/hooks/ai/useAvisoDeCaso", () => ({
  CHAVE_DO_AVISO: ["ai-aviso-de-caso"],
  useAvisoDeCaso: () => consulta(),
  useSalvarAvisoDeCaso: () => ({ mutateAsync: salvarRegistrado, isPending: false }),
  useSalvarMarcasDoAviso: () => ({ mutateAsync: marcasRegistradas, isPending: false }),
  useRemoverAvisoDeCaso: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestarAvisoDeCaso: () => ({ mutateAsync: vi.fn(), isPending: false, data: undefined }),
}));

beforeEach(() => {
  salvarRegistrado.mockClear();
  marcasRegistradas.mockClear();
});

import { AvisoNoWhatsApp } from "@/app/app/ai/cases/avisos/_components/AvisoNoWhatsApp";

const CANAL = "11111111-1111-4111-8111-111111111111";
const ANA = "5f000000-0000-4000-8000-00000000a001";
const FILA = "5f000000-0000-4000-8000-00000000a002";

type Membro = EstadoDoAviso["equipe"][number];

function estado(patch: Partial<EstadoDoAviso> = {}, equipe?: Membro[]): EstadoDoAviso {
  return {
    config: {
      channel_session_id: CANAL,
      telefone: "+5531998966398",
      rotulo: null,
      ligado: true,
      resposta_whatsapp_habilitada: false,
      atualizado_em: "2026-11-21T12:00:00.000Z",
      destino_modo: "responsavel",
    },
    equipe: equipe ?? [
      { user_id: ANA, nome: "Ana", whatsapp: "+5531988881111", nao_avisar: false },
      { user_id: FILA, nome: "Marketing · Fornecedores", whatsapp: "+5531977772222", nao_avisar: true },
    ],
    conexoes: [{ id: CANAL, nome: "Plantão", status: "WORKING", aceitaMensagemLivre: true, atendeClientes: false }],
    avisos: [],
    pode_ligar: true,
    algum_membro_sem_aviso: true,
    entregas: [],
    laco: {
      comAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
      semAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
      medianaAteOAvisoMinutos: null,
    },
    ...patch,
  } as EstadoDoAviso;
}

function arvore() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AvisoNoWhatsApp />
    </QueryClientProvider>
  );
}

function montar(dados: EstadoDoAviso) {
  consulta.mockReturnValue({ data: dados, isLoading: false, error: null });
  return render(arvore());
}

function corpoEnviado() {
  return salvarRegistrado.mock.calls[0]![0] as unknown as {
    nao_avisar?: Array<{ user_id: string; nao_avisar: boolean }>;
  };
}

describe("a marca na lista da equipe", () => {
  it("cada pessoa tem o interruptor, e o de quem está marcado nasce ligado", () => {
    montar(estado());
    expect(screen.getByRole("switch", { name: "Não enviar aviso de caso: Ana" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Não enviar aviso de caso: Marketing · Fornecedores" })).toBeChecked();
    expect(screen.getAllByText("Os casos desta pessoa não geram aviso no WhatsApp. Continuam no painel Casos.")).toHaveLength(1);
  });

  it("o número de quem está marcado continua editável", () => {
    montar(estado());
    const campo = screen.getByLabelText("Marketing · Fornecedores");
    expect(campo).toBeEnabled();
    expect(campo).toHaveValue("+5531977772222");
  });

  it("só a marca mudou: vai pelo PATCH, só com quem a pessoa mexeu, e o RPC da configuração não é chamado", async () => {
    montar(estado());
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("switch", { name: "Não enviar aviso de caso: Ana" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(marcasRegistradas).toHaveBeenCalledWith({ nao_avisar: [{ user_id: ANA, nao_avisar: true }] });
    expect(salvarRegistrado).not.toHaveBeenCalled();
  });

  it("a marca e outro campo mudaram: vai pelo PUT, com a marca de quem a pessoa mexeu", async () => {
    montar(estado());
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("switch", { name: "Não enviar aviso de caso: Ana" }));
    await user.type(screen.getByLabelText("Como chamar esse número (opcional)"), "Plantão");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(marcasRegistradas).not.toHaveBeenCalled();
    expect(corpoEnviado().nao_avisar).toEqual([{ user_id: ANA, nao_avisar: true }]);
  });

  it("ligar e desligar de novo não manda nada", async () => {
    montar(estado());
    const user = userEvent.setup({ delay: null });
    const ana = screen.getByRole("switch", { name: "Não enviar aviso de caso: Ana" });
    await user.click(ana);
    await user.click(ana);
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(marcasRegistradas).not.toHaveBeenCalled();
    expect(corpoEnviado().nao_avisar).toBeUndefined();
  });

  it("a releitura trouxe o número novo de um colega: mexer só na marca continua indo pelo PATCH", async () => {
    const { rerender } = montar(estado());
    consulta.mockReturnValue({
      data: estado({}, [
        { user_id: ANA, nome: "Ana", whatsapp: "+5531911112222", nao_avisar: false },
        { user_id: FILA, nome: "Marketing · Fornecedores", whatsapp: "+5531977772222", nao_avisar: true },
      ]),
      isLoading: false,
      error: null,
    });
    rerender(arvore());
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("switch", { name: "Não enviar aviso de caso: Marketing · Fornecedores" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(salvarRegistrado).not.toHaveBeenCalled();
    expect(marcasRegistradas).toHaveBeenCalledWith({ nao_avisar: [{ user_id: FILA, nao_avisar: false }] });
  });

  it("a marca voltou numa releitura (sem nova gravação): a tela mostra o valor do servidor e salvar não a desfaz", async () => {
    const semLer = estado({ nao_avisar_indisponivel: true }, [
      { user_id: ANA, nome: "Ana", whatsapp: "+5531988881111", nao_avisar: false },
      { user_id: FILA, nome: "Marketing · Fornecedores", whatsapp: "+5531977772222", nao_avisar: false },
    ]);
    const { rerender } = montar(semLer);
    // A consulta é refeita (ex.: depois do teste) e a leitura da marca voltou;
    // a configuração não mudou, então o formulário não renasce.
    consulta.mockReturnValue({ data: estado(), isLoading: false, error: null });
    rerender(arvore());
    expect(screen.getByRole("switch", { name: "Não enviar aviso de caso: Marketing · Fornecedores" })).toBeChecked();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(marcasRegistradas).not.toHaveBeenCalled();
    expect(corpoEnviado().nao_avisar).toBeUndefined();
  });

  it("a marca não pôde ser lida: os interruptores travam, a tela pede para atualizar, e salvar não mexe nela", async () => {
    montar(
      estado({ nao_avisar_indisponivel: true }, [
        { user_id: ANA, nome: "Ana", whatsapp: "+5531988881111", nao_avisar: false },
      ]),
    );
    expect(screen.getByRole("switch", { name: "Não enviar aviso de caso: Ana" })).toBeDisabled();
    expect(screen.getByTestId("nao-avisar-indisponivel").textContent).toContain("Atualize a página");
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(corpoEnviado().nao_avisar).toBeUndefined();
  });
});

describe("as frases que mudam com a marca", () => {
  it("a explicação da ordem diz que a vez de alguém marcado para o aviso, mesmo depois de pular quem não tem número", () => {
    montar(estado());
    expect(
      screen.getByText(
        "O aviso vai para quem está com a conversa; se essa pessoa não tiver WhatsApp cadastrado, para quem é dono do negócio; depois, para o dono da carteira do contato. Se ninguém tiver, vai para o número acima. Se nessa ordem a vez chegar a alguém com \"Não enviar aviso de caso\" ligado — mesmo depois de pular quem não tem número —, o aviso do caso não sai para ninguém, nem para o número acima.",
      ),
    ).toBeInTheDocument();
  });

  it("a frase do bloco da equipe não promete mais que o aviso sempre tem destinatário", () => {
    montar(estado());
    expect(screen.queryByText(/o aviso não fica sem destinatário/)).toBeNull();
    expect(
      screen.getByText(
        "É este número que recebe o aviso quando a pessoa é a responsável. Sem número, ela é pulada e o aviso segue para o próximo da ordem. Com \"Não enviar aviso de caso\" ligado, o aviso do caso para nela e não sai.",
      ),
    ).toBeInTheDocument();
  });

  it("ninguém com número e alguém marcado: a frase não diz que todo aviso vai para o número acima", () => {
    montar(
      estado({}, [
        { user_id: ANA, nome: "Ana", whatsapp: null, nao_avisar: false },
        { user_id: FILA, nome: "Marketing · Fornecedores", whatsapp: null, nao_avisar: true },
      ]),
    );
    expect(
      screen.getByText(
        "Ninguém da equipe tem WhatsApp cadastrado: os avisos vão continuar saindo para o número acima, menos os casos de quem está com \"Não enviar aviso de caso\" ligado.",
      ),
    ).toBeInTheDocument();
  });

  it("ninguém com número e o único marcado está fora da lista mostrada: a frase não promete o número acima para todos", () => {
    montar(
      estado({ algum_membro_sem_aviso: true }, [
        { user_id: ANA, nome: "Ana", whatsapp: null, nao_avisar: false },
      ]),
    );
    expect(screen.getByText(/menos os casos de quem está com "Não enviar aviso de caso" ligado/)).toBeInTheDocument();
  });

  it("a lista dos últimos avisos avisa que os casos parados pela marca não entram nela — pelo que o SERVIDOR mediu", () => {
    // Ninguém marcado entre os mostrados: o marcado está além do teto da lista.
    montar(
      estado({ algum_membro_sem_aviso: true }, [
        { user_id: ANA, nome: "Ana", whatsapp: "+5531988881111", nao_avisar: false },
      ]),
    );
    expect(screen.getByTestId("entregas-sem-quem-nao-recebe").textContent).toContain(
      "nenhuma linha entra aqui",
    );
  });

  it("sem ninguém marcado, essa frase não aparece", () => {
    montar(estado({ algum_membro_sem_aviso: false }));
    expect(screen.queryByTestId("entregas-sem-quem-nao-recebe")).toBeNull();
  });
});
