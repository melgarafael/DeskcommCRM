import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const publish = readFileSync(join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const common = readFileSync(join(RAIZ, "hostgator-setup-kit/_common.sh"), "utf8");
const manifestos = readFileSync(join(RAIZ, "hostgator-setup-kit/_manifestos.sh"), "utf8");
const tagSoNasceDaMain = readFileSync(join(RAIZ, "tests/unit/tag-so-nasce-da-main.test.ts"), "utf8");
const packaging = readFileSync(join(RAIZ, "tests/unit/packaging-artefato-do-cliente.test.ts"), "utf8");

function job(yml: string, nome: string): string {
  const linhas = yml.split("\n");
  const iJobs = linhas.findIndex((linha) => /^jobs:\s*$/.test(linha));
  if (iJobs === -1) return "";
  const inicio = linhas.findIndex((linha, i) => i > iJobs && linha === `  ${nome}:`);
  if (inicio === -1) return "";
  const fim = linhas.findIndex(
    (linha, i) => i > inicio && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(linha),
  );
  return linhas.slice(inicio, fim === -1 ? undefined : fim).join("\n");
}

function imagensDaMatriz(yml = publish): string[] {
  const corpo = job(yml, "build-and-push");
  const bloco = /matrix:\s*\n\s+include:\s*\n([\s\S]*?)(?=\n {4}steps:)/.exec(corpo)?.[1] ?? "";
  return [...bloco.matchAll(/^\s*-\s+name:\s*([A-Za-z0-9._-]+)\s*$/gm)]
    .map((match) => match[1]!)
    .sort();
}

function palavrasDaLista(texto: string): string[] {
  return texto
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function stringsDoArray(texto: string): string[] {
  return [...texto.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!).sort();
}

function imagensDoKit(): string[] {
  const corpo = /trio_publicado\(\)\s*\{([\s\S]*?)\n\}/.exec(common)?.[1] ?? "";
  const lista = /for\s+i\s+in\s+([^;]+);\s*do/.exec(corpo)?.[1] ?? "";
  return palavrasDaLista(lista);
}

// O pré-voo ARM64 tem a sua própria lista (sonda o índice OCI, não só o HTTP 200).
function imagensDoPreflightArm(): string[] {
  const corpo = /preflight_imagens_crm\(\)\s*\{([\s\S]*?)\n\}/.exec(manifestos)?.[1] ?? "";
  const lista = /for\s+img\s+in\s+([^;]+);\s*do/.exec(corpo)?.[1] ?? "";
  return palavrasDaLista(lista);
}

function imagensDoTesteDaTag(): string[] {
  const lista = /for\s*\(const\s+img\s+of\s+\[([^\]]+)\]\)/.exec(tagSoNasceDaMain)?.[1] ?? "";
  return stringsDoArray(lista);
}

function imagensDoTesteDePackaging(): string[] {
  const lista = /for\s*\(const\s+imagem\s+of\s+\[([^\]]+)\]\)/.exec(packaging)?.[1] ?? "";
  return stringsDoArray(lista);
}

const IMAGENS = imagensDaMatriz();

describe("listas de imagens Docker seguem a matriz de publicação", () => {
  it("o instrumento está vivo e encontra a fonte de verdade", () => {
    expect(job(publish, "build-and-push"), "o job build-and-push sumiu").not.toBe("");
    expect(IMAGENS.length, "não consegui extrair imagens da matriz build-and-push").toBeGreaterThan(0);
    expect(new Set(IMAGENS).size, "a matriz contém nomes duplicados").toBe(IMAGENS.length);
  });

  it("o kit confere exatamente todas as imagens publicadas", () => {
    expect(
      imagensDoKit(),
      "trio_publicado() divergiu da matriz: uma imagem pode ficar invisível para install/update",
    ).toEqual(IMAGENS);
    expect(
      imagensDoPreflightArm(),
      "preflight_imagens_crm() divergiu da matriz: o pré-voo ARM64 deixaria uma imagem sem sonda",
    ).toEqual(IMAGENS);
  });

  it("a guarda de criação de tag usa exatamente as imagens publicadas", () => {
    expect(
      imagensDoTesteDaTag(),
      "tag-so-nasce-da-main ficou com uma cópia diferente da matriz de imagens",
    ).toEqual(IMAGENS);
  });

  it("a guarda do artefato do cliente usa exatamente as imagens publicadas", () => {
    expect(
      imagensDoTesteDePackaging(),
      "packaging-artefato-do-cliente ficou com uma cópia diferente da matriz de imagens",
    ).toEqual(IMAGENS);
  });
});
