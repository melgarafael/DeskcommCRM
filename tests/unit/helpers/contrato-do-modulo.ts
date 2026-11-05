/**
 * Deriva, SÓ LENDO ARQUIVOS, o contrato que um módulo conectado enxerga (Spec 33, F6):
 * o conjunto de áreas, as permissões de área, as rotas liberadas por área e o que se consegue ler
 * sobre o formato de entrada e de saída. Sem banco, sem rede, sem executar rota.
 *
 * Este arquivo não importa nenhum módulo do repositório: a função de área e o vocabulário entram por
 * parâmetro. Assim o teste (`tests/unit/modulo-contrato-congelado.test.ts`) e a regeneração usam
 * exatamente o mesmo código.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const METODOS_DE_ROTA = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface EntradaDeFormato {
  /** Schema Zod que a rota passa a `.parse`/`.safeParse`/`.parseAsync`/`.safeParseAsync`. */
  corpo: { nome: string; origem: string; hash: string }[];
  /** Schemas citados na rota cujo nome diz que são de resposta (`*Response*Schema`, `*Output*Schema`). */
  resposta: string[];
}

export interface Contrato {
  host_api_version: number;
  areas: string[];
  permissoes: string[];
  /** Área → lista ordenada de `MÉTODO /api/v1/modelo`. */
  rotas: Record<string, string[]>;
  /** Modelo de rota (só os que têm método liberado a módulo) → o que se leu do formato. */
  formatos: Record<string, EntradaDeFormato>;
}

export interface Dependencias {
  raiz: string;
  hostApiVersion: number;
  areas: readonly string[];
  permissaoDaArea: (area: string, modo: string) => string;
  areaDaPorta: (modelo: string, metodo: string) => { area: string; modo: string } | null;
}

function arquivosDeRota(pasta: string, saida: string[] = []): string[] {
  for (const d of readdirSync(pasta, { withFileTypes: true })) {
    const abs = join(pasta, d.name);
    if (d.isDirectory()) arquivosDeRota(abs, saida);
    else if (d.name === "route.ts") saida.push(abs);
  }
  return saida;
}

/** `app/api/v1/pipelines/[pipelineId]/stages/route.ts` → `/api/v1/pipelines/[id]/stages`. */
export function modeloDaRota(raiz: string, arquivo: string): string {
  const rel = relative(join(raiz, "app"), arquivo).split(sep).join("/");
  const partes = rel
    .replace(/\/route\.ts$/, "")
    .split("/")
    .filter((p) => !/^\(.+\)$/.test(p)) // grupo de rotas não entra no caminho
    .map((p) => (/^\[\.\.\..+\]$/.test(p) || /^\[.+\]$/.test(p) ? "[id]" : p));
  return `/${partes.join("/")}`;
}

export function semComentarios(texto: string): string {
  return texto
    .replace(/\r\n?/g, "\n") // o mesmo resultado em CRLF (Windows) e LF (CI)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

export function metodosExportados(codigo: string): string[] {
  const achados = new Set<string>();
  for (const m of codigo.matchAll(/export\s+(?:async\s+)?function\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\b/g)) {
    achados.add(m[1]!);
  }
  for (const m of codigo.matchAll(/export\s+const\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\b/g)) {
    achados.add(m[1]!);
  }
  for (const m of codigo.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const parte of (m[1] ?? "").split(",")) {
      const nome = parte.split(/\s+as\s+/).pop()?.trim() ?? "";
      if ((METODOS_DE_ROTA as readonly string[]).includes(nome)) achados.add(nome);
    }
  }
  return [...achados].sort();
}

function hashDoTexto(texto: string): string {
  const normal = semComentarios(texto).replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normal).digest("hex").slice(0, 16);
}

