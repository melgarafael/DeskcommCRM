import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const root = resolve(import.meta.dirname, "..");
const projectId = readFileSync(resolve(root, "supabase/config.toml"), "utf8")
  .match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
if (!projectId) throw new Error("project_id ausente em supabase/config.toml");

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
run(npx, ["--yes", "supabase@2.50.5", "start", "-x", "studio,edge-runtime,logflare,vector,imgproxy,supavisor"]);
if (process.argv.includes("--reset")) {
  run(npx, ["--yes", "supabase@2.50.5", "db", "reset", "--no-seed"]);
}

const container = `supabase_db_${projectId}`;
for (const file of ["bootstrap-extensions.sql", "baseline.sql"]) {
  const local = resolve(root, "supabase", file);
  const remote = `/tmp/${file}`;
  run("docker", ["cp", local, `${container}:${remote}`]);
  run("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", remote]);
}
