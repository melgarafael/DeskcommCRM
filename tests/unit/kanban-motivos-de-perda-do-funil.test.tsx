/**
 * OS MOTIVOS DE PERDA QUE O FUNIL OFERECE — a janela tem de mostrar os DELES.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────
 *
 * `settings.lost_reasons` é a lista que o operador cadastra em Funis, e o
 * servidor já a respeita: `fn_validate_lost_reason_required` aceita canônico ∪
 * cadastrado. A janela de perder, sozinha, renderizava sempre o padrão do
 * produto. Medido antes de escrever, na base 54530c9f:
 *
 *     grep -n "lost_reasons" components/kanban/LoseLeadDialog.tsx   # zero
 *
 * Consequência: quem cadastrou "Sem orçamento" não via o próprio motivo na
 * tela, digitava à mão ("Outro") e descobria no clique se o funil daquele card
 * aceitava — com 22023 para o que não aceitava.
 *
 * ─── O que cada caso mede ────────────────────────────────────────────────
 *
 * O primeiro caso é o defeito: a lista não é a do produto, é a do funil. O
 * segundo prova que o motivo escolhido CHEGA no endpoint, com o texto dele. O
 * terceiro é a VALIDAÇÃO: com funil configurado, "Outro" vazio não passa e
 * texto fora da lista é recusado ANTES do clique. O quarto é a volta: sem nada
 * cadastrado, o padrão do produto e o `other` vazio continuam como sempre
 * foram — a correção não pode ter consertado um caso quebrando o outro.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoseLeadDialog } from "@/components/kanban/LoseLeadDialog";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";
import { motivosDoFunil } from "@/lib/leads/motivos-de-perda-do-funil";
import type { BoardData } from "@/lib/kanban/types";

const { apiPost } = vi.hoisted(() => ({
  // `unknown[]` nos parâmetros de propósito: o mock é chamado com dois argumentos
  // (rota e corpo) e um `vi.fn()` sem parâmetro nenhum reprova o typecheck (TS2554).
  apiPost: vi.fn(async (..._args: unknown[]) => ({ data: {} })),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: (...args: unknown[]) => apiPost(...(args as [string, unknown])),
    patch: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: {} })),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/kanban/local-echo", () => ({
  marcarEcoLocal: vi.fn(),
  liberarEcoLocal: vi.fn(),
  ehEcoLocal: () => false,
}));

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

const PIL = "funil-da-918";
const LEAD = "lead-da-918";

afterEach(() => {
  cleanup();
  apiPost.mockClear();
});

/** Um cliente novo por caso: cache compartilhada entre casos esconderia o defeito. */
function comFunil(settings: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // A MESMA chave que `useBoard` usa. Escrevendo a literal aqui, mudar a chave do
  // quadro deixaria o hook devolvendo `[]` — a janela voltaria ao padrão do
  // produto, o defeito da #918 — com estes casos verdes.
  qc.setQueryData(chaveDoQuadro(PIL), { pipeline: { settings } } as unknown as BoardData);
  return qc;
}

function abrir(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <LoseLeadDialog open onOpenChange={() => {}} leadId={LEAD} pipelineId={PIL} />
    </QueryClientProvider>,
  );
}

/** Pelas VALUES, não pelos rótulos: o valor é o contrato com o servidor. */
const valuesDosMotivos = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[name="lost-reason"]')).map((r) => r.value);

const radio = (valor: string) =>
  document.querySelector<HTMLInputElement>(`input[name="lost-reason"][value="${valor}"]`)!;

const confirmar = () => screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;

