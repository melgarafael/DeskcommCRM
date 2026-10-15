/**
 * Aba que estava recarregando quando outra aba trocou o acompanhamento de suporte.
 *
 * O aviso entre abas é o evento `storage`, e ele só chega a documento que já
 * registrou o listener. No e2e (run 37556998653), a `sameTab` começou a recarregar
 * ~400 ms antes de a aba principal gravar o aviso do `end()` e só rodou os efeitos
 * ~230 ms depois dele: perdeu o aviso e ficou na organização do suporte (#2471).
 */
import { act, render, screen } from "@testing-library/react";
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

// ─── A aba vizinha: a recarga do evento `storage` abre um documento só ───────
//
// No trace do run 38125887558 (#2800), a aba vizinha carregou DUAS vezes
// depois de sair do acompanhamento (19.565 e 20.186): a recarga disparada
// pelo evento `storage` abria um documento que, sem carimbo próprio, caía na
// comparação de relógio e recarregava de novo. `Date.now()` em ms inteiro não
// separa o início do documento do carimbo — a margem medida foi de −0,2 a
// 0,00 ms —, o mesmo limite que o #1879 contornou para a aba que grava o
// aviso via sessionStorage. A vizinha não tinha esse carimbo.
describe("aba vizinha: a recarga do evento storage abre um documento só", () => {
  // A produtora do aviso é OUTRA aba. Em jsdom há uma única sessionStorage
  // compartilhada, então o carimbo que a produtora grava para si (#1879) não
  // é reproduzível aqui: a visão da vizinha é modelada gravando só o
  // localStorage, que é o que atravessa abas. A sessionStorage dela fica sem
  // o carimbo, como no trace.
  it("o documento aberto pela recarga do evento não recarrega uma segunda vez", () => {
    const documentoA = montar();
    const agora = Date.now();
    const carimbo = String(agora); // a outra aba encerra o acompanhamento
    localStorage.setItem(AVISO, carimbo);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: AVISO, newValue: carimbo })); });
    // A recarga legítima acontece uma vez — e a aba marca o carimbo que tratou.
    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(AVISO)).toBe(carimbo);
    documentoA.unmount(); // a recarga troca o documento; a sessionStorage fica

    reload.mockClear();
    // Documento B, na MESMA aba: começou 0,2 ms ANTES do carimbo — a margem
    // negativa do trace. Relógio congelado para a conta não derivar.
    vi.spyOn(performance, "now").mockReturnValue(0.2);
    vi.spyOn(Date, "now").mockReturnValue(agora);
    expect(Date.now() - performance.now() - Number(carimbo)).toBeLessThanOrEqual(0);
    montar();
    // Sem o carimbo, a comparação de relógio diria "aviso posterior" e B
    // recarregaria: dois documentos. Com ele, um só.
    expect(reload).not.toHaveBeenCalled();
  });

  it("um aviso mais novo, dado depois do tratado, ainda recarrega a aba", () => {
    const documentoA = montar();
    const carimbo = String(Date.now());
    localStorage.setItem(AVISO, carimbo);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: AVISO, newValue: carimbo })); });
    documentoA.unmount();
    montar(); // documento B nasce sem recarregar de novo

    reload.mockClear();
    const carimboNovo = String(Date.now() + 1); // outro encerramento, minutos depois
    localStorage.setItem(AVISO, carimboNovo);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: AVISO, newValue: carimboNovo })); });
    // O aviso legítimo continua valendo: tratar um carimbo não cala os próximos.
    expect(reload).toHaveBeenCalledOnce();
  });
});
