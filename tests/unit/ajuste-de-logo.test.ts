import { describe, expect, it, vi } from "vitest";

import {
  ajustarLogo,
  LARGURA_MAXIMA_DO_LOGO,
  LARGURA_MINIMA_DO_LOGO,
  type Caixa,
} from "@/lib/branding/ajuste-de-logo";
import { lonaDoNavegador } from "@/lib/branding/lona-do-navegador";
import { TAMANHO_MAXIMO_DO_LOGO } from "@/lib/branding/logo";
import {
  lerPng,
  montarPng,
  motorDePngSintetico,
  ruidoPuro,
  ruidoQuantizado,
} from "../helpers/png-sintetico";

/**
 * O AJUSTE DO LOGO NO NAVEGADOR — o caso da issue #1655 medido em bytes.
 *
 * A pessoa tem um PNG de 1536×1024 com o logo ocupando só o meio; o servidor
 * recusa por passar de 512 KB e ela trava na tela. O que este arquivo mede:
 *
 *   1. arquivo DENTRO do teto passa reto — byte a byte, sem decodificar nada;
 *   2. o recorte da margem transparente entrega o arquivo ≤512 KB com as
 *      dimensões EXATAS da caixa útil e o alfa intacto;
 *   3. quando o recorte não basta, a largura cai até caber (e para no piso);
 *   4. quando nem no piso cabe, `recusar` sobe — não se submete arquivo que o
 *      servidor vai rejeitar, e a mensagem continua sendo a de sempre;
 *   5. sem decodificador no ambiente, o original vai ao servidor — que é quem
 *      decide, como antes.
 *
 * O motor injetado aqui é um PNG de verdade (`tests/helpers/png-sintetico.ts`):
 * o teste lê o ARQUIVO QUE SAIU, não uma estimativa de tamanho. O que não se
 * prova aqui é o `<canvas>` em si — o jsdom da suíte não tem um, e o caso (5) é
 * exatamente o caminho em que isso não pode quebrar o upload.
 */

const LIMITE = TAMANHO_MAXIMO_DO_LOGO;

// O motor de PNG e a caixa útil vêm de `tests/helpers/png-sintetico.ts` — o mesmo
// motor que a suíte do campo de logo usa, e a razão de existir só um.

function arquivoDe(nome: string, bytes: Uint8Array<ArrayBuffer>, tipo = "image/png"): File {
  return new File([bytes], nome, { type: tipo });
}

function opaco(rgba: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return rgba;
}

/** A imagem da issue: 1536×1024, logo 704×286 no meio, volta 100% transparente. */
const CAIXA_ESPERADA: Caixa = { x: 416, y: 369, largura: 704, altura: 286 };
const LINHA_SEMITRANSPARENTE = 12; // dentro do bloco do logo
const FURO = { x: 100, y: 60, lado: 24 }; // dentro do bloco do logo

function pngComMargemTransparente(): Uint8Array<ArrayBuffer> {
  const { largura, altura } = { largura: 1536, altura: 1024 };
  const rgba = ruidoQuantizado(largura, altura, 0x1655);
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const dentro =
        x >= CAIXA_ESPERADA.x &&
        x < CAIXA_ESPERADA.x + CAIXA_ESPERADA.largura &&
        y >= CAIXA_ESPERADA.y &&
        y < CAIXA_ESPERADA.y + CAIXA_ESPERADA.altura;
      const i = (y * largura + x) * 4;
      const relX = x - CAIXA_ESPERADA.x;
      const relY = y - CAIXA_ESPERADA.y;
      if (!dentro) {
        rgba[i + 3] = 0; // borda: totalmente transparente, RGB sujo — é o que infla o arquivo
      } else if (relY >= LINHA_SEMITRANSPARENTE && relY < LINHA_SEMITRANSPARENTE + 8) {
        rgba[i + 3] = 128; // o logo tem meia-tinta que NÃO pode virar opaco no corte
      } else if (
        relX >= FURO.x &&
        relX < FURO.x + FURO.lado &&
        relY >= FURO.y &&
        relY < FURO.y + FURO.lado
      ) {
        rgba[i + 3] = 0; // um buraco no meio do logo: fica dentro da caixa e tem que sobreviver
      } else {
        rgba[i + 3] = 255;
      }
    }
  }
  return montarPng(largura, altura, rgba);
}

