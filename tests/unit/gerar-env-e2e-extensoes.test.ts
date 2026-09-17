import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const raiz = path.resolve(__dirname, "../..");

describe("o preparo habitual do E2E inclui o catálogo local de extensões", () => {
  it.each(["", "56330"])("inclui o catálogo e respeita E2E_PORT=%s", (porta) => {
    // Executa o gerador real em outro diretório, sem consultar Docker, projetos
    // Supabase ou arquivos de ambiente da estação de trabalho.
    const destino = mkdtempSync(path.join(tmpdir(), "deskcomm-env-extensoes-"));
    try {
      mkdirSync(path.join(destino, "scripts"));
      mkdirSync(path.join(destino, "bin"));
      const script = path.join(destino, "scripts/gerar-env-e2e.sh");
      copyFileSync(path.join(raiz, "scripts/gerar-env-e2e.sh"), script);
      writeFileSync(
        path.join(destino, "bin/supabase"),
        `#!/usr/bin/env bash
set -eu
if [ "$*" = 'status' ]; then exit 0; fi
if [ "$*" = 'status -o env' ]; then
  printf '%s\\n' 'API_URL="http://127.0.0.1:54321"' 'ANON_KEY="synthetic-anon"' 'SERVICE_ROLE_KEY="synthetic-service"'
  exit 0
fi
exit 2
`,
        { mode: 0o700 },
      );
      const chave = Buffer.alloc(32, 1).toString("base64");
      writeFileSync(
        path.join(destino, ".env.e2e"),
        ["CPF_ENCRYPTION_KEY", "WAHA_BYO_ENCRYPTION_KEY", "AI_CRED_AES_KEY"]
          .map((nome) => `${nome}=${chave}\n`)
          .join(""),
        { mode: 0o600 },
      );
      execFileSync("bash", [script], {
        cwd: destino,
        env: { ...process.env, PATH: `${destino}/bin:${process.env.PATH}`, E2E_PORT: porta },
        stdio: "pipe",
        timeout: 10_000,
      });
      const ambiente = readFileSync(path.join(destino, ".env.e2e"), "utf8");
      expect(ambiente).toContain(`NEXT_PUBLIC_APP_URL=http://localhost:${porta || "3001"}\n`);
      expect(ambiente).toContain("NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n");
      expect(ambiente).toContain("EXTENSIONS_LOCAL_CATALOG_ORIGIN=http://127.0.0.1:56331\n");
      expect(ambiente).toContain(`CPF_ENCRYPTION_KEY=${chave}\n`);
      expect(ambiente).toContain("SENTRY_DSN=off\n");
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });
});
