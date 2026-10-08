/**
 * /admin/sistema — a linha "Cobrança dos seus clientes" (spec da cobrança §9, §7h).
 *
 * Nesta versão a cobrança ainda não liga: quem nunca a ligou NÃO vê interruptor
 * (um interruptor que devolve erro ensina a não confiar na tela, e o fragmento
 * da PR 2 promete que nada muda para quem opera). Ligada pelo banco (fixture de
 * e2e ou versão seguinte), a linha aparece, para poder desligar, e avisa quantas
 * empresas suspensas por falta de pagamento serão liberadas.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ salvar: vi.fn() }));
vi.mock("@/app/actions/settings/updateModuloDaInstalacao", () => ({ updateModuloDaInstalacao: h.salvar }));
vi.mock("@/app/actions/settings/updateComportamento", () => ({ updateComportamento: vi.fn() }));

import { FormularioDeModulos } from "@/app/admin/(protected)/sistema/_form";

const NOME = "Cobrança dos seus clientes";

beforeEach(() => {
  vi.clearAllMocks();
  h.salvar.mockResolvedValue({ ok: true });
});

describe("/admin/sistema — o interruptor da cobrança", () => {
  it("ainda não ligável e desligada: sem linha; os outros módulos seguem", () => {
    render(<FormularioDeModulos ligados={[]} escondidos={["cobranca"]} suspensasPorCobranca={0} />);
    expect(screen.queryByRole("switch", { name: NOME })).toBeNull();
    expect(screen.getByRole("switch", { name: "Banco de dados externo" })).toBeTruthy();
  });

  it("ligada: a linha aparece, avisa quantas serão liberadas, e desligar chama a action", async () => {
    render(<FormularioDeModulos ligados={["cobranca"]} escondidos={[]} suspensasPorCobranca={2} />);
    const chave = screen.getByRole("switch", { name: NOME });
    expect(chave.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/serão liberadas ao desligar/).textContent).toContain("2");
    await userEvent.setup().click(chave);
    expect(h.salvar).toHaveBeenCalledWith({ modulo: "cobranca", ligado: false });
  });

  it("ligada e sem suspensas: nenhum aviso", () => {
    render(<FormularioDeModulos ligados={["cobranca"]} escondidos={[]} suspensasPorCobranca={0} />);
    expect(screen.queryByText(/serão liberadas ao desligar/)).toBeNull();
  });

  it("contagem que falhou não vira zero: o aviso diz que não deu para contar", () => {
    render(<FormularioDeModulos ligados={["cobranca"]} escondidos={[]} suspensasPorCobranca={null} />);
    expect(screen.getByText(/Não deu para contar/)).toBeTruthy();
  });

  it("liberação que falhou: o interruptor volta a ligado e a frase diz que nada mudou e o que fazer", async () => {
    // A action não grava a chave quando a liberação falha (Task 11): voltar o
    // interruptor é a verdade, e a frase genérica "Não deu para salvar" não diria
    // que as empresas seguem suspensas.
    h.salvar.mockResolvedValue({ ok: false, error: "liberacao_falhou" });
    render(<FormularioDeModulos ligados={["cobranca"]} escondidos={[]} suspensasPorCobranca={2} />);
    const chave = screen.getByRole("switch", { name: NOME });
    await userEvent.setup().click(chave);
    expect(await screen.findByText(/nada foi mudado/)).toBeTruthy();
    expect(chave.getAttribute("aria-checked")).toBe("true");
  });
});