describe("ajustarLogo — cortar e reduzir ANTES de deixar o teto de 512 KB decidir", () => {
  it("arquivo dentro do teto passa reto: o MESMO File, sem acordar o motor", async () => {
    const motor = {
      inspecionar: vi.fn(motorDePngSintetico.inspecionar),
      reencodar: vi.fn(motorDePngSintetico.reencodar),
    };
    const dentro = arquivoDe("mini.png", montarPng(64, 64, ruidoQuantizado(64, 64, 7)));
    expect(dentro.size).toBeLessThan(LIMITE);

    const resultado = await ajustarLogo(dentro, motor);

    expect(resultado.arquivo).toBe(dentro);
    expect(resultado.ajustado).toBe(false);
    expect(resultado.recusar).toBe(false);
    expect(motor.inspecionar).not.toHaveBeenCalled();
    expect(motor.reencodar).not.toHaveBeenCalled();
  });

  it("PNG de 1536×1024 com o logo só no meio → recorta na caixa útil, cabe no teto e preserva o alfa", async () => {
    const original = arquivoDe("logo-do-designer.png", pngComMargemTransparente());
    expect(original.size, "o caso da issue: passa do teto ANTES do ajuste").toBeGreaterThan(LIMITE);

    const resultado = await ajustarLogo(original, motorDePngSintetico);

    expect(resultado.recusar).toBe(false);
    expect(resultado.ajustado).toBe(true);
    expect(resultado.arquivo).not.toBe(original);
    expect(resultado.arquivo.size).toBeLessThanOrEqual(LIMITE);

    const cortado = lerPng(new Uint8Array(await resultado.arquivo.arrayBuffer()));
    expect({ largura: cortado.largura, altura: cortado.altura }).toEqual({
      largura: CAIXA_ESPERADA.largura,
      altura: CAIXA_ESPERADA.altura,
    });

    // A transparência é o motivo de o PNG existir: borda cortada, alfa do meio intacto.
    const alfa = (x: number, y: number) => cortado.rgba[(y * cortado.largura + x) * 4 + 3];
    expect(alfa(FURO.x + 4, FURO.y + 4), "o buraco dentro do logo continua transparente").toBe(0);
    expect(alfa(4, LINHA_SEMITRANSPARENTE + 4), "a meia-tinta continua 128").toBe(128);
    expect(alfa(4, 0), "a borda do logo continua opaca").toBe(255);
  });

  it("quando o recorte não basta, reduz a largura até caber — e para no piso", async () => {
    // Sem margem para cortar (JPEG-like: alfa opaco em todo pixel), o ajuste só
    // tem a escada de larguras. Medido nesta árvore, com o PNG do helper:
    //   800×533 → 832.932 bytes (não cabe) · 640×427 → 534.154 (não cabe)
    //   512×341 → 341.661 bytes (cabe) — e 512 é o PISO da escada.
    const original = arquivoDe(
      "tela-cheia.png",
      montarPng(1536, 1024, opaco(ruidoQuantizado(1536, 1024, 0x1656))),
    );
    expect(original.size).toBeGreaterThan(LIMITE);

    const resultado = await ajustarLogo(original, motorDePngSintetico);

    expect(resultado.recusar).toBe(false);
    expect(resultado.ajustado).toBe(true);
    expect(resultado.arquivo.size).toBeLessThanOrEqual(LIMITE);

    const reduzido = lerPng(new Uint8Array(await resultado.arquivo.arrayBuffer()));
    expect({ largura: reduzido.largura, altura: reduzido.altura }).toEqual({
      largura: 512,
      altura: Math.round((1024 * 512) / 1536),
    });
    expect(reduzido.largura).toBeLessThanOrEqual(LARGURA_MAXIMA_DO_LOGO);
    expect(reduzido.largura).toBeGreaterThanOrEqual(LARGURA_MINIMA_DO_LOGO);
    // Proporção preservada — logo esticado é marca quebrada.
    expect(Math.abs(reduzido.largura / reduzido.altura - 1536 / 1024)).toBeLessThan(0.02);
  });

  it("quando nem no piso cabe, recusa em vez de subir: o teto continua de pé", async () => {
    const original = arquivoDe(
      "ruido-puro.png",
      montarPng(700, 700, opaco(ruidoPuro(700, 700, 0x1657))),
    );
    expect(original.size).toBeGreaterThan(LIMITE);

    const resultado = await ajustarLogo(original, motorDePngSintetico);

    expect(
      resultado.recusar,
      "sem isso o cliente submete um arquivo que o servidor vai rejeitar",
    ).toBe(true);
    expect(resultado.ajustado).toBe(false);
    // O que sobra para a recusa é o arquivo original, intocado.
    expect(resultado.arquivo).toBe(original);
    expect(resultado.arquivo.size).toBeGreaterThan(LIMITE);
  });

  it("sem decodificador no ambiente, manda o original e deixa o servidor decidir", async () => {
    // O jsdom da suíte não tem `createImageBitmap`; no navegador real este caminho
    // não existe, e é por isso que a falha dele não pode recusar upload nenhum.
    const original = arquivoDe("nao-decodificavel.png", ruidoPuro(1536, 1024, 0x1658));
    expect(original.size).toBeGreaterThan(LIMITE);

    const resultado = await ajustarLogo(original, lonaDoNavegador);

    expect(resultado.arquivo).toBe(original);
    expect(resultado.ajustado).toBe(false);
    expect(resultado.recusar, "ambiente sem canvas não é motivo de recusar na tela").toBe(false);
  });
});
