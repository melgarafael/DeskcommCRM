/**
 * O ícone LOCAL — quando o logo da instalação é um arquivo em `public/`, não
 * uma URL externa.
 *
 * ─── Por que `app/icon.tsx` ignora `logoUrl` por padrão ─────────────────────
 *
 * `platform_branding.logo_url` (e `APP_LOGO_URL` no `.env`) é texto livre, sem
 * CHECK de host. Buscá-lo no `<head>` de toda página seria uma requisição de
 * saída disparada por um campo que o operador digita — SSRF com gatilho em
 * cada carregamento de aba. É por isso que `app/icon.tsx` desenha cor + letra
 * em vez de desenhar o logo de verdade.
 *
 * ─── Por que um caminho RAIZ-RELATIVO é outra categoria ─────────────────────
 *
 * `/kora-icon.png` não é uma URL para buscar na rede: é um arquivo que o
 * próprio Next já serve de `public/`. Resolver isto é LER DISCO, não abrir
 * conexão — o vetor de SSRF (o servidor fazendo requisição para onde o
 * operador mandar) não existe aqui. Uma URL absoluta (`http://`, `https://`,
 * `//host/...`) continua CAINDO NO PADRÃO (cor + letra): esta função só aceita
 * a forma exata `/nome-do-arquivo.ext`, sem barra no meio — o que também
 * fecha travessia de diretório (`/../etc/passwd` não casa: `..` sozinho não é
 * um nome de arquivo válido pela forma abaixo, e não há segunda barra para
 * escapar de `public/`).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** As únicas extensões que este caminho aceita, e o `Content-Type` de cada uma. */
const CONTENT_TYPE_POR_EXTENSAO: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

/**
 * A FORMA exata de um caminho local aceitável: uma barra, um nome de arquivo
 * (letras, dígitos, ponto, hífen, underscore) e uma das extensões conhecidas.
 * Nenhuma segunda barra — é o que impede subir para fora de `public/` e o que
 * distingue isto de uma URL (`http://…`, `//host/…` têm barra a mais).
 */
const FORMA_DO_CAMINHO_LOCAL = /^\/[a-zA-Z0-9._-]+\.(png|jpe?g|ico)$/;

export type IconeLocal = {
  readonly bytes: Buffer;
  readonly contentType: string;
};

/**
 * Resolve `logoUrl` para um arquivo local, ou `null` quando não é o caso —
 * URL externa, forma que não bate, ou arquivo que não existe. Nunca lança:
 * mesma disciplina do resto de `lib/branding/*`, e o chamador (`app/icon.tsx`)
 * já sabe desenhar o padrão do produto quando isto devolve `null`.
 *
 * `publicDir` é parâmetro (e não lido de dentro) para o teste poder apontar
 * para um diretório de fixture sem tocar o `public/` real do repo.
 */
export function resolverIconeLocal(
  logoUrl: string | null | undefined,
  publicDir: string = path.join(process.cwd(), "public"),
): IconeLocal | null {
  const candidato = (logoUrl ?? "").trim();
  if (!FORMA_DO_CAMINHO_LOCAL.test(candidato)) return null;

  const extensao = path.extname(candidato).toLowerCase();
  const contentType = CONTENT_TYPE_POR_EXTENSAO[extensao];
  if (!contentType) return null;

  const caminhoNoDisco = path.join(publicDir, candidato.slice(1));
  if (!existsSync(caminhoNoDisco)) return null;

  try {
    return { bytes: readFileSync(caminhoNoDisco), contentType };
  } catch {
    return null;
  }
}
