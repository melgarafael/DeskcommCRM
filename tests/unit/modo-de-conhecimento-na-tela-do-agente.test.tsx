/**
 * O MODO DE CONHECIMENTO ESCOLHIDO NA TELA É O QUE O RUNTIME LÊ (#4358).
 *
 * ─── O defeito medido ──────────────────────────────────────────────────────
 *
 * `knowledge_mode` existe desde a 1.104.0 (`lib/ai/guardrails-schema.ts:188`) e
 * o motor sabe usá-lo (`lib/agent-engine/agent/modo-de-conhecimento.ts`), mas a
 * tela do agente não tinha seletor nenhum: a única forma de sair de `busca` era
 * editar o JSON da configuração. E o texto da seção prometia mais do que o modo
 * `busca` faz — "Ele procura ali antes de responder, em vez de improvisar" —
 * quando naquele modo quem decide chamar `search_knowledge` é o MODELO, a cada
 * mensagem (`lib/agent-engine/agent/inbound-turn.ts`, sem `toolChoice`). Quem
 * leu o texto acreditou que a busca era garantida; ela não é.
 *
 * ─── O que cada caso cobra ─────────────────────────────────────────────────
 *
 *  1. o modo que está no banco aparece SELECIONADO na tela (leitura do atual,
 *     não só o default do produto);
 *  2. trocar o seletor grava `ai_agents.config.knowledge_mode` pela MESMA rota
 *     das outras guardas (PATCH do agente), com o valor escolhido;
 *  3. o corpo desse PATCH passa pelo schema da borda e o LEITOR DO RUNTIME
 *     devolve `leitura_direta` — a prova de que a tela e o motor falam o mesmo
 *     vocabulário, e não de que a tela desenha um `<select>` bonito;
 *  4. quando o PATCH falha, a tela VOLTA ao valor gravado e avisa — nunca fica
 *     dizendo um modo que o banco não tem;
 *  5. o texto da seção diz que quem decide consultar é o modelo (modo `busca`)
 *     e o que a leitura direta faz de fato; a promessa antiga não volta;
 *  6. controle positivo: material marcado continua indo pelo formulário, sem
 *     PATCH nenhum, e agente NOVO (sem id) não mostra seletor porque não há
 *     config para gravar ainda.
 */
