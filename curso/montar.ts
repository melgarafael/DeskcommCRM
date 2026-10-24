/**
 * Monta o site do curso (curso/saida/index.html) a partir das lições, das
 * capturas medidas e do menu REAL do produto.
 *
 *   pnpm exec tsx curso/montar.ts
 *
 * Por padrão sai o corpo da página (o Artifact do claude.ai põe o esqueleto).
 * Para servir de um site — deskcomm.com.br/curso —, CURSO_BASE="/curso/" prefixa
 * o caminho das fotos e o arquivo sai como documento HTML completo.
 *
 * O menu lateral do curso é projetado de lib/navigation/catalogo.ts — o mesmo
 * array que desenha o sidebar do app —, então o aluno navega pelos mesmos
 * grupos e nomes que vai encontrar no sistema, e tela nova do produto aparece
 * no curso (como "em breve") sem ninguém lembrar de acrescentá-la.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { NAV_CATALOG, NAV_GROUPS } from "../lib/navigation/catalogo";
import { Modulo, chaveDoPasso } from "./licao";

const RAIZ = path.dirname(new URL(import.meta.url).pathname);
const SAIDA = path.join(RAIZ, "saida");
const ler = (f: string) => readFileSync(path.join(RAIZ, f), "utf8");

// `montar.ts inbox radar` monta só esses; sem argumento, todos
const soEstes = process.argv.slice(2);
const modulos = readdirSync(path.join(RAIZ, "licoes"))
  .filter((f) => f.endsWith(".json") && (soEstes.length === 0 || soEstes.includes(f.replace(/\.json$/, ""))))
  .map((f) => Modulo.parse(JSON.parse(ler(path.join("licoes", f)))))
  // ordem do menu do produto, para o curso seguir a ordem da tela
  .sort((a, b) => NAV_CATALOG.findIndex((d) => d.href === a.tela) - NAV_CATALOG.findIndex((d) => d.href === b.tela));

const telas = new Set<string>(NAV_CATALOG.map((d) => d.href));
for (const m of modulos) {
  if (!telas.has(m.tela)) throw new Error(`módulo ${m.id}: a tela ${m.tela} não existe em lib/navigation/catalogo.ts`);
}

const arquivoCapturas = path.join(SAIDA, "capturas.json");
if (!existsSync(arquivoCapturas)) throw new Error("falta curso/saida/capturas.json — rode curso/capturar.ts antes");
const { largura, altura, capturas } = JSON.parse(readFileSync(arquivoCapturas, "utf8"));

const faltando = modulos.flatMap((m) =>
  m.licoes.flatMap((l) => l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id)).filter((k) => !capturas[k])),
);
if (faltando.length) throw new Error(`passos sem foto (o capturar falhou neles?): ${faltando.join(", ")}`);

const menu = NAV_GROUPS.map((g) => ({
  grupo: g.label,
  itens: NAV_CATALOG.filter((d) => d.group === g.id && ("sidebar" in d && d.sidebar || modulos.some((m) => m.tela === d.href))).map((d) => ({
    href: d.href,
    rotulo: d.label,
    descricao: d.description,
    modulo: modulos.find((m) => m.tela === d.href)?.id ?? null,
  })),
})).filter((g) => g.itens.length);

const versao = (() => {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: RAIZ, encoding: "utf8" }).trim().replace(/^v/, "");
  } catch {
    return "desconhecida";
  }
})();

// com base, a foto é absoluta: em /curso (sem barra final) um caminho relativo cairia na raiz do site
const BASE = process.env.CURSO_BASE ?? "";
if (BASE && !/^\/.*\/$/.test(BASE)) throw new Error(`CURSO_BASE precisa começar e terminar com "/" (veio "${BASE}")`);
for (const c of Object.values(capturas) as Array<{ foto: string }>) c.foto = BASE + c.foto;

const dados = {
  versao,
  gerado: new Date().toISOString().slice(0, 10),
  largura,
  altura,
  modulos,
  capturas,
  menu,
};

// "<" escapado: o JSON vai dentro de <script>, e um "</script>" num texto de lição fecharia a tag
const json = JSON.stringify(dados).replace(/</g, "\\u003c");
const html = ler("site/pagina.html")
  .replace("/*ESTILO*/", () => ler("site/estilo.css"))
  .replace("/*DADOS*/", () => json)
  .replace("/*APP*/", () => ler("site/app.js"));
const DOCUMENTO = `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Curso em imagens do DeskComm: cada tela do sistema com fotos reais, setas e um simulador para treinar.">
`;
writeFileSync(path.join(SAIDA, "index.html"), BASE ? DOCUMENTO + html : html);
console.info(`curso/saida/index.html — ${modulos.length} módulo(s), ${Object.keys(capturas).length} fotos, versão ${versao}`);
