/**
 * R4 da Spec 25 — a foto de item de receita no WhatsApp.
 *
 * Cada caso prende UM degrau de segurança de `foto-da-receita.ts`. O `fetch` é
 * falso e ESPIADO: o que importa em quase todo caso é que ele NÃO foi chamado.
 * A guarda é a canônica (`assertUrlDeMidiaSegura`); só o DNS é dublê.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async (host: string) =>
    host === "interno.exemplo.com"
      ? [{ address: "10.1.2.3", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
  );
  return { lookup, default: { lookup } };
});

import { enviarComFotos } from "./fotos-do-produto";
import {
  FOTO_DA_RECEITA_MAX_BYTES,
  ImagensDaReceitaNoTurno,
  baixarImagemDaReceita,
  mimePelosBytes,
  prepararFotoDaReceita,
} from "./foto-da-receita";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const URL_OK = "https://loja.exemplo.com/wp-content/uploads/casa.jpg";

function resposta(bytes: Uint8Array, tipo = "image/jpeg", extra: Record<string, string> = {}): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": tipo, ...extra } });
}

function receitaDevolveu(...urls: string[]): ImagensDaReceitaNoTurno {
  const imagens = new ImagensDaReceitaNoTurno();
  imagens.registrar({ linhas: urls.map((imagem_url) => ({ id: "1", imagem_url })) });
  return imagens;
}

let fetchFalso: ReturnType<typeof vi.fn>;
let subir: ReturnType<typeof vi.fn>;
const warn = vi.fn();

beforeEach(() => {
  fetchFalso = vi.fn(async () => resposta(JPEG));
  subir = vi.fn(async () => true);
  warn.mockClear();
});

const entrada = (url: string) => ({ url, tenantId: "org-1", conversationId: "conv-1" });
const preparar = (url: string, imagens = receitaDevolveu(url), extra: Record<string, unknown> = {}) =>
  prepararFotoDaReceita(entrada(url), imagens, {
    fetch: fetchFalso as unknown as typeof fetch,
    subir: subir as never,
    log: { warn },
    ...extra,
  });

describe("só vale a imagem_url que a receita devolveu NESTE turno", () => {
  it("URL fora da lista → erro de ensino, nada baixado, nada subido", async () => {
    const r = await preparar("https://outro.exemplo.com/a.jpg", receitaDevolveu(URL_OK));
    expect(r).toMatchObject({ ok: false, code: "imagem_fora_da_receita" });
    expect(r.ok === false && r.message).toContain("devolveu para o item");
    expect(fetchFalso).not.toHaveBeenCalled();
    expect(subir).not.toHaveBeenCalled();
  });

  it("sem nenhuma consulta no turno → recusada", async () => {
    const r = await preparar(URL_OK, new ImagensDaReceitaNoTurno());
    expect(r).toMatchObject({ ok: false, code: "imagem_fora_da_receita" });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("resultado de erro da consulta não registra nada", () => {
    const imagens = new ImagensDaReceitaNoTurno();
    imagens.registrar({ erro: "fonte_nao_liberada", linhas: [{ imagem_url: URL_OK }] });
    expect(imagens.tem(URL_OK)).toBe(false);
  });
});

describe("C6 — a guarda anti-SSRF vem ANTES de qualquer fetch", () => {
  it.each([
    ["loopback", "http://127.0.0.1/a.jpg"],
    ["metadata da nuvem", "http://169.254.169.254/latest/meta-data/a.jpg"],
    ["rede privada", "http://10.0.0.5/a.jpg"],
    ["localhost", "http://localhost/a.jpg"],
    ["host que RESOLVE para IP interno", "https://interno.exemplo.com/a.jpg"],
  ])("%s → recusada, fetch com ZERO chamadas e o texto sai", async (_nome, url) => {
    const r = await preparar(url);
    expect(r).toMatchObject({ ok: false, code: "imagem_indisponivel" });
    expect(r.ok === false && "motivo" in r && r.motivo).toMatch(/^unsafe_url/);
    expect(fetchFalso).not.toHaveBeenCalled();
    expect(subir).not.toHaveBeenCalled();
  });

  it("o log leva só o host, nunca a URL inteira", async () => {
    await preparar("http://127.0.0.1/segredo/token=abc.jpg");
    const campos = JSON.stringify(warn.mock.calls);
    expect(campos).toContain("127.0.0.1");
    expect(campos).not.toContain("token=abc");
  });
});

describe("redirecionamento: cada salto passa de novo pela guarda", () => {
  it("redireciona para IP interno → recusado no salto, sem buscar o destino", async () => {
    fetchFalso.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );
    const r = await baixarImagemDaReceita(URL_OK, { fetch: fetchFalso as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, motivo: "unsafe_url:private_host" });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(fetchFalso.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("salto legítimo é seguido; passou de 2 saltos → recusa", async () => {
    fetchFalso
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/b.jpg" } }))
      .mockResolvedValueOnce(resposta(JPEG));
    const ok = await baixarImagemDaReceita(URL_OK, { fetch: fetchFalso as unknown as typeof fetch });
    expect(ok.ok).toBe(true);
    expect(fetchFalso.mock.calls[1]![0]).toBe("https://loja.exemplo.com/b.jpg");

    const muitos = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/c.jpg" } }));
    const r = await baixarImagemDaReceita(URL_OK, { fetch: muitos as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, motivo: "redirecionamentos_demais" });
    expect(muitos).toHaveBeenCalledTimes(3);
  });
});

describe("teto de bytes, de tempo e tipo", () => {
  it("corpo > 5 MB SEM content-length → corta e manda só texto", async () => {
    const grande = new Uint8Array(FOTO_DA_RECEITA_MAX_BYTES + 10);
    grande.set(JPEG);
    fetchFalso.mockResolvedValueOnce(resposta(grande));
    const r = await preparar(URL_OK);
    expect(r).toMatchObject({ ok: false, code: "imagem_indisponivel", motivo: "grande_demais" });
    expect(subir).not.toHaveBeenCalled();
  });

  it("content-length declarado acima do teto → recusa antes de ler o corpo", async () => {
    fetchFalso.mockResolvedValueOnce(resposta(JPEG, "image/jpeg", { "content-length": String(FOTO_DA_RECEITA_MAX_BYTES + 1) }));
    const r = await baixarImagemDaReceita(URL_OK, { fetch: fetchFalso as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, motivo: "grande_demais" });
  });

  it("tempo esgotado → só texto", async () => {
    const lento = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("abortado")));
        }),
    );
    const r = await baixarImagemDaReceita(URL_OK, { fetch: lento as unknown as typeof fetch, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, motivo: "tempo_esgotado" });
  });

  it("text/html com nome .jpg → recusada", async () => {
    fetchFalso.mockResolvedValueOnce(resposta(new TextEncoder().encode("<html>"), "text/html"));
    const r = await preparar("https://loja.exemplo.com/a.jpg");
    expect(r).toMatchObject({ ok: false, code: "imagem_indisponivel", motivo: "tipo_nao_aceito" });
  });

  it("content-type de imagem mas bytes de HTML → recusada pelos bytes", async () => {
    fetchFalso.mockResolvedValueOnce(resposta(new TextEncoder().encode("<html><body>"), "image/jpeg"));
    const r = await preparar(URL_OK);
    expect(r).toMatchObject({ ok: false, motivo: "tipo_nao_aceito" });
  });

  it("reconhece jpeg, png e webp pelos bytes", () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(mimePelosBytes(JPEG)).toBe("image/jpeg");
    expect(mimePelosBytes(PNG)).toBe("image/png");
    expect(mimePelosBytes(webp)).toBe("image/webp");
    expect(mimePelosBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });
});

describe("falha de mídia nunca derruba o texto", () => {
  it("upload que LANÇA vira imagem_indisponivel, não exceção", async () => {
    subir.mockRejectedValueOnce(new Error("storage fora do ar"));
    await expect(preparar(URL_OK)).resolves.toMatchObject({ ok: false, code: "imagem_indisponivel" });
  });

  it("fetch que lança vira imagem_indisponivel, não exceção", async () => {
    fetchFalso.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(preparar(URL_OK)).resolves.toMatchObject({ ok: false, code: "imagem_indisponivel" });
  });

  it("sem foto preparada, o envio manda o texto sozinho", async () => {
    const enviarTexto = vi.fn(async (b: string) => ({ kind: "sent" as const, body: b }));
    const enviarFoto = vi.fn(async () => ({ kind: "sent" as const }));
    await enviarComFotos("Casa linda no centro", [], {
      enviarTexto,
      enviarFoto,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    expect(enviarTexto).toHaveBeenCalledWith("Casa linda no centro");
    expect(enviarFoto).not.toHaveBeenCalled();
  });
});

describe("caminho feliz", () => {
  it("baixa, sobe em whatsapp-media na pasta da conversa e entrega 1 foto; a legenda é o texto", async () => {
    const r = await preparar(URL_OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.foto.mime).toBe("image/jpeg");
    expect(r.foto.storagePath).toMatch(/^org-1\/conv-1\/receita-[0-9a-f]{16}\.jpg$/);
    expect(subir).toHaveBeenCalledWith(r.foto.storagePath, expect.any(Uint8Array), "image/jpeg");

    const enviarTexto = vi.fn(async () => ({ kind: "sent" as const }));
    const enviarFoto = vi.fn(async () => ({ kind: "sent" as const }));
    await enviarComFotos("Casa de 3 quartos, R$ 450 mil", [r.foto], {
      enviarTexto,
      enviarFoto,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    // Uma foto, com o texto como legenda: UM envio, nenhum texto à parte.
    expect(enviarFoto).toHaveBeenCalledTimes(1);
    expect(enviarFoto).toHaveBeenCalledWith(r.foto, "Casa de 3 quartos, R$ 450 mil");
    expect(enviarTexto).not.toHaveBeenCalled();
  });

  it("o destino é determinístico: o mesmo item na mesma conversa reaproveita o arquivo", async () => {
    const a = await preparar(URL_OK);
    const b = await preparar(URL_OK);
    expect(a.ok && b.ok && a.foto.storagePath === b.foto.storagePath).toBe(true);
  });
});
