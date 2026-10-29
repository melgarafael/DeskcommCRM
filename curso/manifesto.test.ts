// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abrirManifestoDaRodada, type Manifesto } from "./manifesto";
import type { Captura } from "./capturar";

const pastas: string[] = [];
afterEach(() => {
  for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const foto: Captura = {
  foto: "capturas/cena.jpg",
  clicar: null,
  destaques: [],
  versao: "1.99.0",
  idioma: "es",
  commit_fonte: "a".repeat(40),
  capturado_em: "2026-10-27T17:00:00.000Z",
};
function fixture() {
  const pasta = mkdtempSync(path.join(tmpdir(), "curso-manifesto-es-"));
  pastas.push(pasta);
  const arquivo = path.join(pasta, "capturas.json");
  const ler = (): Manifesto => JSON.parse(readFileSync(arquivo, "utf8"));
  return { pasta, arquivo, ler };
}

describe("manifesto comum das fotografias", () => {
  it("abre sem git ou metadados e só publica a origem da foto concluída", async () => {
    vi.stubEnv("CURSO_COMMIT_FOTOS", "inválido");
    const f = fixture();
    const registrar = abrirManifestoDaRodada(f.arquivo, ["primeira", "segunda"]);
    expect(f.ler()).toEqual({
      largura: 1440,
      altura: 900,
      capturas: {},
      falhas: ["primeira", "segunda"],
    });
    await expect(
      registrar("primeira", async () => {
        throw new Error("medição falhou");
      }),
    ).rejects.toThrow("medição falhou");
    expect(f.ler().capturas).toEqual({});
    await registrar("primeira", async () => foto);
    expect(f.ler()).toMatchObject({
      idioma: "es",
      commit_fonte: foto.commit_fonte,
      versao: foto.versao,
      gerado_em: foto.capturado_em,
      falhas: ["segunda"],
      capturas: { primeira: foto },
    });
  });

  it("falha de persistência não libera uma cena no sucesso da seguinte", async () => {
    const f = fixture();
    const registrar = abrirManifestoDaRodada(f.arquivo, ["primeira", "segunda"]);
    const temporario = path.join(f.pasta, `.capturas.json.${process.pid}.tmp`);
    mkdirSync(temporario); // Impede a escrita real do arquivo temporário.
    await expect(registrar("primeira", async () => foto)).rejects.toThrow();
    rmSync(temporario, { recursive: true });
    await registrar("segunda", async () => foto);
    expect(f.ler().falhas).toEqual(["primeira"]);
    expect(f.ler().capturas).not.toHaveProperty("primeira");
    expect(f.ler().capturas.segunda).toEqual(foto);
  });
});
