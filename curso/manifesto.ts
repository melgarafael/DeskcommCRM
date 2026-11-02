/** Escrita comum às lições e jornadas: foto antiga não prova recaptura. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Captura } from "./capturar";

export type Manifesto = {
  largura: number;
  altura: number;
  capturas: Record<string, Captura>;
  falhas?: string[];
  idioma?: Captura["idioma"];
  commit_fonte?: string;
  versao?: string;
  gerado_em?: string;
};

/** Invalida o recorte antes de conectar à bancada; libera só cada foto concluída.
 * Metadados vêm da captura real, nunca de git ou de um default ao abrir o arquivo.
 */
export function abrirManifestoDaRodada(arquivo: string, chaves: string[]) {
  let manifesto: Manifesto = existsSync(arquivo)
    ? JSON.parse(readFileSync(arquivo, "utf8"))
    : { largura: 1440, altura: 900, capturas: {} };
  const salvar = (estado: Manifesto) => {
    const temporario = path.join(
      path.dirname(arquivo),
      `.${path.basename(arquivo)}.${process.pid}.tmp`,
    );
    writeFileSync(temporario, JSON.stringify(estado, null, 2));
    renameSync(temporario, arquivo);
  };
  manifesto.falhas = [...(manifesto.falhas ?? [])];
  for (const chave of chaves) if (!manifesto.falhas.includes(chave)) manifesto.falhas.push(chave);
  salvar(manifesto);
  return async (chave: string, fotografar: () => Promise<Captura>) => {
    const captura = await fotografar(); // Falha na medição, JPEG ou metadados conserva a pendência.
    const proximo = { ...manifesto, capturas: { ...manifesto.capturas, [chave]: captura } };
    if (captura.idioma !== undefined) proximo.idioma = captura.idioma;
    if (captura.commit_fonte !== undefined) proximo.commit_fonte = captura.commit_fonte;
    if (captura.versao !== undefined) proximo.versao = captura.versao;
    proximo.gerado_em = captura.capturado_em ?? new Date().toISOString();
    // Falhas de lições, revogações e outros recortes continuam bloqueando sua montagem.
    proximo.falhas = manifesto.falhas!.filter((falha) => falha !== chave);
    salvar(proximo);
    manifesto = proximo;
  };
}
