/**
 * NOME REPETIDO NA TELA DE CRIAR AGENTE (#3952) — a frase no CAMPO, não no toast.
 *
 * ─── O defeito, pela tela ──────────────────────────────────────────────────
 *
 * A tela de criar agente (`/app/ai/agents/new`) não passa pela rota REST: ela
 * chama `createMcpAgentAction`. O `23505` do índice `ai_agents_name_unique`
 * chegava ali como `internal_error` e a única coisa que a pessoa via era
 * `toast.error("Erro: internal_error")` no canto — sem dizer QUAL campo estava
 * errado, e sem dizer que o conserto era trocar o nome.
 *
 * ─── O que este arquivo prende ────────────────────────────────────────────
 *
 * 1. a Action devolve `agent_name_taken` e a FRASE aparece embaixo do campo de
 *    nome (com `aria-describedby` ligado nele e `aria-invalid`), sem reload;
 * 2. nada de toast genérico para esta recusa — o texto é do campo;
 * 3. digitar no nome apaga a frase: ela descreve o nome que o banco recusou, e
 *    esse nome deixou de existir no campo;
 * 4. a frase existe nos três idiomas: `pt-BR` (chave), `es` (dicionário) e `en`
 *    (catálogo `lib/i18n/traducoes/en.json`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORG = "33333333-3333-4333-8333-333333333333";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";

// jsdom não implementa captura de ponteiro; o gatilho do Select do Radix lê
// `hasPointerCapture` antes de abrir (mesmo remédio dos outros testes desta tela).
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const acoes = vi.hoisted(() => ({ salvar: vi.fn(), publicar: vi.fn(), criar: vi.fn() }));
const empurrar = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: empurrar, refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents/new",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: acoes.salvar,
  publishAgentAction: acoes.publicar,
  createMcpAgentAction: acoes.criar,
}));

import { toast } from "sonner";
import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

/**
 * Cria o agente pela tela, com o formulário no estado mínimo válido: nome,
 * modelo e chave escolhidos (o prompt já abre com o texto padrão).
 */
function abrirCriacao() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="create"
        provedorPadrao="anthropic"
        credentials={
          [
            {
              id: CREDENCIAL,
              organization_id: ORG,
              provider: "anthropic",
              label: "chave da casa",
              api_key_last4: "1234",
              validated_at: "2026-01-01T00:00:00Z",
              validation_error: null,
              models_available: [],
              is_active: true,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ] as never
        }
        channelSessions={[{ id: CANAL, display_name: "WhatsApp da clínica", status: "WORKING" }] as never}
      />
    </QueryClientProvider>,
  );
}

/** Preenche nome + modelo e escolhe a chave, na ordem em que a pessoa faria. */
async function preencherOFormulario(nome: string) {
  fireEvent.change(document.querySelector("#name")!, { target: { value: nome } });
  // Com o catálogo vazio (ver `RESPOSTAS`), o seletor de modelo abre
  // como campo livre — o caminho que o próprio componente tem para esse caso.
  // ⚠️ O campo só vira `input` quando a consulta de modelos assenta e volta
  // vazia (ver `RESPOSTAS`). Enquanto ela está pendente, `#model` é o
  // BOTÃO do combobox — e `fireEvent.change` num botão não muda estado nenhum.
  // Esperar o campo é parte de preencher a tela como uma pessoa preenche.
  const modelo = await waitFor(() => {
    const el = document.querySelector("#model");
    if (!el || el.tagName !== "INPUT") throw new Error("o campo de modelo ainda é o combobox");
    return el as HTMLInputElement;
  });
  fireEvent.change(modelo, { target: { value: "claude-sonnet-5" } });

  fireEvent.click(document.querySelector("#credential_id")!);
  const opcao = await screen.findByRole("option", { name: /chave da casa/ });
  fireEvent.click(opcao);
}

async function criar() {
  fireEvent.click(screen.getByRole("button", { name: /criar agente/i }));
  await waitFor(() => expect(acoes.criar).toHaveBeenCalled());
}

