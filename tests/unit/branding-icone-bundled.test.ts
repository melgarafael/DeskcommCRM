/**
 * O caminho novo de `app/icon.tsx`/`app/apple-icon.tsx` — ler o PNG bundled do
 * disco (`public/branding/verta-icon-*.png`) e servir os bytes direto, sem
 * passar pelo `next/og`.
 *
 * `tests/unit/branding-icone-da-aba.test.ts` cobre o gerador de cor+inicial
 * (via `letraDoIcone`, puro) e a régua estática do arquivo (`force-dynamic`,
 * `marcaDaSaida(null)` no texto) — mas nenhum caso chama de fato o `default`
 * exportado, então o `try { readFile(...) }` que decide qual dos dois
 * caminhos roda nunca foi exercitado. Este arquivo fecha essa lacuna:
 * bundled presente → bytes do arquivo, sem tocar `marcaDaSaida`/`ImageResponse`;
 * bundled ausente → cai no fallback de sempre.
 */
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => {
  const readFile = vi.fn();
  return { readFile, default: { readFile } };
});

vi.mock("next/og", () => ({
  // `ImageResponse` real sobe satori/resvg (WASM) — pesado e fora do que este
  // caso precisa provar. O que importa é SE o módulo chama o gerador e com
  // que letra/cor, não o PNG que o satori desenharia.
  ImageResponse: vi.fn().mockImplementation(function (
    this: { __mockImageResponse: boolean; element: unknown; opts: unknown },
    element: unknown,
    opts: unknown,
  ) {
    // Função comum (não arrow, não classe): `new ImageResponse(...)` no
    // código real precisa de algo construtível, e um mock tipado como classe
    // não é atribuível ao tipo `(...args) => any` que `vi.fn()` infere aqui.
    this.__mockImageResponse = true;
    this.element = element;
    this.opts = opts;
  }),
}));

vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(),
}));

const readFileMock = vi.mocked(readFile);

import { marcaDaSaida } from "@/lib/branding/saida";
import { ImageResponse } from "next/og";

import AppleIcon from "@/app/apple-icon";
import Icon from "@/app/icon";

const marcaDaSaidaMock = vi.mocked(marcaDaSaida);
const imageResponseMock = vi.mocked(ImageResponse);

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  { nome: "app/icon.tsx", Rota: Icon, tamanho: 64 },
  { nome: "app/apple-icon.tsx", Rota: AppleIcon, tamanho: 180 },
])("$nome", ({ Rota, tamanho }) => {
  it("arquivo bundled presente: serve os bytes do disco, sem tocar o gerador", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]); // assinatura PNG + lixo
    readFileMock.mockResolvedValueOnce(Buffer.from(bytes));

    const res = await Rota();

    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=600",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    // O ponto do caminho bundled é justamente NÃO pagar o custo do fallback.
    expect(marcaDaSaidaMock).not.toHaveBeenCalled();
    expect(imageResponseMock).not.toHaveBeenCalled();
  });

  it("arquivo bundled ausente: cai no fallback de cor + inicial de sempre", async () => {
    readFileMock.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    marcaDaSaidaMock.mockResolvedValueOnce({
      nome: "Vendas Turbo",
      logoUrl: null,
      accent: "#6d28d9",
      accentFg: "#ffffff",
      origens: { nome: "padrao", cor: "padrao" },
    });

    const res = await Rota();

    // Instalação sem customização: `readFile` falhou, então é o gerador
    // (mockado) quem responde — não o `Response` de bytes do caso acima.
    expect(res).toEqual(
      expect.objectContaining({ __mockImageResponse: true }),
    );
    expect(marcaDaSaidaMock).toHaveBeenCalledWith(null);
    expect(imageResponseMock).toHaveBeenCalledTimes(1);

    const [element, opts] = imageResponseMock.mock.calls[0]!;
    // `letraDoIcone("Vendas Turbo")` é "V" — prova que a letra desenhada vem
    // do nome resolvido, não de um literal.
    expect((element as { props: { children: string } }).props.children).toBe("V");
    expect((element as { props: { style: Record<string, unknown> } }).props.style).toMatchObject(
      { background: "#6d28d9", color: "#ffffff" },
    );
    expect(opts).toMatchObject({ width: tamanho, height: tamanho });
  });

  it("marca sem letra (só emoji/pontuação): o ladrilho vai sem letra nenhuma", async () => {
    readFileMock.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    marcaDaSaidaMock.mockResolvedValueOnce({
      nome: "🚀",
      logoUrl: null,
      accent: "#6d28d9",
      accentFg: "#ffffff",
      origens: { nome: "padrao", cor: "padrao" },
    });

    await Rota();

    const [element] = imageResponseMock.mock.calls[0]!;
    // Cair na inicial do produto aqui seria vazamento de marca — o ladrilho
    // fica só com a cor, sem letra (`letraDoIcone` devolve `null`).
    expect((element as { props: { children: string } }).props.children).toBe("");
  });
});
