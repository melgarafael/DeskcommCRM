/**
 * Aba que estava recarregando quando outra aba trocou o acompanhamento de suporte.
 *
 * O aviso entre abas é o evento `storage`, e ele só chega a documento que já
 * registrou o listener. No e2e (run 37556998653), a `sameTab` começou a recarregar
 * ~400 ms antes de a aba principal gravar o aviso do `end()` e só rodou os efeitos
 * ~230 ms depois dele: perdeu o aviso e ficou na organização do suporte (#2471).
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVISO, OrganizationTransitionProvider } from "./OrganizationTransitionProvider";
import { notifySupportTransition } from "@/components/app/ImpersonateBanner";

vi.mock("@/lib/supabase/browser", () => ({ resetRealtimeAuthentication: vi.fn() }));

const reload = vi.fn();
const original = window.location;
const DOCUMENTO_COMECOU_HA_MS = 5000;

beforeEach(() => {
  reload.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(performance, "now").mockReturnValue(DOCUMENTO_COMECOU_HA_MS);
  // `window.location.reload` não é substituível direto no jsdom.
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: original });
});

const montar = () => render(<OrganizationTransitionProvider><p>Tela</p></OrganizationTransitionProvider>);

describe("aviso de troca de acompanhamento dado antes da hidratação", () => {
  it("aviso gravado depois de o documento começar: recarrega uma vez ao montar", () => {
    localStorage.setItem(AVISO, String(Date.now() - 1000));
    montar();
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.getByTestId("organization-transition").textContent).toBe("Atualizando acompanhamento…");
  });

  it("aviso anterior ao documento: ele já nasceu com o contexto novo e não recarrega", () => {
    localStorage.setItem(AVISO, String(Date.now() - DOCUMENTO_COMECOU_HA_MS - 1000));
    montar();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByTestId("organization-transition")).toBeNull();
  });

  // A aba que GRAVA o aviso navega logo em seguida (`window.location.assign`), então o
  // documento novo dela nasce com o contexto novo. Só que o início dele fica a frações
  // de milissegundo do carimbo, e `Date.now() - performance.now()` (ms inteiro contra
  // relógio monotônico) não separa os dois: no CI a inbox se recarregou sozinha depois
  // de "Sair do acompanhamento" e abortou a navegação seguinte (runs 37559681226 e
  // 37566458017, #1879). Aqui o relógio diz "aviso posterior", e a aba não pode cair nele.
  it("aviso gravado por esta mesma aba: não recarrega, mesmo que o relógio diga posterior", () => {
    notifySupportTransition();
    montar();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByTestId("organization-transition")).toBeNull();
  });

  it("aviso de outra aba depois do desta: volta a recarregar", () => {
    notifySupportTransition();
    localStorage.setItem(AVISO, String(Date.now() + 1));
    montar();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("sem aviso nenhum: não recarrega", () => {
    montar();
    expect(reload).not.toHaveBeenCalled();
  });

  it("armazenamento bloqueado: monta sem derrubar a tela e sem recarregar", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("bloqueado", "SecurityError"); });
    montar();
    expect(screen.getByText("Tela")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});
