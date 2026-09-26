/**
 * A FIAÇÃO DO AJUSTE NO UPLOAD — a issue #1655 chegando à tela, não só à função.
 *
 * `tests/unit/ajuste-de-logo.test.ts` mede a escada de tentativas: recortar a
 * margem transparente, reduzir até o piso, recusar quando nada coube. O que ele
 * NÃO mede — e é o que se perde num refactor silencioso — é se a tela de upload
 * da marca passa o arquivo escolhido por ela ANTES de montar o `FormData`.
 *
 * Um `ajustarLogo` perfeito e um `enviar` que submete o arquivo cru deixam a
 * pessoa exatamente onde a issue a encontrou: o PNG de 2 MB atravessa a rede e
 * volta "O logo precisa ter até 512 KB". Estes casos exercitam o COMPONENTE,
 * com o `<canvas>` substituído pelo motor de PNG de verdade (o jsdom da suíte
 * não tem canvas; ver `tests/helpers/png-sintetico.ts`), e leem o que de fato
 * entrou no `FormData`:
 *
 *   1. PNG grande com o logo só no meio → sobe o arquivo RECORTADO, ≤ 512 KB;
 *   2. arquivo dentro do teto → sobe byte a byte o que a pessoa escolheu;
 *   3. nem reduzido até o piso cabe → recusa na tela com a frase da rota e
 *      NENHUMA requisição (não se sobe megabyte para ouvir "não" do servidor).
 *
 * O teto é o mesmo dos dois lados da fronteira: aqui ele só decide mais cedo.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/**
 * O motor do navegador é trocado pelo motor de PNG — o MESMO que a suíte do
 * ajuste usa. A regra testada é a do componente; o `<canvas>` é a única peça
 * que o jsdom não oferece, e é justamente a que não tem lógica de decisão aqui.
 */
vi.mock("@/lib/branding/lona-do-navegador", async () => {
  const { motorDePngSintetico } = await import("../helpers/png-sintetico");
  return { lonaDoNavegador: motorDePngSintetico };
});

import { toast } from "sonner";

import { CampoDeLogo } from "@/components/branding/CampoDeLogo";
import { TAMANHO_MAXIMO_DO_LOGO } from "@/lib/branding/logo";
import { lerPng, montarPng, ruidoPuro, ruidoQuantizado } from "../helpers/png-sintetico";

const LIMITE = TAMANHO_MAXIMO_DO_LOGO;

/** A frase que a ROTA responde quando o arquivo passa de 512 KB. */
const RAZAO_DA_ROTA =
  "O logo precisa ter até 512 KB. Arquivo maior vai inteiro para o navegador em toda página.";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { logo_url: "https://exemplo.invalido/storage/logo.png" } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

function renderizar() {
  return render(
    <CampoDeLogo
      escopo="instalacao"
      logoDaCamada={{ url: null }}
      logoHerdado={null}
      origemDoHerdado="do sistema"
      nomeEmVigor="DeskcommCRM"
    />,
  );
}

function inputDoLogo(): HTMLInputElement {
  return document.querySelector("#logo-instalacao") as HTMLInputElement;
}

/** O `file` que o componente pôs no `FormData` do POST para a rota. */
async function arquivoEnviado(): Promise<File> {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const chamada = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(chamada[0], "o ajuste não muda a rota").toBe("/api/v1/marca/logo");
  return (chamada[1].body as FormData).get("file") as File;
}

/** 1024×1024 com o logo opaco só no retângulo do meio; a volta é transparente. */
const CAIXA_DO_LOGO = { x: 300, y: 400, largura: 600, altura: 250 };

function pngComMargemTransparente(): Uint8Array<ArrayBuffer> {
  const { largura, altura } = { largura: 1024, altura: 1024 };
  const rgba = ruidoQuantizado(largura, altura, 0x1655);
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const dentro =
        x >= CAIXA_DO_LOGO.x &&
        x < CAIXA_DO_LOGO.x + CAIXA_DO_LOGO.largura &&
        y >= CAIXA_DO_LOGO.y &&
        y < CAIXA_DO_LOGO.y + CAIXA_DO_LOGO.altura;
      if (!dentro) rgba[(y * largura + x) * 4 + 3] = 0;
      else rgba[(y * largura + x) * 4 + 3] = 255;
    }
  }
  return montarPng(largura, altura, rgba);
}

describe("o campo de logo ajusta a imagem antes de subir", () => {
  it("PNG grande com o logo só no meio sobe RECORTADO e dentro do teto", async () => {
    const escolhido = new File([pngComMargemTransparente()], "logo-do-designer.png", {
      type: "image/png",
    });
    expect(escolhido.size, "o caso da issue: passa do teto ANTES do ajuste").toBeGreaterThan(
      LIMITE,
    );

    renderizar();
    fireEvent.change(inputDoLogo(), { target: { files: [escolhido] } });

    const enviado = await arquivoEnviado();
    expect(enviado.size, "o que sobe respeita o teto de 512 KB").toBeLessThanOrEqual(LIMITE);
    expect(enviado.size, "e é menor que o arquivo escolhido").toBeLessThan(escolhido.size);

    const recortado = lerPng(new Uint8Array(await enviado.arrayBuffer()));
    // As dimensões EXATAS do recorte: 600 ≤ 800, então a escada de redução não
    // entra em ação — o arquivo que sobe é o recorte puro, sem reescalonamento.
    expect({ largura: recortado.largura, altura: recortado.altura }).toEqual({
      largura: CAIXA_DO_LOGO.largura,
      altura: CAIXA_DO_LOGO.altura,
    });
    // A transparência sobrevive: o que era margem não vira pixel branco.
    expect(recortado.rgba[3], "a borda opaca do logo virou a borda do arquivo").toBe(255);
    expect(toast.success, "e o servidor recebeu o arquivo, não uma recusa").toHaveBeenCalled();
  });

  it("arquivo dentro do teto sobe INTACTO — byte a byte, sem reencode", async () => {
    const escolhido = new File([montarPng(64, 64, ruidoQuantizado(64, 64, 7))], "mini.png", {
      type: "image/png",
    });
    expect(escolhido.size).toBeLessThan(LIMITE);

    renderizar();
    fireEvent.change(inputDoLogo(), { target: { files: [escolhido] } });

    const enviado = await arquivoEnviado();
    expect(new Uint8Array(await enviado.arrayBuffer())).toEqual(
      new Uint8Array(await escolhido.arrayBuffer()),
    );
    expect(enviado.type).toBe("image/png");
  });

  it("nem reduzido até o piso cabe → recusa na tela e ZERO requisição", async () => {
    // Ruído incompressível em PNG: nem a largura no piso (512) tira os bytes
    // necessários — medido: 640×640 → 1.402.013 bytes, 512×512 → 897.393.
    const escolhido = new File(
      [montarPng(700, 700, ruidoPuro(700, 700, 0x1657))],
      "ruido-puro.png",
      {
        type: "image/png",
      },
    );

    renderizar();
    fireEvent.change(inputDoLogo(), { target: { files: [escolhido] } });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0]?.[0], "a frase é a MESMA da rota").toBe(
      RAZAO_DA_ROTA,
    );
    expect(fetchMock, "não se sobe megabyte para ouvir 'não' do servidor").not.toHaveBeenCalled();
  });
});
