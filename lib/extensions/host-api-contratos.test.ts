import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as leitorApi2 from "../../tests/fixtures/extensoes/leitor-api2/manifest";
import { checkCompatibility, parseCatalog, parseManifest, type ExtensionCatalog, type ExtensionManifest } from "./manifest";

const raiz = process.cwd();
const fixture = (...partes: string[]) => join(raiz, "tests/fixtures/extensoes", ...partes);
const bytesLegados = readFileSync(fixture("catalogo-api2-rev1.json"));
const legado = leitorApi2.parseCatalog(bytesLegados);
const documentar = (valor: unknown) => Buffer.from(`${JSON.stringify(valor, null, 2)}\n`);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesNovos = readFileSync(fixture("catalogo-api3-rev4.json"));
const catalogoNovo = JSON.parse(bytesNovos.toString("utf8")) as ExtensionCatalog;
const entradaNova = catalogoNovo.entries.find(entrada => entrada.name === "consulta-de-laudos");
if (!entradaNova) throw new Error("Pacote de laudos ausente do catálogo de prova.");
const pacoteNovo = readFileSync(join(raiz, "extensoes/pacotes", entradaNova.publisher, `${entradaNova.name}-${entradaNova.version}.json`));
const manifestoNovo = JSON.parse(pacoteNovo.toString("utf8")) as ExtensionManifest;
const faixasQuePrometemApi2 = [{ min: 2, max: 2 }, { min: 2, max: 3 }, { min: 1, max: 3 }];

describe("contratos API2 e API3 sobre leitores e bytes reais", () => {
  it("mantém a captura executável do leitor antigo e o feed público imutáveis", () => {
    const proveniencia = JSON.parse(readFileSync(fixture("leitor-api2/proveniencia.json"), "utf8")) as {
      source_commit: string; files: Record<string, { fixture_sha256: string }>;
    };
    expect(proveniencia.source_commit).toBe("271a327efe9d0f4532657f3007a6e751306986bd");
    for (const [arquivo, registro] of Object.entries(proveniencia.files)) {
      expect(hash(readFileSync(fixture("leitor-api2", arquivo))), arquivo).toBe(registro.fixture_sha256);
    }
    expect(bytesLegados.length).toBe(3379);
    expect(hash(bytesLegados)).toBe("732fa4d6c1d3ef9d0237e00b1dcb25899d809d90c48add2f5f56654e713460f7");
  });

  it("o leitor antigo aceita os três artefatos API2 publicados", () => {
    expect(legado.entries).toHaveLength(3);
    for (const entrada of legado.entries) {
      const bytes = readFileSync(join(raiz, `extensoes/pacotes/${entrada.publisher}/${entrada.name}-${entrada.version}.json`));
      expect(leitorApi2.checkCompatibility(leitorApi2.parseManifest(bytes)).compatible).toBe(true);
    }
  });

  it("o leitor novo preserva os três artefatos API2 publicados", () => {
    for (const entrada of parseCatalog(bytesLegados).entries) {
      const bytes = readFileSync(join(raiz, `extensoes/pacotes/${entrada.publisher}/${entrada.name}-${entrada.version}.json`));
      expect(checkCompatibility(parseManifest(bytes)).compatible).toBe(true);
    }
  });

  it("o leitor antigo recusa feed e pacote API3, sem interpretação permissiva", () => {
    expect(() => leitorApi2.parseCatalog(bytesNovos)).toThrow();
    expect(() => leitorApi2.parseManifest(pacoteNovo)).toThrow();
  });

  it("o leitor novo aceita o feed de quatro com o turno no contrato API3", () => {
    const catalogo = parseCatalog(bytesNovos);
    expect(catalogo.entries).toHaveLength(4);
    expect(catalogo.entries.map(entrada => checkCompatibility(entrada).compatible)).toEqual([true, true, true, true]);
    expect(checkCompatibility(parseManifest(pacoteNovo)).compatible).toBe(true);
  });

  it.each(faixasQuePrometemApi2)("recusa manifesto de turno que promete $min–$max", host_api => {
    expect(() => parseManifest(documentar({ ...manifestoNovo, host_api }))).toThrow();
  });

  it.each(faixasQuePrometemApi2)("recusa entrada de turno que promete $min–$max", host_api => {
    const entries = catalogoNovo.entries.map(entrada => entrada.name === manifestoNovo.name ? { ...entrada, host_api } : entrada);
    expect(() => parseCatalog(documentar({ ...catalogoNovo, entries }))).toThrow();
  });

  it.each(faixasQuePrometemApi2)("a pré-checagem parcial também recusa turno anunciado como $min–$max", host_api => {
    expect(checkCompatibility({ host_api, permissions: manifestoNovo.permissions })).toEqual({
      compatible: false, reason: "host_api_unsupported",
    });
  });

  it("o retorno forward usa a mesma origem, revisão maior e os mesmos três artefatos", () => {
    const bytes = readFileSync(fixture("catalogo-api2-forward.json"));
    const forward = leitorApi2.parseCatalog(bytes);
    expect(forward.origin).toBe(legado.origin);
    expect(forward.revision).toBeGreaterThan(catalogoNovo.revision);
    expect(forward.entries).toEqual(legado.entries);
    expect(parseCatalog(bytes).entries).toEqual(legado.entries);
    expect(forward.entries.map(entrada => leitorApi2.checkCompatibility(entrada).compatible)).toEqual([true, true, true]);
    expect(forward.entries.map(entrada => checkCompatibility(entrada).compatible)).toEqual([true, true, true]);
  });

  it("suporta os contratos fechados 2 e 3 sem aceitar contrato exclusivo 1 ou 4", () => {
    const entrada = legado.entries.find(entrada => entrada.name === "primeira-semana");
    if (!entrada) throw new Error("Pacote API2 ausente do catálogo legado.");
    const manifesto = parseManifest(readFileSync(join(raiz, "extensoes/pacotes", entrada.publisher, `${entrada.name}-${entrada.version}.json`)));
    expect(checkCompatibility({ ...manifesto, host_api: { min: 2, max: 2 } }).compatible).toBe(true);
    expect(checkCompatibility({ ...manifesto, host_api: { min: 3, max: 3 } }).compatible).toBe(true);
    for (const api of [1, 4]) expect(checkCompatibility({ ...manifesto, host_api: { min: api, max: api } }).reason).toBe("host_api_unsupported");
  });

  it("continua recusando enum desconhecido nos dois leitores", () => {
    const desconhecido = documentar({ ...manifestoNovo, permissions: ["turn.unknown"] });
    expect(() => parseManifest(desconhecido)).toThrow();
    expect(() => leitorApi2.parseManifest(desconhecido)).toThrow();
  });

  it("mantém digest e tamanho dos três pacotes já publicados", () => {
    for (const entrada of legado.entries) {
      const bytes = readFileSync(join(raiz, `extensoes/pacotes/${entrada.publisher}/${entrada.name}-${entrada.version}.json`));
      expect(hash(bytes)).toBe(entrada.sha256);
      expect(bytes.length).toBe(entrada.byte_length);
    }
  });
});
