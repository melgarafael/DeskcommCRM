/**
 * A MEDIÇÃO das frases das telas principais — o que a régua
 * (`lib/i18n/telas-principais.ts`) confere.
 *
 * ─── Por que a conta mora aqui, e não no teste ─────────────────────────────
 *
 * A régua tem de medir a MESMA coisa para o idioma real e para o idioma
 * fictício das duas caras do gate. Duas cópias da varredura divergem sem
 * avisar, e a que ficasse mais frouxa aprovaria um catálogo que a outra recusa.
 *
 * ─── Como uma frase é atribuída a uma tela ─────────────────────────────────
 *
 * A pasta da rota sozinha MENTE: `app/app/inbox/page.tsx` só tem duas frases
 * porque o Inbox inteiro mora em `@/components/inbox/InboxLayout`. Medido na
 * primeira tentativa desta fatia: 2 frases para a tela mais usada do produto.
 * Então a tela é o FECHO DE IMPORTS da pasta da rota — os módulos que ela
 * alcança, com as fronteiras que impedem a conta de virar ficção:
 *
 *   - outra `page.tsx`/`layout.tsx` é outra tela, não esta (para de andar);
 *   - `app/api/**` não renderiza tela;
 *   - `node_modules` e `.json` ficam fora (o caminho do import é resolvido
 *     contra a árvore do repositório, então um catálogo não entra na conta).
 *
 * O fecho superestima de propósito: componente compartilhado entre duas telas
 * conta nas duas, porque quem lê a segunda tela também vê o texto dele.
 *
 * ─── Uma varredura só ─────────────────────────────────────────────────────
 *
 * `varrerChavesDeI18n` roda sobre as áreas de produto INTEIRAS, uma vez; cada
 * rota filtra os locais pelo seu fecho. Varrer o fecho arquivo a arquivo daria a
 * mesma resposta multiplicando o custo por dezesseis.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { AREAS_DE_PRODUTO, varrerChavesDeI18n } from "./chave-dinamica";
import { arquivosDeCodigo, caminhoRelativo } from "./varrer-codigo";

/** A raiz do repositório — o vitest roda com cwd nela (ver `varrer-codigo.ts`). */
const RAIZ = join(__dirname, "..", "..", "..");

const IMPORTACAO = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** O caminho absoluto de um módulo importado, ou `null` se não for fonte deste repo. */
function resolverDe(especificador: string, deArquivo: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = join(RAIZ, especificador.slice(2));
  else if (especificador.startsWith(".")) base = join(deArquivo, "..", especificador);
  else return null;
  for (const tentativa of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(tentativa).isFile() && /\.tsx?$/.test(tentativa)) return tentativa;
    } catch {
      // caminho que não existe — o import aponta para outra coisa
    }
  }
  return null;
}

/** O fecho de imports de uma pasta de rota, em caminho relativo à raiz. */
export function fechoDeImports(dirDaRota: string): Set<string> {
  const raizDaRota = join(RAIZ, dirDaRota);
  const vistos = new Set<string>();
  const fila = arquivosDeCodigo([dirDaRota]);
  while (fila.length > 0) {
    const arquivo = fila.pop();
    if (!arquivo || vistos.has(arquivo)) continue;
    vistos.add(arquivo);
    let fonte: string;
    try {
      fonte = readFileSync(arquivo, "utf8");
    } catch {
      continue;
    }
    for (const [, especificador = ""] of fonte.matchAll(IMPORTACAO)) {
      const alvo = resolverDe(especificador, arquivo);
      if (!alvo || vistos.has(alvo)) continue;
      const rel = caminhoRelativo(alvo);
      if (rel.startsWith("app/api/")) continue;
      if (/\.(test|spec)\.tsx?$/.test(rel)) continue;
      // A página ou o layout de OUTRA rota é outra tela: parar aqui é o que
      // impede o fecho de uma tela de engolir o produto inteiro.
      if (/^app\/.*(page|layout)\.tsx$/.test(rel) && !alvo.startsWith(`${raizDaRota}/`)) continue;
      fila.push(alvo);
    }
  }
  return new Set([...vistos].map((arquivo) => caminhoRelativo(arquivo)));
}

export interface MedicaoDasTelasPrincipais {
  /** As frases distintas que as telas principais alcançam. */
  readonly frases: ReadonlySet<string>;
  /** Por rota: quantas frases ela alcança e quantos arquivos entraram no fecho. */
  readonly porTela: ReadonlyMap<string, { readonly frases: number; readonly arquivos: number }>;
  /** Arquivos que a varredura de chaves leu — controle de não-vacuidade. */
  readonly arquivosVarridos: number;
}

/**
 * Mede, em UMA passada, as frases de cada tela principal.
 *
 * `hrefs` vem de `TELAS_PRINCIPAIS` (o registro de navegação) e é resolvido
 * como `app` + href — a convenção deste App Router, onde `/app/inbox` mora em
 * `app/app/inbox`.
 */
export function medirFrasesDasTelasPrincipais(
  hrefs: readonly string[],
): MedicaoDasTelasPrincipais {
  const varredura = varrerChavesDeI18n(AREAS_DE_PRODUTO);
  const frases = new Set<string>();
  const porTela = new Map<string, { frases: number; arquivos: number }>();
  for (const href of hrefs) {
    const fecho = fechoDeImports(`app${href}`);
    const daTela = new Set<string>();
    for (const [chave, locais] of varredura.chaves) {
      if (locais.some((local) => fecho.has(local.slice(0, local.lastIndexOf(":"))))) daTela.add(chave);
    }
    for (const chave of daTela) frases.add(chave);
    porTela.set(href, { frases: daTela.size, arquivos: fecho.size });
  }
  return { frases, porTela, arquivosVarridos: varredura.arquivosVarridos };
}

export interface CoberturaMedida {
  readonly traduzidas: number;
  readonly total: number;
  /** As frases que o catálogo não tem — a mensagem de falha aponta as primeiras. */
  readonly faltando: readonly string[];
}

/**
 * Quanto do que as telas principais dizem o catálogo já traduz.
 *
 * `entradas` é o catálogo do idioma (`lib/i18n/traducoes/<codigo>.json`, lido
 * como dado — NUNCA importado, para não entrar no programa do TypeScript: foi
 * exatamente um `import` de 1,61 MB que derrubou o `next build` no #4721).
 */
export function coberturaDoCatalogo(
  entradas: Readonly<Record<string, string>>,
  frases: ReadonlySet<string>,
): CoberturaMedida {
  const faltando: string[] = [];
  let traduzidas = 0;
  for (const frase of frases) {
    if (entradas[frase] !== undefined) traduzidas += 1;
    else faltando.push(frase);
  }
  return { traduzidas, total: frases.size, faltando: faltando.sort() };
}
