import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  baixarImagemSegura,
  guardarImagemNaConversa,
  lerComTeto,
  TETO_DE_BYTES_DA_IMAGEM,
  type DepsDeDownload,
  type RespostaDeRede,
} from "./baixar-imagem-segura";

// Nenhum teste deste arquivo abre conexão nem consulta DNS de verdade: as dependências
// de rede entram por `deps`. A versão real de `resolver`/`requisitar` não roda aqui.

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(16, 1)]);
const IP_PUBLICO = "93.184.216.34";

function resposta(
  partes: Buffer[],
  opcoes: { status?: number; contentType?: string | undefined } = {},
) {
  const contador = { lidos: 0, descartado: false };
  const corpo = (async function* () {
    for (const parte of partes) {
      contador.lidos += 1;
      yield parte;
    }
  })();
  const resp: RespostaDeRede = {
    status: opcoes.status ?? 200,
    contentType: "contentType" in opcoes ? opcoes.contentType : "image/jpeg",
    corpo,
    descartar: () => {
      contador.descartado = true;
    },
  };
  return { resp, contador };
}

function deps(resp: RespostaDeRede, ips: string[] = [IP_PUBLICO]) {
  const requisitar = vi.fn(async () => resp);
  const resolver = vi.fn(async () => ips.map((address) => ({ address, family: 4 })));
  return { deps: { requisitar, resolver } as DepsDeDownload, requisitar, resolver };
}

const URL_JPG = "https://exemplo.test/receitas/casa-1.jpg";

describe("baixarImagemSegura — o IP validado é o IP da conexão (sem rebinding)", () => {
  it("o resolver é chamado UMA vez e a conexão vai para o IP da checagem, com o hostname da URL", async () => {
    const { resp } = resposta([JPEG]);
    const requisitar = vi.fn(async () => resp);
    // Se o DNS fosse consultado de novo, devolveria um IP interno. Não pode ser usado.
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: IP_PUBLICO, family: 4 }])
      .mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const r = await baixarImagemSegura(URL_JPG, { requisitar, resolver } as DepsDeDownload);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(requisitar).toHaveBeenCalledTimes(1);
    const args = (requisitar.mock.calls[0] as unknown as [unknown])[0] as { url: URL; ip: string; family: number; timeoutMs: number };
    expect(args.ip).toBe(IP_PUBLICO);
    expect(args.family).toBe(4);
    expect(args.url.hostname).toBe("exemplo.test");
    expect(args.timeoutMs).toBe(8000);
    expect(r.ok).toBe(true);
  });
});

