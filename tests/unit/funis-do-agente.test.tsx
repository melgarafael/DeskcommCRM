import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FunisDoAgente } from "@/app/app/ai/agents/[id]/_components/FunisDoAgente";
import type { FunilDaResposta } from "@/hooks/pipelines/usePipelines";

/**
 * A TELA ONDE SE MARCA EM QUE FUNIS O ASSISTENTE MEXE (spec 17 passo 3).
 *
 * O que esta tela precisa dizer, e que a medição mostrou ser necessário:
 *
 *  1. **o estado vazio é NOMEADO** — nenhum funil marcado é o default e é falha
 *     fechada, mas quem liga o papel e não marca nada concluiria que quebrou;
 *  2. **o funil de ENTRADA fora da marcação é AVISADO** — é o caso silencioso:
 *     o sistema cria um card por conversa todo dia num funil que o assistente é
 *     proibido de tocar, enquanto ele conversa normalmente;
 *  3. **nenhum jargão** — o dono de uma clínica lê esta tela.
 */

function funil(id: string, name: string, is_default = false): FunilDaResposta {
  return { id, name, slug: name.toLowerCase(), description: null, position: 1, is_default, is_client_pipeline: false };
}

const PEDIDOS = funil("11111111-1111-4111-8111-111111111111", "Pedidos", true);
const ANDREA = funil("22222222-2222-4222-8222-222222222222", "Comercial - Andrea");
const SUPORTE = funil("33333333-3333-4333-8333-333333333333", "Suporte - IA");
const TODOS = [PEDIDOS, ANDREA, SUPORTE];

describe("a marcação", () => {
  it("lista os funis da organização e marca só os escolhidos", () => {
    render(<FunisDoAgente funis={TODOS} value={[ANDREA.id]} onChange={() => {}} />);
    expect(screen.getByLabelText("Comercial - Andrea")).toBeChecked();
    expect(screen.getByLabelText("Pedidos")).not.toBeChecked();
    expect(screen.getByLabelText("Suporte - IA")).not.toBeChecked();
  });

  it("marcar ACRESCENTA sem apagar o que já estava", async () => {
    // O bug clássico de um seletor múltiplo: o clique substitui em vez de somar,
    // e o dono perde a marcação anterior sem perceber.
    const onChange = vi.fn();
    render(<FunisDoAgente funis={TODOS} value={[ANDREA.id]} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Suporte - IA"));
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([ANDREA.id, SUPORTE.id]));
    expect((onChange.mock.calls[0]?.[0] as string[]).length).toBe(2);
  });

  it("desmarcar REMOVE só aquele", async () => {
    const onChange = vi.fn();
    render(<FunisDoAgente funis={TODOS} value={[ANDREA.id, SUPORTE.id]} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText("Comercial - Andrea"));
    expect(onChange).toHaveBeenCalledWith([SUPORTE.id]);
  });

  it("em modo leitura, nada é clicável", () => {
    render(<FunisDoAgente funis={TODOS} value={[]} onChange={() => {}} disabled />);
    expect(screen.getByLabelText("Pedidos")).toBeDisabled();
  });
});

describe("o que a tela EXPLICA", () => {
  it("nenhum funil marcado é explicado, não deixado em branco", () => {
    // Estado legítimo (é o default e é falha fechada), mas silêncio aqui faria
    // o dono concluir que a configuração quebrou.
    render(<FunisDoAgente funis={TODOS} value={[]} onChange={() => {}} />);
    const aviso = screen.getByTestId("agente-sem-funil");
    expect(aviso.textContent).toMatch(/conversa.*normalmente/i);
    expect(aviso.textContent).toMatch(/não mexe em negócio/i);
  });

  it("AVISA quando o funil de entrada ficou de fora — o caso silencioso", () => {
    // O sistema cria um card por conversa nova no funil padrão (passo 1). Se ele
    // não estiver marcado, os cards se acumulam num lugar que o assistente não
    // pode organizar — e nada nisso dá erro.
    render(<FunisDoAgente funis={TODOS} value={[ANDREA.id]} onChange={() => {}} />);
    const aviso = screen.getByTestId("agente-entrada-de-fora");
    expect(aviso.textContent).toContain("Pedidos");
    expect(aviso.textContent).toMatch(/acumular/i);
  });

  it("NÃO avisa quando o funil de entrada está marcado", () => {
    render(<FunisDoAgente funis={TODOS} value={[PEDIDOS.id]} onChange={() => {}} />);
    expect(screen.queryByTestId("agente-entrada-de-fora")).toBeNull();
  });

  it("NÃO avisa quando nada foi marcado — um aviso de cada vez", () => {
    // Com escopo vazio o problema é outro (e já tem sua própria frase). Mostrar
    // os dois juntos daria duas instruções conflitantes para o mesmo estado.
    render(<FunisDoAgente funis={TODOS} value={[]} onChange={() => {}} />);
    expect(screen.queryByTestId("agente-entrada-de-fora")).toBeNull();
  });

  it("diz QUAL funil recebe as conversas novas", () => {
    render(<FunisDoAgente funis={TODOS} value={[]} onChange={() => {}} />);
    expect(screen.getByText(/é para cá que vão as conversas novas/i)).toBeInTheDocument();
  });

  it("organização sem nenhum funil recebe instrução, não uma lista vazia", () => {
    render(<FunisDoAgente funis={[]} value={[]} onChange={() => {}} />);
    expect(screen.getByText(/crie um em funis/i)).toBeInTheDocument();
  });
});

