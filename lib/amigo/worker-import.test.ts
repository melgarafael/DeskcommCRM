// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("backend guards stay present and the web tsconfig does not alias them", () => {
  for (const name of ["service", "store", "transport", "sync"])
    expect(readFileSync(`lib/amigo/${name}.ts`, "utf8")).toContain('import "server-only"');
  expect(readFileSync("tsconfig.json", "utf8")).not.toContain("server-only");
});
it("Amigo tools load in the server worker using its dedicated tsx configuration", () => {
  const script =
    'import("./lib/mcp/tools/amigo").then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})';
  expect(() =>
    execFileSync("node", ["--import", "tsx", "--eval", script], {
      env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.worker.json", NODE_NO_WARNINGS: "1" },
      stdio: "pipe",
      timeout: 30000,
    }),
  ).not.toThrow();
});
