/**
 * O MOTOR DO AJUSTE — o `<canvas>` de verdade, do lado de fora da regra.
 *
 * `lib/branding/ajuste-de-logo.ts` decide o que tentar e em que ordem; este
 * arquivo só sabe duas coisas: o que a imagem TEM (dimensões e a caixa dos
 * pixels com alfa > 0) e o que ela VIRA ao ser recortada/reduzida. Separação
 * que existe por um motivo medido: a suíte não tem canvas (o jsdom devolve
 * `getContext` nulo e `createImageBitmap` nem existe), então qualquer DOM aqui
 * dentro tiraria o ajuste inteiro do alcance do teste — e o teste é que mede
 * bytes, dimensões e alfa.
 *
 * ── Decodificar aqui, e não no servidor ──────────────────────────────────────
 *
 * É a mesma escolha que `components/branding/CampoDeLogo.tsx` já defende ao
 * mostrar a prévia: a imagem é aberta por quem vai exibi-la. O servidor
 * continua recebendo bytes que ele só FAREJA (`lib/branding/logo-arquivo.ts`)
 * — assinatura PNG/JPEG em 8 bytes, sem decodificar, sem guarda de bomba de
 * descompressão nova.
 *
 * ── O que acontece quando não há decodificador ───────────────────────────────
 *
 * `createImageBitmap` é o único caminho de abertura, e não há fallback com
 * `<img>` + object URL de propósito: sem recurso de imagem no ambiente, o
 * `load` simplesmente nunca dispara e o upload penduraria num `await` sem
 * timeout. Falhou aqui = lançou = o chamador manda o arquivo ORIGINAL e o
 * servidor faz a recusa de sempre. Ambiente ruim não vira recusa na tela.
 */

import type { AlvoDeReencodagem, ImagemDeLogo, MotorDeAjuste } from "./ajuste-de-logo";

/** A qualidade do reescalamento: o logo precisa sair nítido, não serrilhado. */
const QUALIDADE_DO_REESCALAMENTO: ImageSmoothingQuality = "high";

/** JPEG reencodado com esta qualidade (0..1); PNG não tem qualidade, tem alfa. */
const QUALIDADE_DO_JPEG = 0.92;

async function abrir(arquivo: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap indisponível neste ambiente");
  }
  return createImageBitmap(arquivo);
}

interface Superficie {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

function superficie(largura: number, altura: number): Superficie {
  const canvas = document.createElement("canvas");
  canvas.width = largura;
  canvas.height = altura;
  const ctx = canvas.getContext("2d");
  // `null` é o jsdom (e navegador com canvas desativado): mesma saída do
  // `createImageBitmap` ausente — falha técnica, que o chamador transforma em
  // "manda o original".
  if (!ctx) throw new Error("getContext(2d) indisponível neste ambiente");
  return { canvas, ctx };
}

function tipoDe(arquivo: File): "image/png" | "image/jpeg" {
  return arquivo.type === "image/jpeg" ? "image/jpeg" : "image/png";
}

/** Codifica a lona e devolve os bytes — `toBlob` nulo vira erro, nunca vazio. */
async function codificar(
  canvas: HTMLCanvasElement,
  tipo: "image/png" | "image/jpeg",
): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, tipo, tipo === "image/jpeg" ? QUALIDADE_DO_JPEG : undefined),
  );
  if (!blob) throw new Error(`toBlob não devolveu ${tipo}`);
  return new Uint8Array(await blob.arrayBuffer());
}

export const lonaDoNavegador: MotorDeAjuste = {
  async inspecionar(arquivo: File): Promise<ImagemDeLogo> {
    const bitmap = await abrir(arquivo);
    try {
      // `ImageBitmap` fala `width`/`height`; o resto deste arquivo fala
      // `largura`/`altura`, como o contrato puro de `ajuste-de-logo.ts`.
      const { width: largura, height: altura } = bitmap;
      const { ctx } = superficie(largura, altura);
      ctx.drawImage(bitmap, 0, 0);
      // `getImageData` só sobre a imagem DECODIFICADA — o alfa é a única fonte
      // da caixa útil; nada aqui olha `file.type` ou o nome do arquivo.
      const { data } = ctx.getImageData(0, 0, largura, altura);
      let minX = largura;
      let minY = altura;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < altura; y++) {
        for (let x = 0; x < largura; x++) {
          if (data[(y * largura + x) * 4 + 3] === 0) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      // Sem pixel visível (PNG inteiro transparente) ou sangrado de ponta a
      // ponta: não há margem para cortar, e cortar igual não muda nada.
      const semMargem =
        maxX < 0 || (minX === 0 && minY === 0 && maxX === largura - 1 && maxY === altura - 1);
      return {
        largura,
        altura,
        caixa: semMargem
          ? null
          : { x: minX, y: minY, largura: maxX - minX + 1, altura: maxY - minY + 1 },
      };
    } finally {
      bitmap.close();
    }
  },

  async reencodar(arquivo: File, alvo: AlvoDeReencodagem): Promise<Uint8Array<ArrayBuffer>> {
    const bitmap = await abrir(arquivo);
    try {
      const origem = alvo.caixa ?? { x: 0, y: 0, largura: bitmap.width, altura: bitmap.height };
      const largura = Math.max(1, Math.round(origem.largura * alvo.escala));
      const altura = Math.max(1, Math.round(origem.altura * alvo.escala));
      const { canvas, ctx } = superficie(largura, altura);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = QUALIDADE_DO_REESCALAMENTO;
      // Recorte e escala num único `drawImage`: o recorte é uma janela da
      // origem, a escala acontece nela — o alfa da borda é copiado como está,
      // que é o que mantém a transparência do PNG.
      ctx.drawImage(
        bitmap,
        origem.x,
        origem.y,
        origem.largura,
        origem.altura,
        0,
        0,
        largura,
        altura,
      );
      return await codificar(canvas, tipoDe(arquivo));
    } finally {
      bitmap.close();
    }
  },
};
