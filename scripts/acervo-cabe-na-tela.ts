/**
 * O acervo de `.changes/` ainda cabe na tela da VPS?
 *
 * A seção que os fragmentos acumulados vão produzir tem o mesmo teto em bytes
 * que qualquer outra seção do CHANGELOG — o `head -c` do `agent.sh`. A
 * diferença é de QUEM é a dívida quando ela estoura: o acervo é coletivo, o 43º
 * fragmento não é mais culpado que o 1º, e o único remédio é cortar release.
 *
 * Por isso esta medição NÃO roda em `pull_request`. Ela rodava, dentro de
 * `tests/unit/changelog-cabe-na-tela-da-vps.test.ts`, e em 20/09/2026 reprovou
 * no `verify` — status check OBRIGATÓRIO — os PRs #1377 e #1363, nenhum dos
 * quais tocava `.changes/`, mandando os autores enxugarem fragmento de
 * terceiro. Aqui o vermelho é da `main`, e quem o vê é quem corta release.
 *
 * A régua é a MESMA de lá: `lib/release/cabe-na-tela.ts`. Este arquivo é casca
 * fina de I/O — `tsconfig.typecheck.json` exclui `scripts/**`, então lógica
 * aqui chegaria verde na `main` sem `tsc` nunca a ter olhado.
 *
 *   pnpm release:acervo-cabe
 */
import fs from "node:fs";
import path from "node:path";

import { candidataDoAcervo, medir, vereditoDoAcervo } from "../lib/release/cabe-na-tela";
import { type Fragmento, parseFragmento } from "../lib/release/fragmento";

const RAIZ = path.resolve(__dirname, "..");
const DIR_FRAGMENTOS = path.join(RAIZ, ".changes");

/**
 * Fragmento malformado é erro de quem o escreveu e reprova em
 * `tests/unit/fragmentos-de-release.test.ts` — aqui ele é pulado para a saída
 * não trocar "seção grande demais" por um erro de parse que confundiria o
 * conserto. O pulo é CONTADO e impresso: medição que descarta entrada em
 * silêncio subestima o acervo e sai verde por isso.
 */
function lerFragmentos(): { lidos: Fragmento[]; pulados: string[] } {
  if (!fs.existsSync(DIR_FRAGMENTOS)) return { lidos: [], pulados: [] };
  const lidos: Fragmento[] = [];
  const pulados: string[] = [];
  for (const arquivo of fs.readdirSync(DIR_FRAGMENTOS).filter((f) => f.endsWith(".md")).sort()) {
    try {
      lidos.push(parseFragmento(arquivo, fs.readFileSync(path.join(DIR_FRAGMENTOS, arquivo), "utf8")));
    } catch {
      pulados.push(arquivo);
    }
  }
  return { lidos, pulados };
}

function main(): number {
  const raw = fs.readFileSync(path.join(RAIZ, "CHANGELOG.md"), "utf8");
  const agentSh = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit", "agent.sh"), "utf8");

  const { lidos, pulados } = lerFragmentos();
  if (pulados.length > 0) {
    process.stdout.write(
      `::warning title=Fragmento ilegível ficou FORA da conta::${pulados.join(", ")} — o acervo medido está subestimado.\n`,
    );
  }

  const candidata = candidataDoAcervo(raw, lidos);
  if (candidata === null) {
    // Acervo vazio é o estado logo DEPOIS de uma release: não há seção nova a
    // medir, e dizer "ok" aqui seria afirmar sobre o que não existe.
    process.stdout.write("`.changes/` está vazio — nenhuma seção nova a medir (release recém-cortada).\n");
    return 0;
  }

  const m = medir(candidata, agentSh);
  const veredito = vereditoDoAcervo(m);
  const resumo =
    `${lidos.length} fragmento(s); a seção termina no byte ${m.fim} de ${m.teto} ` +
    `(folga ${m.folga} B, seção ${m.tamanhoDaSecao} B)`;

  if (veredito.reprova) {
    if (!m.cabe) {
      process.stdout.write(
        `::error title=O acervo de .changes/ não cabe mais na tela da VPS::${resumo}. ` +
          `O dono da VPS receberia o CHANGELOG cortado no meio.\n`,
      );
    }
    if (m.completa === false) {
      process.stdout.write(
        `::error title=O histórico não alcança a versão instalada::${resumo}. ` +
          `A tela do operador troca o histórico por "este histórico pode não alcançar a sua versão".\n`,
      );
    }
    if (m.avisoSobrevive === false) {
      process.stdout.write(
        `::error title=O aviso de ação manual fica fora do corte::${resumo}. ` +
          `O bloco "⚠️ Requer atenção" não apareceria para quem vai atualizar.\n`,
      );
    }
    process.stdout.write(
      "\nConserto: CORTAR RELEASE — `pnpm release:cortar`, que consome os fragmentos e esvazia `.changes/`.\n" +
        "Isto é dívida da casa, não de um PR: nenhum autor pode pagá-la enxugando fragmento de terceiro.\n" +
        "NÃO suba o `head -c` do agent.sh: quem corta é o script JÁ instalado na VPS do cliente — subir o\n" +
        "número aqui troca um vermelho honesto por um cliente sem aviso.\n",
    );
    return 1;
  }

  if (veredito.avisa) {
    process.stdout.write(
      `::warning title=O acervo de .changes/ passou da metade do que cabe::${resumo}. ` +
        `Outro ciclo do tamanho deste NÃO cabe — corte release (\`pnpm release:cortar\`) antes que a main fique vermelha.\n`,
    );
    return 0;
  }

  process.stdout.write(`OK — ${resumo}.\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (erro) {
    process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
    process.exit(1);
  }
}