import { useState } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { patch, sucesso, erroNaTela } = vi.hoisted(() => ({
  patch: vi.fn(),
  sucesso: vi.fn(),
  erroNaTela: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
vi.mock("sonner", () => ({ toast: { success: sucesso, error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: erroNaTela }));
// `t` devolve a chave: o que aparece no DOM é o português que a tela mostra.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

import { BasesDoAgente } from "@/app/app/ai/agents/[id]/_components/BasesDoAgente";
import type { MaterialDoAcervo } from "@/app/app/ai/agents/[id]/_components/BasesDoAgente";
import { lerModoDeConhecimento } from "@/lib/agent-engine/agent/modo-de-conhecimento";
import { agentConfigPatchSchema } from "@/lib/ai/guardrails-schema";

const AGENTE = "77777777-7777-4777-8777-777777777777";

const POLITICA: MaterialDoAcervo = {
  id: "mat-politica",
  name: "Política de troca",
  source_type: "text",
  chunks_count: 4,
  last_index_status: "ready",
};

/**
 * Bancada no molde do `AgentForm`: materiais controlados (é a versão que
 * salva) e o modo vindo de `agent.config`, que é quem grava por PATCH.
 */
function Bancada({
  modoInicial = "busca",
  novo = false,
}: {
  modoInicial?: unknown;
  /** Agente ainda não criado: a tela não tem id para gravar o `config`. */
  novo?: boolean;
}) {
  const [value, setValue] = useState<string[]>([POLITICA.id]);
  return (
    <BasesDoAgente
      materiais={[POLITICA]}
      value={value}
      onChange={setValue}
      agentId={novo ? undefined : AGENTE}
      modoInicial={modoInicial}
    />
  );
}

function seletor(): HTMLSelectElement {
  return screen.getByTestId("modo-de-conhecimento") as HTMLSelectElement;
}

beforeEach(() => {
  patch.mockResolvedValue({ data: {} });
});
afterEach(() => {
  cleanup();
  patch.mockReset();
  sucesso.mockReset();
  erroNaTela.mockReset();
});

describe("modo de conhecimento na tela do agente (#4358)", () => {
  it("o modo gravado no agente aparece selecionado — leitura do atual, não o default", () => {
    render(<Bancada modoInicial="leitura_direta" />);

    expect(seletor().value).toBe("leitura_direta");
    expect([...seletor().options].map((o) => o.value)).toEqual(["busca", "leitura_direta"]);
  });

  it("escolher leitura_direta grava knowledge_mode no config do agente", async () => {
    render(<Bancada />);

    fireEvent.change(seletor(), { target: { value: "leitura_direta" } });

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [rota, corpo] = patch.mock.calls[0] as [string, { config: unknown }];
    expect(rota).toBe(`/api/v1/ai/agents/${AGENTE}`);
    expect(corpo).toEqual({ config: { knowledge_mode: "leitura_direta" } });
    await waitFor(() => expect(sucesso).toHaveBeenCalled());
  });

  it("o que a tela grava é o que o schema aceita e o runtime lê", async () => {
    render(<Bancada />);
    fireEvent.change(seletor(), { target: { value: "leitura_direta" } });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    const [, corpo] = patch.mock.calls[0] as [string, { config: unknown }];
    // A borda do PATCH é quem valida: se a tela mandasse um valor fora do
    // vocabulário, o parse jogaria fora em vez de gravar lixo.
    const aceitoPeloSchema = agentConfigPatchSchema.parse(corpo.config);
    // E o motor lê exatamente este campo, uma vez por turno.
    expect(lerModoDeConhecimento(aceitoPeloSchema)).toBe("leitura_direta");
  });

  it("PATCH que falha devolve a tela ao modo gravado e avisa", async () => {
    patch.mockRejectedValueOnce(new Error("500"));
    render(<Bancada />);

    fireEvent.change(seletor(), { target: { value: "leitura_direta" } });

    await waitFor(() => expect(erroNaTela).toHaveBeenCalled());
    expect(seletor().value).toBe("busca");
    expect(sucesso).not.toHaveBeenCalled();
  });

  it("o texto diz que quem decide consultar é o modelo, e não promete busca sempre", () => {
    render(<Bancada />);

    const texto = document.body.textContent ?? "";
    // A promessa antiga era falsa no modo `busca` — ela não pode voltar.
    expect(texto).not.toContain("em vez de improvisar");
    expect(texto).not.toContain("Ele procura ali antes de responder");
    // O que a tela diz agora, e é verdade nos dois modos.
    expect(texto).toContain("Quem decide, a cada mensagem, é o modelo");
    expect(texto).toContain("pode responder sem consultar");
  });

  it("o texto de cada modo descreve o que ele faz de fato", () => {
    render(<Bancada modoInicial="busca" />);
    expect(screen.getByTestId("modo-de-conhecimento-explicacao").textContent).toContain(
      "recebe a ferramenta de busca",
    );

    fireEvent.change(seletor(), { target: { value: "leitura_direta" } });

    expect(screen.getByTestId("modo-de-conhecimento-explicacao").textContent).toContain(
      "lista dos materiais",
    );
  });

  it("controle positivo: marcar material continua indo pelo formulário, sem PATCH", () => {
    render(<Bancada />);

    fireEvent.click(screen.getByTestId(`base-${POLITICA.id}`));

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByTestId(`base-${POLITICA.id}`)).not.toBeChecked();
  });

  it("controle positivo: agente NOVO (sem id) não oferece o seletor — não há config para gravar", () => {
    render(<Bancada novo />);

    expect(screen.queryByTestId("modo-de-conhecimento")).toBeNull();
    // O resto da seção segue funcionando.
    expect(screen.getByTestId(`base-${POLITICA.id}`)).toBeTruthy();
  });
});
