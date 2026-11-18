import { existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";

/**
 * O PATH do preparo do e2e: symlink SÓ dos binários que os passos usam.
 *
 * O motivo (issue #3827): a fixture montava `${bin}:/usr/bin:/bin` e herdava a
 * máquina inteira. O passo `Instalar o ffmpeg e sondar os encoders` começa com
 * `if ! command -v ffmpeg >/dev/null; then`: numa máquina com `ffmpeg` no
 * `/usr/bin` o `if` dava falso, o laço de tentativas não rodava, o `timeout`
 * falso nunca era chamado e o `chamadas.log` que ele criaria não existia — daí
 * `ENOENT` na leitura da fixture. A cerca media a máquina de quem roda, não o
 * repositório (no CI passava só porque a imagem do runner não traz `ffmpeg`).
 *
 * Aqui o PATH de sistema é um diretório de symlinks com os utilitários que o
 * passo e o `scripts/ci/apt-e2e-failover.sh` realmente chamam. `ffmpeg`, `jq`,
 * `pnpm` e o resto NÃO entram: quem responde por eles é o dublê da fixture, que
 * é justamente o que os testes afirmam. Qualquer `command -v` do passo passa a
 * depender do roteiro, nunca do que está instalado na máquina.
 *
 * A lista é curta de propósito e NÃO é tolerante: se um passo passar a chamar
 * um binário novo, a fixture quebra com o nome faltando — em vez de voltar a
 * herdar a máquina em silêncio.
 */
const DO_SISTEMA = [
  // O passo roda em `bash -e`; os dublês da fixture têm `#!/bin/sh`.
  "bash",
  "sh",
  "env",
  // O `apt-get` dublê é Python (`#!/usr/bin/env python3`), como o `sudo` dublê.
  "python3",
  // `log="$(mktemp)"`, `mkdir -p "$debs/partial"`, `tee "$log"`, o `trap` de rm.
  "mktemp",
  "mkdir",
  "rm",
  "tee",
  // `grep` são as fatias do failover; `sed` e `head` são o roteiro do `timeout`.
  "grep",
  "sed",
  "head",
  "chmod",
] as const;

// De onde saem os symlinks. Os mesmos caminhos que `env -i sh -c` acha num
// runner Ubuntu — e nada além deles (`/usr/local/bin` não entra: é onde a
// máquina de quem roda instala o que não faz parte do repositório).
const ORIGENS = ["/usr/bin", "/bin"];

/** Caminho absoluto do binário no sistema, ou `null` se a máquina não o tem. */
function achar(nome: string): string | null {
  for (const origem of ORIGENS) {
    const candidato = path.join(origem, nome);
    if (existsSync(candidato) && statSync(candidato).isFile()) return candidato;
  }
  return null;
}

/**
 * Monta `destino` com um symlink por binário do sistema permitido e devolve o
 * diretório, pronto para entrar no PATH antes (ou depois) do diretório dos
 * dublês. Falha alto, listando o que faltou: um PATH incompleto não pode virar
 * "o teste passou por outro motivo".
 */
export function binariosDoSistema(destino: string): string {
  mkdirSync(destino, { recursive: true });
  const faltando: string[] = [];
  for (const nome of DO_SISTEMA) {
    const origem = achar(nome);
    if (!origem) {
      faltando.push(nome);
      continue;
    }
    symlinkSync(origem, path.join(destino, nome));
  }
  if (faltando.length > 0) {
    throw new Error(
      `a fixture do preparo do e2e precisa de ${faltando.join(", ")} em ${ORIGENS.join(" ou ")}; ` +
        "sem eles o PATH hermético não reproduz o runner",
    );
  }
  return destino;
}

/** Os nomes que o PATH hermético expõe — para o teste afirmar o que ficou de fora. */
export const BINARIOS_DO_SISTEMA: readonly string[] = DO_SISTEMA;
