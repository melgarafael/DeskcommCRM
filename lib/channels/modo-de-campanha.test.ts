/**
 * Como uma CAMPANHA fala por cada canal (migration 0710). A pergunta é se o
 * canal manda texto livre FORA da janela de 24 horas — campanha fala com quem
 * não escreveu —, não se ele "aceita texto".
 */
import { describe, expect, it } from "vitest";

import { canalTemRiscoDeBanimento, modoDeCampanhaDoCanal } from "./capabilities";

describe("modoDeCampanhaDoCanal", () => {
  it("QR manda texto livre; oficial direto e parceiro mandam modelo aprovado", () => {
    expect(modoDeCampanhaDoCanal("waha")).toBe("text");
    expect(modoDeCampanhaDoCanal("meta_cloud")).toBe("template");
    expect(modoDeCampanhaDoCanal("zernio")).toBe("template");
  });

  it("rede social não faz campanha; provider desconhecido não derruba a tela", () => {
    expect(modoDeCampanhaDoCanal("zernio_social")).toBeNull();
    expect(modoDeCampanhaDoCanal("um_provider_do_futuro")).toBeNull();
    expect(modoDeCampanhaDoCanal(null)).toBeNull();
  });
});

describe("canalTemRiscoDeBanimento", () => {
  it("só o QR liga aquecimento e teto anti-ban; desconhecido erra para o lado lento", () => {
    expect(canalTemRiscoDeBanimento("waha")).toBe(true);
    expect(canalTemRiscoDeBanimento("meta_cloud")).toBe(false);
    expect(canalTemRiscoDeBanimento("zernio")).toBe(false);
    expect(canalTemRiscoDeBanimento("um_provider_do_futuro")).toBe(true);
  });
});