describe("baixarImagemSegura — destino interno é recusado antes de conectar", () => {
  it.each([
    ["metadado de nuvem (literal)", "http://169.254.169.254/x.jpg"],
    ["localhost", "http://localhost/x.png"],
    ["IP privado literal", "https://10.0.0.5/x.webp"],
    ["IPv6 literal", "https://[::1]/x.jpg"],
  ])("recusa %s sem resolver nem conectar", async (_nome, url) => {
    const { resp } = resposta([JPEG]);
    const { deps: d, requisitar, resolver } = deps(resp);
    const r = await baixarImagemSegura(url, d);
    expect(r.ok).toBe(false);
    expect(requisitar).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([
    ["metadado de nuvem", ["169.254.169.254"]],
    ["rede do compose", ["10.0.0.5"]],
    ["loopback", ["127.0.0.1"]],
    ["IPv6 loopback", ["::1"]],
    ["um interno entre públicos", [IP_PUBLICO, "10.0.0.5", "93.184.216.35"]],
  ])("domínio público que resolve para %s é recusado", async (_nome, ips) => {
    const { resp } = resposta([JPEG]);
    const { deps: d, requisitar } = deps(resp, ips);
    const r = await baixarImagemSegura(URL_JPG, d);
    expect(r).toEqual({ ok: false, motivo: "destino_interno" });
    expect(requisitar).not.toHaveBeenCalled();
  });

  it("DNS que falha é recusa, não conexão às cegas", async () => {
    const { resp } = resposta([JPEG]);
    const requisitar = vi.fn(async () => resp);
    const resolver = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const r = await baixarImagemSegura(URL_JPG, { requisitar, resolver } as DepsDeDownload);
    expect(r).toEqual({ ok: false, motivo: "dns_falhou" });
    expect(requisitar).not.toHaveBeenCalled();
  });
});

describe("baixarImagemSegura — redirect nunca é seguido", () => {
  it.each([301, 302, 307])("status %i vira redirect_recusado, uma única requisição", async (status) => {
    const { resp, contador } = resposta([], { status, contentType: undefined });
    const { deps: d, requisitar } = deps(resp);
    const r = await baixarImagemSegura(URL_JPG, d);
    expect(r).toEqual({ ok: false, motivo: "redirect_recusado" });
    expect(requisitar).toHaveBeenCalledTimes(1);
    expect(contador.descartado).toBe(true);
  });

  it("só 200 passa: 404 vira status_nao_200", async () => {
    const { resp } = resposta([JPEG], { status: 404 });
    const { deps: d } = deps(resp);
    expect(await baixarImagemSegura(URL_JPG, d)).toEqual({ ok: false, motivo: "status_nao_200" });
  });
});

describe("baixarImagemSegura — conteúdo conferido: tipo declarado, extensão e bytes mágicos", () => {
  it("content-type text/html numa URL .jpg vira conteudo_nao_e_imagem", async () => {
    const { resp } = resposta([JPEG], { contentType: "text/html" });
    const { deps: d } = deps(resp);
    expect(await baixarImagemSegura(URL_JPG, d)).toEqual({ ok: false, motivo: "conteudo_nao_e_imagem" });
  });

  it("content-type image/png numa URL .jpg é divergência com a extensão", async () => {
    const { resp } = resposta([JPEG], { contentType: "image/png" });
    const { deps: d } = deps(resp);
    expect(await baixarImagemSegura(URL_JPG, d)).toEqual({ ok: false, motivo: "conteudo_nao_e_imagem" });
  });

  it("content-type image/png com bytes de JPEG numa URL .png é recusado pelos bytes", async () => {
    const { resp } = resposta([JPEG], { contentType: "image/png" });
    const { deps: d } = deps(resp);
    expect(await baixarImagemSegura("https://exemplo.test/x.png", d)).toEqual({
      ok: false,
      motivo: "conteudo_nao_e_imagem",
    });
  });

  it("content-type com parâmetro (image/jpeg; charset=binary) passa", async () => {
    const { resp } = resposta([JPEG], { contentType: "image/jpeg; charset=binary" });
    const { deps: d } = deps(resp);
    expect(await baixarImagemSegura(URL_JPG, d)).toEqual({ ok: true, bytes: JPEG, mime: "image/jpeg" });
  });

  it("PNG e WebP com bytes mágicos corretos passam", async () => {
    const png = resposta([PNG], { contentType: "image/png" });
    expect(await baixarImagemSegura("https://exemplo.test/x.png", deps(png.resp).deps)).toEqual({
      ok: true,
      bytes: PNG,
      mime: "image/png",
    });
    const webp = resposta([WEBP], { contentType: "image/webp" });
    expect(await baixarImagemSegura("https://exemplo.test/x.webp", deps(webp.resp).deps)).toEqual({
      ok: true,
      bytes: WEBP,
      mime: "image/webp",
    });
  });
});

describe("baixarImagemSegura — teto de 5 MB: para de ler ao passar", () => {
  it("corpo acima do teto aborta sem ler o resto", async () => {
    const pedaco = Buffer.alloc(1024 * 1024, 0xff);
    const partes = Array.from({ length: 10 }, () => pedaco);
    const { resp, contador } = resposta(partes);
    const { deps: d } = deps(resp);
    const r = await baixarImagemSegura(URL_JPG, d);
    expect(r).toEqual({ ok: false, motivo: "imagem_grande_demais" });
    // 5 MB cabem em 5 pedaços; o 6º estoura o teto, e os 4 últimos nunca são lidos.
    expect(contador.lidos).toBe(6);
    expect(contador.descartado).toBe(true);
  });

  it("lerComTeto aceita exatamente o teto", async () => {
    const pedaco = Buffer.alloc(TETO_DE_BYTES_DA_IMAGEM, 1);
    const corpo = (async function* () {
      yield pedaco;
    })();
    const r = await lerComTeto(corpo, TETO_DE_BYTES_DA_IMAGEM, () => undefined);
    expect(r.ok).toBe(true);
  });
});

describe("baixarImagemSegura — falha de rede é recusa, não exceção", () => {
  it("requisitar que lança vira download_falhou", async () => {
    const requisitar = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const resolver = vi.fn(async () => [{ address: IP_PUBLICO, family: 4 }]);
    const r = await baixarImagemSegura(URL_JPG, { requisitar, resolver } as DepsDeDownload);
    expect(r).toEqual({ ok: false, motivo: "download_falhou" });
  });
});

describe("guardarImagemNaConversa — nome pelo conteúdo, caminho da conversa, 409 é ok", () => {
  function storage(erro: { message: string; statusCode?: string } | null) {
    const upload = vi.fn(async () => ({ error: erro }));
    const from = vi.fn(() => ({ upload }));
    return { admin: { storage: { from } }, upload, from };
  }
  const T = "aaaaaaaa-0000-4000-8000-000000000001";
  const C = "cccccccc-0000-4000-8000-000000000001";

  it("grava em whatsapp-media/<tenant>/<conversa>/externa-<hash>.jpg, sem upsert", async () => {
    const { admin, upload, from } = storage(null);
    const hash = createHash("sha256").update(JPEG).digest("hex").slice(0, 16);
    const r = await guardarImagemNaConversa(admin, { tenantId: T, conversationId: C, bytes: JPEG, mime: "image/jpeg" });
    expect(from).toHaveBeenCalledWith("whatsapp-media");
    expect(upload).toHaveBeenCalledWith(`${T}/${C}/externa-${hash}.jpg`, JPEG, {
      contentType: "image/jpeg",
      upsert: false,
    });
    expect(r).toEqual({ ok: true, storagePath: `${T}/${C}/externa-${hash}.jpg`, mime: "image/jpeg" });
  });

  it("409 (já existe) é sucesso: a mesma imagem não duplica arquivo", async () => {
    const { admin } = storage({ message: "The resource already exists", statusCode: "409" });
    const r = await guardarImagemNaConversa(admin, { tenantId: T, conversationId: C, bytes: JPEG, mime: "image/jpeg" });
    expect(r.ok).toBe(true);
  });

  it("outro erro do Storage vira storage_falhou", async () => {
    const { admin } = storage({ message: "bucket offline", statusCode: "500" });
    const r = await guardarImagemNaConversa(admin, { tenantId: T, conversationId: C, bytes: JPEG, mime: "image/jpeg" });
    expect(r).toEqual({ ok: false, motivo: "storage_falhou" });
  });

  it("caminho que sai da conversa é recusado antes do upload", async () => {
    const { admin, upload } = storage(null);
    const r = await guardarImagemNaConversa(admin, {
      tenantId: T,
      conversationId: "../outra",
      bytes: JPEG,
      mime: "image/jpeg",
    });
    expect(r).toEqual({ ok: false, motivo: "caminho_invalido" });
    expect(upload).not.toHaveBeenCalled();
  });
});