describe("linguagem", () => {
  it("nenhum jargão técnico aparece na tela", () => {
    // Mesmo gate que o painel do Operador já aplica: o dono de uma clínica lê
    // esta tela, e "escopo"/"pipeline_ids" não significam nada para ele.
    const { container } = render(
      <FunisDoAgente funis={TODOS} value={[ANDREA.id]} onChange={() => {}} />,
    );
    const texto = container.textContent ?? "";
    for (const proibida of ["escopo", "pipeline_ids", "pipeline", "uuid", "array", "permissão"]) {
      expect(texto.toLowerCase(), `a palavra "${proibida}" vazou para a tela`).not.toContain(
        proibida,
      );
    }
  });

  it("o texto principal diz o que ACONTECE, não o nome do campo", () => {
    const { container } = render(<FunisDoAgente funis={TODOS} value={[]} onChange={() => {}} />);
    const texto = container.textContent ?? "";
    expect(texto).toMatch(/move, edita ou encerra negócio/i);
  });
});

describe("a lacuna de tradução (passo 4)", () => {
  const MUDO = { [ANDREA.id]: { traduzidos: 0, total: 5, mudo: true } };
  const TRADUZIDO = { [ANDREA.id]: { traduzidos: 5, total: 5, mudo: false } };

  it("funil MARCADO que o assistente não sabe percorrer é sinalizado", () => {
    // Medido na produção: 3 dos 4 funis com ZERO tradução, e a única forma de
    // descobrir isso era entrar funil por funil na tela de configuração.
    render(
      <FunisDoAgente funis={TODOS} value={[ANDREA.id]} onChange={() => {}} cobertura={MUDO} />,
    );
    expect(screen.getByTestId(`funil-mudo-${ANDREA.id}`)).toBeInTheDocument();
    const bloco = screen.getByTestId("agente-funis-mudos");
    expect(bloco.textContent).toContain("Comercial - Andrea");
    // Diz a CONSEQUÊNCIA, não o nome da configuração que falta.
    expect(bloco.textContent).toMatch(/deixar os negócios parados/i);
  });

  it("funil NÃO marcado com a mesma lacuna fica quieto", () => {
    // Fora do escopo a lacuna não custa nada: ninguém prometeu que o assistente
    // organizaria aquele funil. Mostrá-la ali seria cobrar configuração que não
    // foi pedida — e é assim que um aviso vira ruído.
    render(<FunisDoAgente funis={TODOS} value={[]} onChange={() => {}} cobertura={MUDO} />);
    expect(screen.queryByTestId(`funil-mudo-${ANDREA.id}`)).toBeNull();
    expect(screen.queryByTestId("agente-funis-mudos")).toBeNull();
  });

  it("funil marcado E traduzido não gera aviso nenhum", () => {
    render(
      <FunisDoAgente funis={TODOS} value={[ANDREA.id]} onChange={() => {}} cobertura={TRADUZIDO} />,
    );
    expect(screen.queryByTestId("agente-funis-mudos")).toBeNull();
  });

  it("sem dado de cobertura, a tela CALA sobre tradução", () => {
    // Melhor calar que exibir "não sabe organizar" para todo funil só porque o
    // dado não chegou — seria alarme falso na primeira renderização.
    render(<FunisDoAgente funis={TODOS} value={[ANDREA.id]} onChange={() => {}} />);
    expect(screen.queryByTestId("agente-funis-mudos")).toBeNull();
  });
});
