/** CLI sem acesso à bancada: publica somente o plano, nunca credenciais ou conteúdo de arquivos. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planejarAtualizacao, type IdiomaDoPlano } from "./atualizacao";

const AJUDA = `Planeja a manutenção do curso entre commits, sem abrir o app ou segredos.

Uso: pnpm exec tsx curso/planejar-atualizacao.ts [opções]
  --head <ref>           Commit a ensinar (padrão: HEAD).
  --base <ref>           Base informada; exige revisão IA e não comprova publicação.
  --idioma <pt-BR|es>    Pode repetir; o padrão inclui os dois idiomas.
  --saida <arquivo>     Grava o mesmo JSON público exibido na saída padrão.
  --help                Mostra esta ajuda.

Sem --base, lê curso/publicacao.json versionado no head. Sem registro válido
e ancestral, seleciona rodada completa. Alterações locais não entram no diff.
`;

try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(AJUDA);
  } else {
    let head: string | undefined;
    let base: string | undefined;
    let saida: string | undefined;
    const idiomas: IdiomaDoPlano[] = [];
    for (let i = 0; i < args.length; i++) {
      const chave = args[i];
      if (!["--head", "--base", "--idioma", "--saida"].includes(chave!)) throw new Error("opção desconhecida; use --help");
      const valor = args[++i];
      if (!valor || valor.startsWith("--")) throw new Error("opção sem valor; use --help");
      if (chave === "--head") head = valor;
      if (chave === "--base") base = valor;
      if (chave === "--saida") saida = valor;
      if (chave === "--idioma") {
        if (valor !== "pt-BR" && valor !== "es") throw new Error("idioma inválido; use pt-BR ou es");
        idiomas.push(valor);
      }
    }
    const plano = planejarAtualizacao({ repositorio: process.cwd(), head, base, idiomas: idiomas.length ? idiomas : undefined });
    const json = `${JSON.stringify(plano, null, 2)}\n`;
    if (saida) {
      mkdirSync(path.dirname(path.resolve(saida)), { recursive: true });
      writeFileSync(saida, json);
    }
    process.stdout.write(json);
  }
} catch (erro) {
  process.stderr.write(`${erro instanceof Error ? erro.message : "falha ao planejar a atualização"}\n`);
  process.exitCode = 1;
}
