/**
 * A MEMÓRIA DA IA MOSTRA QUANTO PESA (frente F4).
 *
 * A memória vai inteira no prompt de todo agente, e a tela só mostrava
 * caracteres. O peso em tokens sai da MESMA conta do runtime
 * (`renderOrgMemory` sobre os aprendizados ativos e vigentes): aprendizado
 * arquivado ou vencido não entra no prompt, e por isso não pesa. O aviso só
 * informa — nada é bloqueado nem cortado.
 *
 * O limite do aviso é da ORGANIZAÇÃO (decisão do dono, 31/10): 1.500 é o
 * recomendado quando a empresa não escolheu, e quem publica a memória escolhe.
 */
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { definir, toastFalso } = vi.hoisted(() => ({
  definir: vi.fn(),
  toastFalso: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/app/actions/settings/definirLimiteDoPesoDaMemoria", () => ({
  definirLimiteDoPesoDaMemoria: definir,
}));
vi.mock("sonner", () => ({ toast: toastFalso }));

import {
  LimiteDoAviso,
  PesoDaMemoria,
  pesoDaMemoriaEmTokens,
} from "@/app/app/ai/memory/_client";
import { LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA } from "@/lib/schemas/settings";
import type { OrgMemoryEntryRow } from "@/hooks/ai/useOrgMemory";
import { countPayloadTokens } from "@/lib/ai/estimativa-de-tokens";
import { renderOrgMemory } from "@/lib/agent-engine/agent/org-memory";

const HOJE = "2026-10-31";
const LIMITE = LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA;

beforeEach(() => vi.clearAllMocks());

function entrada(over: Partial<OrgMemoryEntryRow>): OrgMemoryEntryRow {
  return {
    id: over.id ?? "e1",
    title: over.title ?? "Horário",
    body: over.body ?? "Atendemos das 9h às 18h.",
    source: "manual",
    status: over.status ?? "active",
    created_at: "2026-10-01T00:00:00Z",
    valid_until: over.valid_until ?? null,
  };
}

describe("pesoDaMemoriaEmTokens — a conta do runtime", () => {
  it("é countPayloadTokens(renderOrgMemory(...)) sobre texto + aprendizados vigentes", () => {
    const vigente = entrada({ id: "a", body: "x".repeat(700) });
    const esperado = countPayloadTokens(
      renderOrgMemory({ content: "Regra da casa.", entries: [vigente] }),
    );
    expect(pesoDaMemoriaEmTokens("Regra da casa.", [vigente], HOJE)).toBe(esperado);
  });

  it("aprendizado ativo e VENCIDO não soma; arquivado não soma; com prazo futuro soma", () => {
    const so = pesoDaMemoriaEmTokens("Regra.", [], HOJE);
    const vencida = entrada({ id: "v", body: "y".repeat(3_500), valid_until: "2026-10-30" });
    const arquivada = entrada({ id: "r", body: "z".repeat(3_500), status: "archived" });
    expect(pesoDaMemoriaEmTokens("Regra.", [vencida, arquivada], HOJE)).toBe(so);
    const valeHoje = entrada({ id: "h", body: "w".repeat(3_500), valid_until: HOJE });
    expect(pesoDaMemoriaEmTokens("Regra.", [valeHoje], HOJE)).toBeGreaterThan(so + 900);
  });

  it("sem texto e sem aprendizado o peso é zero (o bloco nem entra no prompt)", () => {
    expect(pesoDaMemoriaEmTokens("   ", [], HOJE)).toBe(0);
  });
});

describe("PesoDaMemoria — a tela", () => {
  it("mostra caracteres e tokens", () => {
    render(<PesoDaMemoria content="Regra da casa." entries={[]} hoje={HOJE} limite={LIMITE} />);
    const peso = screen.getByTestId("memoria-peso").textContent ?? "";
    expect(peso).toContain("14 caracteres");
    expect(peso).toContain(`≈${pesoDaMemoriaEmTokens("Regra da casa.", [], HOJE)} tokens`);
  });

  it("7.000 caracteres acendem o aviso; 700 não", () => {
    const { unmount } = render(<PesoDaMemoria content={"a".repeat(7_000)} entries={[]} hoje={HOJE} limite={LIMITE} />);
    expect(pesoDaMemoriaEmTokens("a".repeat(7_000), [], HOJE)).toBeGreaterThan(LIMITE);
    expect(screen.getByTestId("memoria-peso-aviso").textContent).toContain(
      "vai inteiro em toda resposta de todo agente",
    );
    unmount();
    render(<PesoDaMemoria content={"a".repeat(700)} entries={[]} hoje={HOJE} limite={LIMITE} />);
    expect(screen.queryByTestId("memoria-peso-aviso")).toBeNull();
  });

  it("aprendizado vencido não acende o aviso que o vigente acenderia", () => {
    const grande = "b".repeat(6_000);
    const { unmount } = render(
      <PesoDaMemoria
        content="Regra."
        entries={[entrada({ body: grande, valid_until: "2026-10-01" })]}
        hoje={HOJE}
        limite={LIMITE}
      />,
    );
    expect(screen.queryByTestId("memoria-peso-aviso")).toBeNull();
    unmount();
    render(<PesoDaMemoria content="Regra." entries={[entrada({ body: grande })]} hoje={HOJE} limite={LIMITE} />);
    expect(screen.getByTestId("memoria-peso-aviso")).not.toBeNull();
  });
});