/** O texto de `const NOME = ...;` (com chaves, colchetes e parênteses balanceados), ou `null`. */
function definicaoDe(codigo: string, nome: string): string | null {
  const inicio = new RegExp(`(?:export\\s+)?const\\s+${nome}\\b[^=]*=`).exec(codigo);
  if (!inicio) return null;
  let i = inicio.index + inicio[0].length;
  let prof = 0;
  let aspas: string | null = null;
  const comeco = i;
  for (; i < codigo.length; i++) {
    const c = codigo[i]!;
    if (aspas) {
      if (c === "\\") i++;
      else if (c === aspas) aspas = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") aspas = c;
    else if ("([{".includes(c)) prof++;
    else if (")]}".includes(c)) prof--;
    else if (c === ";" && prof <= 0) break;
    else if (c === "\n" && prof <= 0) {
      // fim de instrução sem ponto e vírgula: a próxima linha não continua a expressão
      const resto = codigo.slice(i + 1).trimStart();
      if (!/^[.?:|&+\-*/]/.test(resto)) break;
    }
  }
  return codigo.slice(comeco, i);
}

function resolverImportacao(raiz: string, de: string, origem: string): string | null {
  const base = origem.startsWith("@/") ? join(raiz, origem.slice(2)) : origem.startsWith(".") ? join(de, "..", origem) : null;
  if (!base) return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** A definição de `nome` em `arquivo`, seguindo `export * from` e `export { nome } from` até 3 níveis. */
function buscarDefinicao(raiz: string, arquivo: string, nome: string, nivel: number): string | null {
  const texto = semComentarios(readFileSync(arquivo, "utf8"));
  const direta = definicaoDe(texto, nome);
  if (direta !== null || nivel >= 3) return direta;
  const reexports = [
    ...texto.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g),
    ...[...texto.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
      .filter((m) => new RegExp(`\\b${nome}\\b`).test(m[1] ?? ""))
      .map((m) => [m[0], m[2]] as unknown as RegExpMatchArray),
  ];
  for (const r of reexports) {
    const alvo = resolverImportacao(raiz, arquivo, r[1] ?? "");
    if (!alvo) continue;
    const achada = buscarDefinicao(raiz, alvo, nome, nivel + 1);
    if (achada !== null) return achada;
  }
  return null;
}

function formatoDaRota(raiz: string, arquivo: string, codigo: string): EntradaDeFormato {
  const nomes = new Set<string>();
  for (const m of codigo.matchAll(/\b([A-Za-z0-9_]+)\s*\.\s*(?:safeParseAsync|parseAsync|safeParse|parse)\s*\(/g)) {
    const nome = m[1]!;
    if (/schema$/i.test(nome)) nomes.add(nome);
  }
  const corpo: EntradaDeFormato["corpo"] = [];
  for (const nome of [...nomes].sort()) {
    const local = definicaoDe(codigo, nome);
    if (local !== null) {
      corpo.push({ nome, origem: "local", hash: hashDoTexto(local) });
      continue;
    }
    const imp = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${nome}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`).exec(codigo);
    const origem = imp?.[1] ?? "desconhecida";
    const alvo = imp ? resolverImportacao(raiz, arquivo, origem) : null;
    const def = alvo ? buscarDefinicao(raiz, alvo, nome, 0) : null;
    corpo.push({ nome, origem, hash: def !== null ? hashDoTexto(def) : "nao-resolvido" });
  }
  const resposta = [
    ...new Set(
      [...codigo.matchAll(/\b([A-Za-z0-9_]*(?:Response|Output|Result)[A-Za-z0-9_]*Schema)\b/g)].map((m) => m[1]!),
    ),
  ].sort();
  return { corpo, resposta };
}

export function derivarContrato(d: Dependencias): Contrato {
  const permissoes = d.areas
    .flatMap((a) => [d.permissaoDaArea(a, "leitura"), d.permissaoDaArea(a, "escrita")])
    .sort();
  const rotas: Record<string, string[]> = Object.fromEntries([...d.areas].sort().map((a) => [a, [] as string[]]));
  const formatos: Record<string, EntradaDeFormato> = {};

  const arquivos = arquivosDeRota(join(d.raiz, "app", "api", "v1")).sort();
  for (const arquivo of arquivos) {
    const codigo = semComentarios(readFileSync(arquivo, "utf8"));
    const modelo = modeloDaRota(d.raiz, arquivo);
    let liberada = false;
    for (const metodo of metodosExportados(codigo)) {
      const porta = d.areaDaPorta(modelo, metodo);
      if (!porta) continue;
      liberada = true;
      (rotas[porta.area] ??= []).push(`${metodo} ${modelo}`);
    }
    if (liberada) {
      const f = formatoDaRota(d.raiz, arquivo, codigo);
      if (f.corpo.length > 0 || f.resposta.length > 0) formatos[modelo] = f;
    }
  }
  for (const a of Object.keys(rotas)) rotas[a] = [...new Set(rotas[a]!)].sort();
  const formatosOrdenados = Object.fromEntries(Object.entries(formatos).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return {
    host_api_version: d.hostApiVersion,
    areas: [...d.areas],
    permissoes,
    rotas,
    formatos: formatosOrdenados,
  };
}

export interface Diferencas {
  /** Mudanças que um módulo já escrito pode sentir: exigem subir `host_api`. */
  quebras: string[];
  /** Acréscimos: não quebram quem já existe, mas o instantâneo precisa ser regenerado. */
  acrescimos: string[];
}

export function compararContratos(antes: Contrato, agora: Contrato): Diferencas {
  const quebras: string[] = [];
  const acrescimos: string[] = [];
  const lista = (rotulo: string, a: readonly string[], b: readonly string[], ordenada: boolean) => {
    const q0 = quebras.length;
    const a0 = acrescimos.length;
    for (const x of a) if (!b.includes(x)) quebras.push(`${rotulo}: saiu ou foi renomeado "${x}"`);
    for (const x of b) if (!a.includes(x)) acrescimos.push(`${rotulo}: novo "${x}"`);
    if (ordenada && quebras.length === q0 && acrescimos.length === a0 && a.join("|") !== b.join("|")) {
      quebras.push(`${rotulo}: a ordem mudou`);
    }
  };
  lista("áreas", antes.areas, agora.areas, true);
  lista("permissões de área", antes.permissoes, agora.permissoes, false);
  for (const area of new Set([...Object.keys(antes.rotas), ...Object.keys(agora.rotas)])) {
    lista(`rotas da área ${area}`, antes.rotas[area] ?? [], agora.rotas[area] ?? [], false);
  }
  for (const modelo of new Set([...Object.keys(antes.formatos), ...Object.keys(agora.formatos)])) {
    const a = antes.formatos[modelo];
    const b = agora.formatos[modelo];
    if (a && !b) {
      quebras.push(`formato de ${modelo}: deixou de declarar schema`);
      continue;
    }
    if (!a && b) {
      acrescimos.push(`formato de ${modelo}: passou a declarar schema`);
      continue;
    }
    if (!a || !b) continue;
    for (const c of a.corpo) {
      const novo = b.corpo.find((x) => x.nome === c.nome);
      if (!novo) quebras.push(`formato de ${modelo}: o schema de corpo "${c.nome}" saiu`);
      else if (novo.hash !== c.hash) quebras.push(`formato de ${modelo}: o schema de corpo "${c.nome}" mudou`);
    }
    for (const c of b.corpo) {
      if (!a.corpo.some((x) => x.nome === c.nome)) acrescimos.push(`formato de ${modelo}: novo schema de corpo "${c.nome}"`);
    }
    for (const r of a.resposta) if (!b.resposta.includes(r)) quebras.push(`formato de ${modelo}: o schema de resposta "${r}" saiu`);
    for (const r of b.resposta) if (!a.resposta.includes(r)) acrescimos.push(`formato de ${modelo}: novo schema de resposta "${r}"`);
  }
  return { quebras, acrescimos };
}
