import { spawnSync } from "node:child_process";

const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "http://127.0.0.1:54321";
let hostname = "";
try {
  hostname = new URL(configuredUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
} catch {
  throw new Error(`Migração local recusada: NEXT_PUBLIC_SUPABASE_URL inválida (${configuredUrl})`);
}

if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
  throw new Error(`Migração local recusada: URL fora de loopback (${configuredUrl})`);
}

const command = process.platform === "win32" ? "supabase.cmd" : "supabase";
const lookup = process.platform === "win32"
  ? spawnSync("where.exe", ["supabase"], { stdio: "ignore" })
  : spawnSync("which", ["supabase"], { stdio: "ignore" });
if (lookup.status !== 0) {
  throw new Error("Supabase CLI não encontrada. Instale a CLI e rode `supabase start` antes da migração local.");
}
const result = spawnSync(command, ["db", "reset"], { stdio: "inherit", shell: process.platform === "win32" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