/**
 * A rede da tela, respondida aqui — e não deixada ao jsdom.
 *
 * Sem isto, as três consultas que a tela dispara no mount (modelos, tools e
 * fluxos de follow-up) iam ao `fetch` real com URL relativa, falhavam, e o
 * `apiClient` as RETENTAVA com backoff e jitter aleatório (~200 ms + ~400 ms)
 * antes de `useFollowupFlows` avisar com `toast.error`. Esse toast nascia
 * ~600 ms depois do mount, numa hora sorteada — antes ou depois do clique,
 * conforme o quanto o preenchimento demorou. O teste reprovava ~2 em 10
 * rodadas medindo o relógio, não a recusa do nome.
 *
 * Respondida com listas vazias, a tela não tem falha de rede nenhuma para
 * avisar, e o seletor de modelo abre como campo livre (lista vazia).
 * URL fora destas três reprova alto no afterEach: consulta nova na tela entra
 * aqui de propósito, não por acaso. Ela é anotada e respondida com 404 em vez
 * de lançar — um throw no fetch vira "erro de rede" no apiClient, que repete
 * com espera sorteada e engole a mensagem, trazendo de volta a corrida.
 */
const RESPOSTAS: Record<string, unknown> = {
  "/api/v1/ai/providers/anthropic/models": { data: { models: [] } },
  "/api/v1/mcp/tools": { data: { tools: [] } },
  "/api/v1/ai/followup-flows": { data: [] },
};
const naoPrevistas: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  acoes.criar.mockResolvedValue({ ok: false, error: "agent_name_taken" });
  vi.stubGlobal("fetch", async (url: string) => {
    if (!(url in RESPOSTAS)) {
      naoPrevistas.push(url);
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(RESPOSTAS[url]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  const fora = naoPrevistas.splice(0);
  vi.unstubAllGlobals();
  expect(fora, "consulta não prevista no teste").toEqual([]);
});

describe("criar agente com nome que já existe na organização", () => {
  it("a frase aparece no CAMPO de nome, ligada a ele — e não num toast", async () => {
    abrirCriacao();
    await preencherOFormulario("Recepção");
    await criar();

    const frase = await screen.findByTestId("erro-do-nome");
    expect(frase).toHaveTextContent("Já existe um agente com esse nome.");
    // No CAMPO: descrito pelo input, e o input marcado como inválido.
    const campoDoNome = document.getElementById("name")!;
    expect(campoDoNome.getAttribute("aria-describedby")).toBe("erro-do-nome");
    expect(campoDoNome).toHaveAttribute("aria-invalid", "true");
    // A frase nasce DEPOIS de um envio: o leitor de tela precisa ouvi-la.
    expect(frase).toHaveAttribute("role", "alert");
    // Sem toast genérico e sem navegação: nada foi criado. A rede da tela está
    // respondida (ver `RESPOSTAS`), então qualquer `toast.error` aqui é a recusa.
    expect(toast.error, "a recusa do nome virou toast genérico").not.toHaveBeenCalled();
    expect(empurrar).not.toHaveBeenCalled();
  });

  it("digitar no nome apaga a frase — ela era sobre o nome recusado", async () => {
    abrirCriacao();
    await preencherOFormulario("Recepção");
    await criar();
    expect(await screen.findByTestId("erro-do-nome")).toBeInTheDocument();

    fireEvent.change(document.getElementById("name")!, { target: { value: "Recepção 2" } });
    expect(screen.queryByTestId("erro-do-nome")).not.toBeInTheDocument();
    expect(document.getElementById("name")).toHaveAttribute("aria-invalid", "false");
  });

  it("a frase existe em pt (chave), es (dicionário) e en (catálogo)", () => {
    const frase = "Já existe um agente com esse nome.";
    const dicionario = readFileSync(join(process.cwd(), "lib/i18n/dicionario.ts"), "utf8");
    expect(
      new RegExp(`"${frase}"\\s*:\\s*\\{\\s*es:\\s*"Ya existe un agente con este nombre\\."`, "s").test(
        dicionario,
      ),
      "sem espanhol no dicionário",
    ).toBe(true);
    const en = JSON.parse(
      readFileSync(join(process.cwd(), "lib/i18n/traducoes/en.json"), "utf8"),
    ) as Record<string, string>;
    expect(en[frase], "sem inglês no catálogo").toBe("An agent with this name already exists.");
  });
});
