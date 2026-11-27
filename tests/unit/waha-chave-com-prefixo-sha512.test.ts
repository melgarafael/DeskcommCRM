import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A CHAVE DO WAHA, em todo compose que a entrega ao contêiner — vigiada por máquina.
 *
 * O app manda o PLAINTEXT no `X-Api-Key`; o contêiner recebe o HASH, em
 * `WAHA_API_KEY_SHA512` (hex puro, sem prefixo — é o que `docs/SETUP.md`, o
 * `install.sh` e o `scripts/local-env.sh` gravam). Quem diz ao WAHA que aquilo
 * é um hash é o prefixo `sha512:`, posto pelo COMPOSE. Sem o prefixo o WAHA
 * compara o texto literal com o plaintext recebido, e toda chamada do app toma
 * 401 — o health do CRM mostra `waha: down, credencial_recusada`.
 *
 * O `docker-compose.prod.yml` e o `docker-compose.local.yml` já tinham o
 * prefixo; o `docker-compose.yml` (o de `docker compose up -d` do README) não
 * tinha. Medido em 2026-11-27: chamada direta ao WAHA local com a chave do
 * `.env.local` respondeu 401 sem o prefixo e 200 com ele.
 *
 * O teste varre todo `docker-compose*.yml` da raiz: arquivo de compose novo que
 * entregue `WAHA_API_KEY_SHA512` ao WAHA entra na régua sem ninguém lembrar.
 */

const RAIZ = path.resolve(__dirname, "..", "..");

const composes = fs
  .readdirSync(RAIZ)
  .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
  .map((f) => ({ arquivo: f, texto: fs.readFileSync(path.join(RAIZ, f), "utf8") }))
  .filter(({ texto }) => texto.includes("WAHA_API_KEY_SHA512"));

describe("a chave do WAHA chega ao contêiner como hash declarado", () => {
  it("existe ao menos um compose que entrega a chave (a varredura não está cega)", () => {
    expect(composes.map((c) => c.arquivo)).toContain("docker-compose.yml");
  });

  it.each(composes.map((c) => [c.arquivo, c.texto] as const))(
    "%s põe o prefixo sha512: no WAHA_API_KEY",
    (_arquivo, texto) => {
      const linhas = texto
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .filter((l) => /^\s*-?\s*WAHA_API_KEY\s*[:=]/.test(l) && l.includes("WAHA_API_KEY_SHA512"));
      expect(linhas.length).toBeGreaterThan(0);
      for (const linha of linhas) {
        expect(linha).toMatch(/sha512:\$\{WAHA_API_KEY_SHA512\}/);
      }
    },
  );
});
