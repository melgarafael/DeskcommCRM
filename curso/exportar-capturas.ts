/** Prepara artefatos para o PR do site. Não faz commit, push, deploy nem altera o HTML PT. */
import { exportarCapturas } from "./exportacao";

const AJUDA = `Exporta o conjunto completo de capturas reais ES para um clone local do site.

Uso: pnpm exec tsx curso/exportar-capturas.ts --idioma es --saida <pasta> --site <clone>
  --idioma es          Idioma suportado pelo manifesto do site.
  --saida <pasta>      Origem com capturas.json e capturas/<id>.jpg.
  --site <clone>       Clone local do deskcomm-site, com o catálogo PT sincronizado.
  --help              Mostra esta ajuda sem abrir arquivos.

Exige conjunto completo sem falhas, procedência e JPEGs regulares. Preserva as
medidas e os metadados de cada foto, inclusive commits anteriores comprovados.
Prepara stage e restaura o destino se a troca falhar. Não publica nem toca no HTML PT.
`;

try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) process.stdout.write(AJUDA);
  else {
    const valores: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const chave = args[i];
      if (!["--idioma", "--saida", "--site"].includes(chave!)) throw new Error("opção desconhecida; use --help");
      const valor = args[++i];
      if (!valor || valor.startsWith("--") || valores[chave!]) throw new Error("opção ausente ou repetida; use --help");
      valores[chave!] = valor;
    }
    if (valores["--idioma"] !== "es") throw new Error("informe --idioma es; o curso PT canônico não é alterado");
    if (!valores["--saida"] || !valores["--site"]) throw new Error("informe --saida e --site; use --help");
    const resultado = exportarCapturas({ idioma: "es", saida: valores["--saida"], site: valores["--site"] });
    process.stdout.write(`${JSON.stringify(resultado, null, 2)}\n`);
  }
} catch (erro) {
  process.stderr.write(`${erro instanceof Error ? erro.message : "falha ao exportar as capturas"}\n`);
  process.exitCode = 1;
}
