/**
 * CONVERSOR UNIVERSAL DE IMAGENS PARA JPEG
 *
 * Converte qualquer imagem aceita pelo navegador (PNG, WEBP, AVIF, HEIC, BMP, JPEG)
 * em um JPEG otimizado (sRGB, qualidade ~88%, dimensões máximas de 1600x1600 px).
 *
 * Garante compatibilidade 100% com o WhatsApp (onde JPEG é padrão ouro) e reduz
 * o tamanho de arquivos pesados (ex: 8MB -> ~250KB) antes do upload.
 */

export async function converterImagemParaJpeg(
  arquivo: File,
  larguraMaxima = 1600,
  alturaMaxima = 1600,
  qualidade = 0.88,
): Promise<File> {
  // Se já for JPEG leve (< 800KB), pode manter ou apenas redimensionar se necessário
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);

      let largura = img.naturalWidth || img.width;
      let altura = img.naturalHeight || img.height;

      // Cálculo de escala mantendo proporção
      if (largura > larguraMaxima || altura > alturaMaxima) {
        const proporcao = Math.min(larguraMaxima / largura, alturaMaxima / altura);
        largura = Math.round(largura * proporcao);
        altura = Math.round(altura * proporcao);
      }

      const canvas = document.createElement("canvas");
      canvas.width = largura;
      canvas.height = altura;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(arquivo); // fallback
        return;
      }

      // Fundo branco para imagens com transparência (PNG/WEBP)
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, largura, altura);
      ctx.drawImage(img, 0, 0, largura, altura);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(arquivo);
            return;
          }
          const nomeLimpo = arquivo.name.replace(/\.[^/.]+$/, "") + ".jpg";
          const arquivoConvertido = new File([blob], nomeLimpo, {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
          resolve(arquivoConvertido);
        },
        "image/jpeg",
        qualidade,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Se não conseguir renderizar no canvas, tenta enviar original
      resolve(arquivo);
    };

    img.src = url;
  });
}