describe("PesoDaMemoria — o limite é o da organização", () => {
  // 3.500 caracteres ≈ 1.000 tokens: abaixo do recomendado, acima de um limite de 800.
  const texto = "c".repeat(3_500);

  it("um limite configurado ABAIXO do peso acende o aviso que o recomendado não acenderia", () => {
    const peso = pesoDaMemoriaEmTokens(texto, [], HOJE);
    expect(peso).toBeLessThan(LIMITE);
    expect(peso).toBeGreaterThan(800);
    const { unmount } = render(<PesoDaMemoria content={texto} entries={[]} hoje={HOJE} limite={LIMITE} />);
    expect(screen.queryByTestId("memoria-peso-aviso")).toBeNull();
    unmount();
    render(<PesoDaMemoria content={texto} entries={[]} hoje={HOJE} limite={800} />);
    expect(screen.getByTestId("memoria-peso-aviso")).not.toBeNull();
  });

  it("um limite configurado ACIMA do peso apaga o aviso que o recomendado acenderia", () => {
    const grande = "d".repeat(7_000);
    expect(pesoDaMemoriaEmTokens(grande, [], HOJE)).toBeGreaterThan(LIMITE);
    const { unmount } = render(<PesoDaMemoria content={grande} entries={[]} hoje={HOJE} limite={LIMITE} />);
    expect(screen.getByTestId("memoria-peso-aviso")).not.toBeNull();
    unmount();
    render(<PesoDaMemoria content={grande} entries={[]} hoje={HOJE} limite={5_000} />);
    expect(screen.queryByTestId("memoria-peso-aviso")).toBeNull();
  });
});

describe("LimiteDoAviso — o limite em vigor e a recomendação", () => {
  it("quem não publica a memória vê o limite e a recomendação, sem campo", () => {
    render(<LimiteDoAviso limite={3_000} podeEditar={false} onSalvo={() => {}} />);
    expect(screen.getByTestId("memoria-limite").textContent).toBe(
      "Mostrar o aviso de peso acima de 3.000 tokens",
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    // O leigo precisa saber que é um aviso da tela, e que nada é cortado.
    expect(screen.getByText(/Recomendado:/).textContent).toBe(
      "Recomendado: 1.500 tokens. A memória vai inteira em toda resposta de todo agente; o aviso só informa, nada é cortado.",
    );
    expect(screen.getByText("Vale para toda a empresa. Só administradores podem mudar.")).toBeTruthy();
  });

  it("quem publica escolhe o número; a tela grava pela action e passa o valor adiante", async () => {
    definir.mockResolvedValue({ ok: true, valor: 3_000, mudou: true });
    const onSalvo = vi.fn();
    render(<LimiteDoAviso limite={LIMITE} podeEditar onSalvo={onSalvo} />);
    const campo = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(campo.value).toBe(String(LIMITE));
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    fireEvent.change(campo, { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(onSalvo).toHaveBeenCalledWith(3_000));
    expect(definir).toHaveBeenCalledWith(3_000);
    expect(toastFalso.success).toHaveBeenCalledWith("Salvo");
  });

  it("recusa do servidor diz o motivo e não muda o limite em vigor", async () => {
    definir.mockResolvedValue({ ok: false, erro: "sem_permissao" });
    const onSalvo = vi.fn();
    render(<LimiteDoAviso limite={LIMITE} podeEditar onSalvo={onSalvo} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(toastFalso.error).toHaveBeenCalledWith("Só um administrador pode mudar esse limite."),
    );
    expect(onSalvo).not.toHaveBeenCalled();
  });
});
