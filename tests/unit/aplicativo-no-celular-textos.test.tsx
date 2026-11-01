import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * O passo a passo da tela de instalar, renderizado com o aparelho falso.
 *
 * O WhatsApp abre links numa Custom Tab (Android) ou num SFSafariViewController
 * (iPhone), com o MESMO user agent do Chrome e do Safari, e ali não há opção de
 * instalar. A tela não tem como saber; o passo a passo diz como sair.
 */
const registrar = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications/service_worker", () => ({ ensureNotifyServiceWorker: registrar }));

import { AplicativoNoCelular } from "@/app/app/settings/aplicativo/_client";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1";

function aparelho(ua: string, plataforma: string, toques: number) {
  registrar.mockResolvedValue({});
  vi.stubGlobal("isSecureContext", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  vi.spyOn(navigator, "platform", "get").mockReturnValue(plataforma);
  // O jsdom não define maxTouchPoints.
  Object.defineProperty(navigator, "maxTouchPoints", { value: toques, configurable: true });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" && toques > 0 }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tela de instalar: o passo a passo de cada aparelho", () => {
  it("Android pelo menu: manda abrir no Chrome se a opção não aparecer", async () => {
    aparelho(ANDROID, "Linux armv8l", 5);
    render(<AplicativoNoCelular />);
    expect(await screen.findByTestId("app-android-menu")).toHaveTextContent(/WhatsApp.*Abrir no Chrome/);
  });

  it("iPhone no Safari: manda abrir no Safari se a opção não aparecer", async () => {
    aparelho(IPHONE, "iPhone", 5);
    render(<AplicativoNoCelular />);
    const caixa = await screen.findByTestId("app-iphone");
    expect(caixa).toHaveTextContent(/WhatsApp.*Abrir no Safari/);
    expect(caixa).toHaveTextContent("barra do Safari");
  });

  it("Chrome do iPhone: o passo do Compartilhar não fala em Safari", async () => {
    aparelho(IPHONE_CHROME, "iPhone", 5);
    render(<AplicativoNoCelular />);
    const caixa = await screen.findByTestId("app-iphone-outro-navegador");
    expect(caixa).toHaveTextContent("Compartilhar");
    expect(caixa).toHaveTextContent("Adicionar à Tela de Início");
    expect(caixa).not.toHaveTextContent("Safari");
  });
  it("SW que não registrou: além do modo privado e do certificado, admite falha passageira", async () => {
    aparelho(ANDROID, "Linux armv8l", 5);
    registrar.mockResolvedValue(null);
    render(<AplicativoNoCelular />);
    expect(await screen.findByTestId("app-sem-sw")).toHaveTextContent(/recarregue a página/);
  });
});
