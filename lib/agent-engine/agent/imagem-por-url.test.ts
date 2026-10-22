import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookup,
  default: { lookup: mocks.lookup },
}));

import {
  descreverSemQuery,
  formatoDeImagemPorUrl,
  paraMidiaDoCanal,
  prepararImagemPorUrl,
  type FotoDeUrl,
} from "./imagem-por-url";
import { enviarComFotos, LIMITE_DA_LEGENDA } from "./fotos-do-produto";

const CAPA: FotoDeUrl = { url: "https://exemplo.test/receitas/casa-1.jpg", mime: "image/jpeg", type: "image" };

beforeEach(() => {
  mocks.lookup.mockReset();
  // Por padrão o host público resolve para IP público; cada teste troca quando precisa.
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("formatoDeImagemPorUrl — só o formato, sem rede", () => {
  it.each([
    ["jpg", "https://exemplo.test/a/b.jpg", "image/jpeg"],
    ["jpeg", "https://exemplo.test/a/b.JPEG", "image/jpeg"],
    ["png", "https://exemplo.test/a/b.png", "image/png"],
    ["webp", "https://exemplo.test/a/b.webp", "image/webp"],
  ])("aceita %s e define o mime", (_nome, url, mime) => {
    expect(formatoDeImagemPorUrl(url)).toEqual({ ok: true, foto: { url, mime, type: "image" } });
  });

  it("a extensão decide pelo CAMINHO: a query-string não entra na conta", () => {
    expect(formatoDeImagemPorUrl("https://exemplo.test/x.jpg?ext=.gif&token=t").ok).toBe(true);
    expect(formatoDeImagemPorUrl("https://exemplo.test/x.gif?ext=.jpg")).toEqual({
      ok: false,
      motivo: "extensao_nao_aceita",
    });
  });

  it.each([
    ["gif (fora da lista desta fatia)", "https://exemplo.test/x.gif"],
    ["php", "https://exemplo.test/x.php"],
    ["sem extensão", "https://exemplo.test/foto"],
    ["extensão que é nome de propriedade de objeto", "https://exemplo.test/x.constructor"],
  ])("recusa %s", (_nome, url) => {
    expect(formatoDeImagemPorUrl(url)).toEqual({ ok: false, motivo: "extensao_nao_aceita" });
  });

  it("URL que não parseia volta como url_invalida", () => {
    expect(formatoDeImagemPorUrl("não é url")).toEqual({ ok: false, motivo: "url_invalida" });
  });
});

describe("prepararImagemPorUrl — a guarda anti-SSRF (C6) roda ANTES de qualquer envio", () => {
  it.each([
    ["metadata da nuvem", "http://169.254.169.254/x.jpg", "unsafe_url:private_host"],
    ["localhost", "http://localhost/x.png", "unsafe_url:private_host"],
    ["IP privado do compose", "http://10.0.0.5/x.webp", "unsafe_url:private_host"],
  ])("recusa host interno literal (%s) sem consultar DNS", async (_nome, url, motivo) => {
    const r = await prepararImagemPorUrl(url);
    expect(r).toEqual({ ok: false, motivo });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("recusa domínio público que resolve para IP privado (rebinding por DNS)", async () => {
    mocks.lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const r = await prepararImagemPorUrl("https://exemplo.test/x.jpg");
    expect(r).toEqual({ ok: false, motivo: "unsafe_url:private_ip" });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("recusa domínio que resolve para metadado de nuvem mesmo com um registro público junto", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const r = await prepararImagemPorUrl("https://exemplo.test/x.png");
    expect(r).toEqual({ ok: false, motivo: "unsafe_url:private_ip" });
  });

  it("extensão recusada não chega a consultar DNS nem a guarda de rede", async () => {
    const r = await prepararImagemPorUrl("https://exemplo.test/x.php");
    expect(r).toEqual({ ok: false, motivo: "extensao_nao_aceita" });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("URL pública com extensão aceita passa com o mime", async () => {
    const r = await prepararImagemPorUrl(CAPA.url);
    expect(r).toEqual({ ok: true, foto: CAPA });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
});

describe("descreverSemQuery — o que vai ao log não tem query (pode ter token)", () => {
  it("fica com host e caminho", () => {
    expect(descreverSemQuery("https://exemplo.test/a/x.jpg?token=segredo")).toBe("exemplo.test/a/x.jpg");
  });
  it("URL inválida vira marcador, nunca o texto cru", () => {
    expect(descreverSemQuery("não é url token=segredo")).toBe("(url inválida)");
  });
});

describe("envio da foto por URL — chega ao canal como mídia por URL, com o texto como legenda", () => {
  const FOTO_2: FotoDeUrl = { url: "https://exemplo.test/receitas/casa-2.jpg", mime: "image/jpeg", type: "image" };
  const FOTO_3: FotoDeUrl = { url: "https://exemplo.test/receitas/casa-3.jpg", mime: "image/jpeg", type: "image" };

  function canal() {
    const enviados: Array<{ tipo: "texto" | "foto"; corpo: string; media?: unknown }> = [];
    return {
      enviados,
      opts: {
        enviarTexto: async (corpo: string) => (enviados.push({ tipo: "texto", corpo }), { kind: "sent" as const }),
        enviarFoto: async (foto: FotoDeUrl, legenda: string) => (
          enviados.push({ tipo: "foto", corpo: legenda, media: paraMidiaDoCanal(foto) }),
          { kind: "sent" as const }
        ),
        sleep: vi.fn(async () => undefined),
        jitter: () => 1500,
      },
    };
  }

  it("a foto por URL vai como { url, mime, type: 'image' } e o texto é a legenda", async () => {
    const c = canal();
    await enviarComFotos("Casa 2 quartos, R$ 350 mil", [CAPA], c.opts);
    expect(c.enviados).toEqual([
      {
        tipo: "foto",
        corpo: "Casa 2 quartos, R$ 350 mil",
        media: { url: CAPA.url, mime: "image/jpeg", type: "image" },
      },
    ]);
  });

  it("texto maior que a legenda sai como texto antes, e a foto depois sem legenda", async () => {
    const c = canal();
    const longo = "a".repeat(LIMITE_DA_LEGENDA + 1);
    await enviarComFotos(longo, [CAPA], c.opts);
    expect(c.enviados.map((e) => [e.tipo, e.corpo])).toEqual([
      ["texto", longo],
      ["foto", ""],
    ]);
  });

  it("o teto do turno vale para a foto por URL: com o teto zerado, a foto não sai", async () => {
    const c = canal();
    await enviarComFotos("Casa 2 quartos", [CAPA], { ...c.opts, restantes: () => 0 });
    expect(c.enviados).toEqual([{ tipo: "texto", corpo: "Casa 2 quartos" }]);
  });

  it("com teto 2 e duas fotos, o texto gasta uma das mensagens e só uma foto sai", async () => {
    const c = canal();
    await enviarComFotos("Casa 2 quartos", [CAPA, FOTO_2], {
      ...c.opts,
      restantes: () => 2 - c.enviados.length,
    });
    expect(c.enviados.map((e) => e.tipo)).toEqual(["foto", "foto"]);
    // Teto zerado: a terceira foto não sai; sobra só o texto da chamada.
    await enviarComFotos("x", [FOTO_3], { ...c.opts, restantes: () => 0 });
    expect(c.enviados.slice(2).map((e) => e.tipo)).toEqual(["texto"]);
  });
});

describe("paraMidiaDoCanal — a foto do catálogo continua por caminho, a de URL por URL", () => {
  it("foto de URL", () => {
    expect(paraMidiaDoCanal(CAPA)).toEqual({ url: CAPA.url, mime: "image/jpeg", type: "image" });
  });
  it("foto do catálogo segue por storagePath, como antes", () => {
    expect(paraMidiaDoCanal({ storagePath: "org/conv/catalogo-1.jpg", mime: "image/jpeg" })).toEqual({
      storagePath: "org/conv/catalogo-1.jpg",
      mime: "image/jpeg",
    });
  });
});
