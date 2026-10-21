import { ImageResponse } from "next/og";

import { marcaEhADoProduto } from "@/lib/branding";
import { logger } from "@/lib/logger";

import { CORES_DA_MARCA, SIMBOLO } from "./desenho";
import { letraDoIcone } from "./icone";
import {
  baseDoStorage,
  caminhoBateComPrefixo,
  PREFIXO_DA_INSTALACAO,
  TAMANHO_MAXIMO_DO_LOGO,
  urlPublicaDoLogo,
} from "./logo";
import { farejarTipo } from "./logo-arquivo";
import { type MarcaDeSaida, NEUTROS_DE_SAIDA } from "./saida";

/** Só o arquivo da instalação: nunca uma URL livre nem o logo de uma organização. */
export async function lerArquivoDoIcone(
  caminho: string | null | undefined,
): Promise<string | null> {
  const base = baseDoStorage();
  if (!caminho || !base || !caminhoBateComPrefixo(caminho, PREFIXO_DA_INSTALACAO)) return null;
  try {
    const resposta = await fetch(urlPublicaDoLogo(caminho, base), {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!resposta.ok || !resposta.body) return null;
    const leitor = resposta.body.getReader();
    const partes: Uint8Array[] = [];
    let tamanho = 0;
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      tamanho += value.byteLength;
      if (tamanho > TAMANHO_MAXIMO_DO_LOGO) {
        await leitor.cancel();
        return null;
      }
      partes.push(value);
    }
    const bytes = Buffer.concat(partes);
    const tipo = farejarTipo(bytes);
    return tipo ? `data:${tipo};base64,${bytes.toString("base64")}` : null;
  } catch {
    logger.warn("marca: arquivo do ícone indisponível; usando o desenho da instalação");
    return null;
  }
}

/**
 * Um PNG por tamanho do app. Sem arquivo válido, preserva símbolo ou cor + inicial.
 *
 * `conteudo` é a fração do lado que o DESENHO ocupa; o fundo opaco ocupa sempre
 * o lado inteiro. Abaixo de 1 é para quem recorta o ícone: o iPhone arredonda
 * os cantos, e o Android (ícone `maskable`) recorta num círculo de 80% do lado.
 */
export async function gerarIconeDoApp(
  lado: 180 | 192 | 512,
  marca: MarcaDeSaida,
  arquivo: string | null,
  conteudo = 1,
): Promise<ArrayBuffer> {
  const caixa = Math.round(lado * conteudo);
  const desenhar = (imagem: string | null) => {
    const produto = marcaEhADoProduto({ name: marca.nome, logoUrl: marca.logoUrl });
    return new ImageResponse(
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: imagem || produto ? NEUTROS_DE_SAIDA.fundo : marca.accent,
          color: marca.accentFg,
          fontSize: Math.round(caixa * 0.62),
        }}
      >
        {imagem ? (
          // O src é data: gerado de bytes limitados do Storage da instalação.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imagem} alt="" width={caixa} height={caixa} style={{ objectFit: "contain" }} />
        ) : produto ? (
          <svg
            viewBox={SIMBOLO.viewBox}
            width={Math.round(caixa * 0.78)}
            height={Math.round(caixa * 0.78)}
          >
            <g fill={CORES_DA_MARCA.claro.simbolo} transform={SIMBOLO.transform}>
              <path d={SIMBOLO.d} />
              <rect {...SIMBOLO.modulo} />
            </g>
          </svg>
        ) : (
          (letraDoIcone(marca.nome) ?? "")
        )}
      </div>,
      { width: lado, height: lado },
    ).arrayBuffer();
  };
  try {
    return await desenhar(arquivo);
  } catch (erro) {
    if (!arquivo) throw erro;
    logger.warn("marca: não foi possível desenhar o arquivo do ícone; usando a inicial");
    return desenhar(null);
  }
}
