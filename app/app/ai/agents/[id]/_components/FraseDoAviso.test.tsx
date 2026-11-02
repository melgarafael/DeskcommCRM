/**
 * A FRASE DO AVISO DE PASSAGEM TEM CAMPO NA TELA (#3725, ponto 5 do CR do #3816).
 *
 * ─── O defeito que este arquivo guarda ─────────────────────────────────────
 *
 * O runtime já lia `ai_agents.config.aviso_de_handoff` (#3725), mas nada
 * escrevia: o `agentConfigPatchSchema` DESCARTAVA a chave no PATCH e não havia
 * campo no editor. A configuração só existia para quem editasse o jsonb no
 * banco — e "schema sem tela" é promessa que ninguém configura.
 *
 * ─── O que cada caso cobra ─────────────────────────────────────────────────
 *
 *  1. o campo mostra a frase que já está gravada (quem abre a tela vê o que o
 *     cliente lê hoje, não um vazio que sugere padrão);
 *  2. salvar manda a chave certa no `config` do PATCH — o MESMO caminho dos
 *     outros cartões do editor (`apiClient.patch('/api/v1/ai/agents/:id')`);
 *  3. esvaziar o campo GRAVA `null`, que é como se volta ao padrão do produto —
 *     mandar `""` faria a leitura recusar e a frase antiga continuar valendo;
 *  4. frase acima do teto do aviso não é enviada (a tela avisa em vez de deixar
 *     o servidor recusar depois do "salvo com sucesso");
 *  5. o cartão está MONTADO no `AgentForm` — um componente perfeito que ninguém
 *     renderiza é o mesmo defeito de novo.
 *
 * `t` devolve a chave: o texto lido aqui é o português que a tela mostra.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { patch, sucesso, erro } = vi.hoisted(() => ({
  patch: vi.fn(),
  sucesso: vi.fn(),
  erro: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("sonner", () => ({ toast: { success: sucesso, error: erro } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { FraseDoAviso } from "@/app/app/ai/agents/[id]/_components/FraseDoAviso";
import { TETO_DA_FRASE_DO_AVISO } from "@/lib/escalacao/frase-do-aviso-configurada";

const AGENTE = "agente-1";

function campo(): HTMLElement {
  return screen.getByLabelText("Frase do aviso de passagem");
}

beforeEach(() => {
  patch.mockReset().mockResolvedValue({});
  sucesso.mockReset();
  erro.mockReset();
});
afterEach(cleanup);

describe("cartão da frase do aviso de passagem", () => {
  it("mostra a frase já gravada", () => {
    render(<FraseDoAviso agentId={AGENTE} inicial="Já chamei o time, pode ficar tranquilo!" />);
    expect((campo() as HTMLInputElement).value).toBe("Já chamei o time, pode ficar tranquilo!");
  });

  it("salvar grava `ai_agents.config.aviso_de_handoff", async () => {
    render(<FraseDoAviso agentId={AGENTE} />);
    fireEvent.change(campo(), { target: { value: "  Já chamei o time.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar frase" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/api/v1/ai/agents/${AGENTE}`, {
      config: { aviso_de_handoff: "Já chamei o time." },
    });
    expect(sucesso).toHaveBeenCalled();
  });

  it("esvaziar grava `null` — é assim que se volta ao padrão", async () => {
    render(<FraseDoAviso agentId={AGENTE} inicial="Já chamei o time." />);
    fireEvent.change(campo(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar frase" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/api/v1/ai/agents/${AGENTE}`, {
      config: { aviso_de_handoff: null },
    });
  });

  it("frase acima do teto não é enviada", async () => {
    render(<FraseDoAviso agentId={AGENTE} />);
    fireEvent.change(campo(), { target: { value: "x".repeat(TETO_DA_FRASE_DO_AVISO + 1) } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar frase" }));
    expect(patch).not.toHaveBeenCalled();
    expect(erro).toHaveBeenCalled();
  });

  it("não salva quando nada mudou", () => {
    render(<FraseDoAviso agentId={AGENTE} inicial="Já chamei o time." disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Salvar frase" }));
    expect(patch).not.toHaveBeenCalled();
  });

  it("o editor do agente MONTA o cartão", () => {
    const fonte = readFileSync(
      join(process.cwd(), "app/app/ai/agents/[id]/_components/AgentForm.tsx"),
      "utf8",
    );
    expect(fonte).toContain("<FraseDoAviso");
    expect(fonte).toContain("aviso_de_handoff");
  });
});
