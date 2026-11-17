// @vitest-environment node
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// O motor do agente roda fora do Next (tsx, `pnpm worker`) e carrega as
// ferramentas do Amigo. Um `import "server-only"` em qualquer arquivo do
// caminho derruba o motor inteiro, não só o Amigo.
it("as ferramentas do Amigo carregam no processo do motor, com o tsconfig de sempre", () => {
  const script =
    'import("./lib/mcp/tools/amigo").then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})';
  expect(() =>
    execFileSync("node", ["--import", "tsx", "--eval", script], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: "pipe",
      timeout: 60000,
    }),
  ).not.toThrow();
}, 90000);
