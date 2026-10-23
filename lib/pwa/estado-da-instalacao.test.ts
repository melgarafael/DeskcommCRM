import { describe, expect, it } from "vitest";

import { estadoDoApp, type AmbienteDoAparelho } from "./estado-da-instalacao";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_INSTAGRAM = `${IPHONE} Instagram 340.0.0`;
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1";
const IPHONE_FIREFOX = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15";
const IPHONE_EDGE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/128.0 Mobile/15E148 Safari/605.1.15";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const base: AmbienteDoAparelho = {
  seguro: true,
  standalone: false,
  swOk: true,
  ua: DESKTOP,
  plataforma: "MacIntel",
  toques: 0,
  celularPelaDica: false,
  dedo: false,
  temPedido: false,
};
const com = (extra: Partial<AmbienteDoAparelho>) => estadoDoApp({ ...base, ...extra });

describe("o que a tela de instalar mostra", () => {
  it("sem conexão segura não há app, nem com o pedido do navegador na mão", () => {
    expect(com({ seguro: false, ua: ANDROID, temPedido: true })).toBe("sem-https");
    expect(com({ seguro: false, ua: IPHONE })).toBe("sem-https");
  });

  it("aberto pelo ícone, já é o app", () => {
    expect(com({ standalone: true, ua: IPHONE })).toBe("instalado");
  });

  it("iPhone: passo a passo do Compartilhar; iPad que se diz Mac também", () => {
    expect(com({ ua: IPHONE, plataforma: "iPhone", toques: 5 })).toBe("iphone");
    expect(com({ ua: DESKTOP, plataforma: "MacIntel", toques: 5 })).toBe("iphone");
  });

  it("Chrome, Firefox e Edge do iPhone também adicionam à tela de início, mas o passo não cita o Safari", () => {
    for (const ua of [IPHONE_CHROME, IPHONE_FIREFOX, IPHONE_EDGE]) {
      expect(com({ ua, plataforma: "iPhone", toques: 5 })).toBe("iphone-outro-navegador");
    }
  });

  it("navegador de dentro de outro aplicativo não instala: manda abrir no navegador", () => {
    expect(com({ ua: IPHONE_INSTAGRAM, plataforma: "iPhone", toques: 5, swOk: false })).toBe("iphone-embutido");
    expect(com({ ua: ANDROID_WEBVIEW, dedo: true })).toBe("android-embutido");
  });

  it("https em que o navegador recusou o SW (certificado não reconhecido) também fica sem app", () => {
    expect(com({ ua: ANDROID, swOk: false, temPedido: true })).toBe("sem-sw");
  });

  it("com o pedido do navegador capturado, há botão", () => {
    expect(com({ ua: ANDROID, temPedido: true })).toBe("android-botao");
    expect(com({ ua: DESKTOP, temPedido: true })).toBe("android-botao");
  });

  it("Android sem pedido: pelo menu; o Chrome em modo computador também conta como celular", () => {
    expect(com({ ua: ANDROID })).toBe("android-menu");
    expect(com({ ua: DESKTOP, plataforma: "Linux armv8l", dedo: true, toques: 5 })).toBe("android-menu");
    expect(com({ ua: DESKTOP, celularPelaDica: true })).toBe("android-menu");
  });

  it("computador sem pedido: abra no celular", () => {
    expect(com({})).toBe("outro");
  });
});
