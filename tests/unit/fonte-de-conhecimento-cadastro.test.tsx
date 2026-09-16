/**
 * Cadastro de material de conhecimento pela tela.
 *
 * ## O que este arquivo vigiava (issue #265) e continua vigiando
 *
 * O diálogo antigo mandava `tipo === "policy" ? "policy" : "faq"`: quem clicava
 * em "Configurar Catálogo" criava uma fonte `faq`, colidia com o índice único e
 * recebia um 500 genérico. O remendo — mentir o tipo no envio — era consequência
 * de um defeito maior: o diálogo NUNCA deveria ter sido oferecido a "Catálogo" e
 * "Conversas", que são preenchidos por rotina. Controle decorativo.
 *
 * A invariante sobrevive à reescrita da 0181: **o tipo que a pessoa escolheu é o
 * tipo que chega na API, e a tela só oferece controle onde há ação por trás.**
 * O que mudou é a forma — quatro slots presos ao agente padrão viraram uma
 * biblioteca da organização com escolha de tipo.
 *
 * ## O que este arquivo passou a vigiar
 *
 * A falta de chave de embedding é DITA antes do cadastro. Era o silêncio mais
 * caro do fluxo: numa instalação sem `OPENAI_API_KEY` — o estado de todo
 * primeiro deploy, já que o campo do instalador é pulável com Enter — a tela
 * prometia "a indexação começa em instantes", o material subia, e nada
 * acontecia nunca.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toastErro = vi.fn();
const toastOk = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastOk(m),
    error: (m: string) => toastErro(m),
    info: (m: string) => toastOk(m),
  },
}));

import { NovoMaterialDialog } from "@/components/ai/NovoMaterialDialog";
import { KnowledgeSourceCard } from "@/components/ai/KnowledgeSourceCard";
import {
  ChaveDeConhecimento,
  type EstadoDaChave,
} from "@/components/ai/ChaveDeConhecimento";
import type { SourceRow } from "@/hooks/ai/useKnowledgeSources";

const CONTEUDO = [
  "## Pergunta: Qual o prazo de entrega?",
  "## Resposta: De 2 a 3 dias úteis.",
].join("\n");

function dublarFetch() {
  const spy = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: { id: "ks-1", items_count: 1 } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function corpoEnviado(spy: ReturnType<typeof dublarFetch>): Record<string, unknown> {
  const init = spy.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function material(over: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "ks-1",
    agent_id: null,
    organization_id: "org-1",
    source_type: "faq",
    name: "Perguntas frequentes",
    status: "ready",
    last_index_status: "success",
    last_index_error: null,
    last_indexed_at: new Date().toISOString(),
    chunks_count: 4,
    is_active: true,
    source_metadata: {},
    active_kb_version_id: "kbv-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

const CHAVE_OK: EstadoDaChave = {
  pode_indexar: true,
  origem: "credencial_da_organizacao",
  explicacao: "Usando a chave OpenAI cadastrada em Credenciais.",
  chave_em_uso: "Chave principal",
  avisos: [],
  credenciais_openai: [],
};

beforeEach(() => {
  toastErro.mockReset();
  toastOk.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NovoMaterialDialog — o tipo escolhido é o tipo enviado", () => {
  it('tipo "faq" chega na API como "faq"', async () => {
    const spy = dublarFetch();
    render(
      <NovoMaterialDialog aberto onFechar={() => {}} onCriado={() => {}} podeIndexar />,
    );

    fireEvent.change(screen.getByTestId("material-nome"), { target: { value: "FAQ da loja" } });
    fireEvent.change(screen.getByTestId("material-conteudo"), { target: { value: CONTEUDO } });
    fireEvent.click(screen.getByTestId("material-criar"));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]?.[0]).toBe("/api/v1/ai/knowledge/sources");
    expect(corpoEnviado(spy)).toMatchObject({ source_type: "faq", name: "FAQ da loja" });
  });

  it('tipo "documento" chega na API como "documento" — nunca reescrito para faq', async () => {
    const spy = dublarFetch();
    render(
      <NovoMaterialDialog aberto onFechar={() => {}} onCriado={() => {}} podeIndexar />,
    );

    fireEvent.click(screen.getByTestId("material-tipo-documento"));
    fireEvent.change(screen.getByTestId("material-nome"), { target: { value: "Política" } });
    fireEvent.change(screen.getByTestId("material-conteudo"), {
      target: { value: "# Política de troca\n\nAceitamos em 30 dias." },
    });
    fireEvent.click(screen.getByTestId("material-criar"));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(corpoEnviado(spy)).toMatchObject({ source_type: "documento" });
  });

  for (const tipo of ["conversas", "catalogo"] as const) {
    it(`"${tipo}" não pode ser cadastrado à mão — ele é preenchido por rotina`, () => {
      render(
        <NovoMaterialDialog aberto onFechar={() => {}} onCriado={() => {}} podeIndexar />,
      );
      // Desabilitado, e não ausente: sumir com a opção esconderia que o material
      // EXISTE e chega sozinho — que é a informação que a pessoa precisa.
      expect(screen.getByTestId(`material-tipo-${tipo}`)).toBeDisabled();
    });
  }

  it("sem chave, o diálogo DIZ que o material vai ficar esperando", () => {
    render(
      <NovoMaterialDialog
        aberto
        onFechar={() => {}}
        onCriado={() => {}}
        podeIndexar={false}
      />,
    );
    expect(screen.getByTestId("material-aviso-sem-chave")).toBeInTheDocument();
  });

  it("COM chave, o aviso de espera não aparece (controle)", () => {
    render(
      <NovoMaterialDialog aberto onFechar={() => {}} onCriado={() => {}} podeIndexar />,
    );
    // Sem este controle, o caso acima passaria com o aviso renderizado SEMPRE —
    // que é ruído, não informação.
    expect(screen.queryByTestId("material-aviso-sem-chave")).toBeNull();
  });

  it("erro da API vira a mensagem do servidor, não um texto fixo", async () => {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            error: {
              code: "knowledge_source_name_in_use",
              message: 'Já existe um material chamado "FAQ da loja".',
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", spy);

    render(
      <NovoMaterialDialog aberto onFechar={() => {}} onCriado={() => {}} podeIndexar />,
    );
    fireEvent.change(screen.getByTestId("material-nome"), { target: { value: "FAQ da loja" } });
    fireEvent.change(screen.getByTestId("material-conteudo"), { target: { value: CONTEUDO } });
    fireEvent.click(screen.getByTestId("material-criar"));

    await waitFor(() => expect(toastErro).toHaveBeenCalledTimes(1));
    expect(String(toastErro.mock.calls[0]?.[0])).toContain("Já existe um material");
    expect(toastOk).not.toHaveBeenCalled();
  });
});

describe("KnowledgeSourceCard — só oferece controle onde existe ação", () => {
  it("FAQ pronta oferece editar conteúdo e ver o que o agente aprendeu", () => {
    render(
      <KnowledgeSourceCard
        source={material()}
        usadoPor={["Suporte"]}
        onReindex={() => {}}
        onArquivar={() => {}}
        onMudou={() => {}}
      />,
    );
    expect(screen.getByTestId("material-editar-ks-1")).toBeInTheDocument();
    expect(screen.getByTestId("material-ver-ks-1")).toBeInTheDocument();
  });

  for (const tipo of ["conversas", "catalogo"] as const) {
    it(`"${tipo}" NÃO oferece editar conteúdo — não há o que colar`, () => {
      render(
        <KnowledgeSourceCard
          source={material({ source_type: tipo })}
          usadoPor={[]}
          onReindex={() => {}}
          onArquivar={() => {}}
          onMudou={() => {}}
        />,
      );
      expect(screen.queryByTestId("material-editar-ks-1")).toBeNull();
    });
  }

  it("material sem trecho nenhum não oferece 'ver o que ele aprendeu'", () => {
    render(
      <KnowledgeSourceCard
        source={material({ chunks_count: 0, last_index_status: null })}
        usadoPor={[]}
        onReindex={() => {}}
        onArquivar={() => {}}
        onMudou={() => {}}
      />,
    );
    // O diálogo abriria vazio: oferecer é prometer conteúdo que não existe.
    expect(screen.queryByTestId("material-ver-ks-1")).toBeNull();
  });

  it("material que NENHUM assistente consulta é dito na cara", () => {
    render(
      <KnowledgeSourceCard
        source={material()}
        usadoPor={[]}
        onReindex={() => {}}
        onArquivar={() => {}}
        onMudou={() => {}}
      />,
    );
    // Acervo que ninguém lê é dinheiro gasto sem efeito, e era invisível.
    expect(screen.getByTestId("material-orfao-ks-1")).toBeInTheDocument();
  });

  it("falta de chave aparece no cartão com o motivo, não como 'não indexado'", () => {
    render(
      <KnowledgeSourceCard
        source={material({
          chunks_count: 0,
          last_index_status: "sem_credencial",
          last_index_error: "Falta uma chave da OpenAI para indexar.",
        })}
        usadoPor={[]}
        onReindex={() => {}}
        onArquivar={() => {}}
        onMudou={() => {}}
      />,
    );
    expect(screen.getByText("Esperando a chave")).toBeInTheDocument();
    expect(screen.getByText(/Por que não entrou/)).toBeInTheDocument();
  });
});

describe("ChaveDeConhecimento — o beco vira saída", () => {
  it("sem chave, avisa E oferece cadastrar ali mesmo", () => {
    render(
      <ChaveDeConhecimento
        estado={{ ...CHAVE_OK, pode_indexar: false, chave_em_uso: null }}
        onChaveCadastrada={() => {}}
      />,
    );
    expect(screen.getByTestId("conhecimento-sem-chave")).toBeInTheDocument();
    // Avisar sem oferecer conserto é um diagnóstico que a pessoa não tem o que
    // fazer com — o defeito que este componente existe para acabar.
    fireEvent.click(screen.getByTestId("conhecimento-cadastrar-chave"));
    expect(screen.getByTestId("conhecimento-chave-input")).toBeInTheDocument();
  });

  it("com chave, diz QUAL está valendo", () => {
    render(<ChaveDeConhecimento estado={CHAVE_OK} onChaveCadastrada={() => {}} />);
    expect(screen.getByTestId("conhecimento-chave-ok")).toBeInTheDocument();
    expect(screen.getByText(/Chave principal/)).toBeInTheDocument();
  });
});