describe("motivos de perda configurados no funil", () => {
  it("oferece os CADASTRADOS no funil e some com o padrão do produto", () => {
    abrir(comFunil({ lost_reasons: ["Sem orçamento", "Fora do perfil"] }));

    expect(valuesDosMotivos()).toEqual(["Sem orçamento", "Fora do perfil", "other"]);
    // O padrão do produto não pode sobrar: motivo que o funil não tem é 22023 na cara do operador.
    expect(screen.queryByText("Falha no pagamento")).toBeNull();
  });

  it("grava o motivo do funil escolhido, com o texto dele", async () => {
    abrir(comFunil({ lost_reasons: ["Sem orçamento", "Fora do perfil"] }));

    fireEvent.click(radio("Fora do perfil"));
    fireEvent.click(confirmar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(`/api/v1/leads/${LEAD}/lose`, {
      lost_reason: "Fora do perfil",
    });
  });

  it("⭐ com funil configurado, 'Outro' SEM detalhe grava `other` — o escape que o servidor aceita", async () => {
    // `other` é CANÔNICO (`v_canonical` em `fn_validate_lost_reason_required`),
    // então o trigger o aceita em qualquer funil. Exigir o detalhe aqui fazia da
    // opção um beco sem saída: os únicos textos aceitos eram os rádios ao lado, e
    // cadastrar um motivo novo é admin-only — um `agent` com uma perda fora da
    // lista não tinha ação correta nenhuma.
    abrir(comFunil({ lost_reasons: ["Sem orçamento"] }));

    fireEvent.click(radio("other"));
    expect(confirmar().disabled).toBe(false);

    fireEvent.click(confirmar());
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(`/api/v1/leads/${LEAD}/lose`, { lost_reason: "other" });
  });

  it("com funil configurado, 'Outro' recusa ANTES DO CLIQUE o texto que o servidor negaria", () => {
    abrir(comFunil({ lost_reasons: ["Sem orçamento"] }));

    fireEvent.click(radio("other"));
    // O rótulo é "opcional" nos dois casos: deixar em branco é uma saída válida.
    const detalhe = screen.getByLabelText(/Detalhe \(opcional\)/);
    fireEvent.change(detalhe, { target: { value: "Sem orçamento" } });
    expect(confirmar().disabled).toBe(false); // valor que o funil aceita

    fireEvent.change(detalhe, { target: { value: "Cliente mudou de ideia" } });
    expect(confirmar().disabled).toBe(true); // fora da lista: o trigger recusaria
    expect(apiPost).not.toHaveBeenCalled();
    // A MESMA frase que `lib/leads/motivo-da-perda.ts` (#935) devolve para esta
    // recusa pela API. Duas frases quase idênticas para o mesmo "não" fariam o
    // operador achar que tropeçou em dois problemas diferentes.
    expect(screen.getByRole("alert").textContent).toBe(
      "Esse motivo de perda não está na lista deste funil — escolha um dos motivos configurados.",
    );
  });

  it("com funil configurado, 'Outro' diz ONDE se cadastra um motivo novo", () => {
    // Beco sem saída: a tela oferece "Outro", recusa todo texto que não seja um
    // motivo já cadastrado, e sem esta frase não diz onde se cadastra um novo.
    abrir(comFunil({ lost_reasons: ["Sem orçamento"] }));
    fireEvent.click(radio("other"));
    expect(screen.getByText(/cadastre em Configurações/)).toBeTruthy();
  });

  it("sem funil configurado a frase NÃO aparece — ali 'Outro' aceita texto livre", () => {
    abrir(comFunil({}));
    fireEvent.click(radio("other"));
    expect(screen.queryByText(/cadastre em Configurações/)).toBeNull();
  });

  it("sem funil configurado, o padrão do produto e o 'other' vazio continuam valendo", async () => {
    abrir(comFunil({}));
    expect(valuesDosMotivos()).toEqual([...CANONICAL_LOST_REASONS]);

    fireEvent.click(radio("other"));
    expect(confirmar().disabled).toBe(false);
    fireEvent.click(confirmar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(`/api/v1/leads/${LEAD}/lose`, { lost_reason: "other" });
  });

  it("funil com lista VAZIA cai no padrão — nunca numa janela sem motivo nenhum", () => {
    abrir(comFunil({ lost_reasons: [] }));
    expect(valuesDosMotivos()).toEqual([...CANONICAL_LOST_REASONS]);
  });
});

describe("motivosDoFunil (a régua da leitura)", () => {
  it("mantém o texto como está no banco e deduplica ignorando espaços", () => {
    // O valor OFERECIDO é o que vai para `lost_reason`, e o trigger o compara por
    // igualdade EXATA com o que está no jsonb. Aparar aqui faria a janela mostrar
    // um rótulo que o banco recusa com 22023 — a classe de defeito que este
    // arquivo fecha. O dedupe segue ignorando espaço nas pontas.
    expect(
      motivosDoFunil({ lost_reasons: ["  Sem orçamento  ", "Sem orçamento", "", "Fora do perfil"] }),
    ).toEqual(["  Sem orçamento  ", "Fora do perfil"]);
  });

  it("a chave do quadro não pode voltar a ser literal em lugar nenhum", () => {
    // MEDIDO, e contra a minha previsão: trocar o corpo de `chaveDoQuadro` NÃO
    // deixa este arquivo vermelho — 9 verdes —, porque o hook e o teste passaram
    // a ler pela MESMA função e mudam juntos. É o desfecho certo: a divergência
    // deixou de ser possível, em vez de passar a ser detectada.
    //
    // O que continua possível é alguém RE-ESCREVER a literal num dos lados, e aí
    // o hook volta a devolver `[]` em silêncio — a janela cai no padrão do
    // produto, que é o defeito da #918. É essa regressão que este caso pega.
    const raiz = process.cwd();
    for (const arquivo of [
      "hooks/kanban/useMotivosDePerdaDoFunil.ts",
      "tests/unit/kanban-motivos-de-perda-do-funil.test.tsx",
    ]) {
      expect(readFileSync(join(raiz, arquivo), "utf8"), arquivo).toContain("chaveDoQuadro(");
    }
    // A literal só é cobrada no HOOK: este arquivo cita `chaveDoQuadro` e nomeia
    // a literal antiga no próprio texto do caso, e cobrá-la aqui seria o teste
    // reprovando a si mesmo.
    const hook = readFileSync(join(raiz, "hooks/kanban/useMotivosDePerdaDoFunil.ts"), "utf8");
    expect(hook.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toContain("\"board\"");
  });

  it("lixo no settings vira lista vazia, não motivo na tela", () => {
    expect(motivosDoFunil(null)).toEqual([]);
    expect(motivosDoFunil({})).toEqual([]);
    expect(motivosDoFunil({ lost_reasons: "Sem orçamento" })).toEqual([]);
  });
});
