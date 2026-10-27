import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseManifest } from "../../../lib/extensions/manifest";

const executar = promisify(execFile);
const ORIGEM = "http://127.0.0.1:56331";
const CLI = "experiments/extensoes/catalog/catalog.py";
const FONTE = "extensoes/pacotes/deskcomm/consulta-de-laudos-1.0.0.json";

/** Publica o consumidor de verdade, sem trocar identidade, texto ou permissão. */
export async function criarCatalogoDoTurno(db: SupabaseClient, evidencia: string) {
  if (process.env.EXTENSIONS_LOCAL_CATALOG_ORIGIN !== ORIGEM) {
    throw new Error("Catálogo do turno fora da origem canônica do E2E.");
  }
  const buildPath = path.join(process.cwd(), ".next/BUILD_ID");
  const build = await stat(buildPath);
  const buildId = (await readFile(buildPath, "utf8")).trim();
  if (!build.isFile() || !buildId) throw new Error("Falta o build concluído do runner.");
  const { data: atual, error } = await db.from("extension_catalogs")
    .select("revision").eq("origin", ORIGEM).maybeSingle();
  if (error) throw new Error(error.message);
  const proximaRevisao = Number(atual?.revision ?? 0) + 1;
  const diretorio = await mkdtemp(path.join(tmpdir(), "extensoes-turno-e2e-"));
  let processo: ChildProcessWithoutNullStreams | undefined;
  const cli = async (...args: string[]) => (await executar("python3", [CLI, ...args], {
    cwd: process.cwd(), encoding: "utf8",
  })).stdout.trim();
  const encerrar = async () => {
    if (!processo || processo.exitCode !== null || processo.signalCode !== null) return;
    const proprio = processo;
    await new Promise<void>((resolve, reject) => {
      const forcar = setTimeout(() => proprio.kill("SIGKILL"), 5_000);
      const limite = setTimeout(() => reject(new Error("Catálogo próprio não encerrou.")), 7_000);
      proprio.once("exit", () => { clearTimeout(forcar); clearTimeout(limite); resolve(); });
      proprio.kill("SIGTERM");
    });
  };
  try {
    const banco = path.join(diretorio, "catalog.sqlite");
    const documento = path.join(diretorio, "consulta-de-laudos.json");
    let catalogo = "";
    const bytes = await readFile(FONTE);
    const manifesto = parseManifest(new Uint8Array(bytes));
    const espera = Math.max(0, Math.ceil(build.mtimeMs - Date.now()) + 5);
    if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
    await writeFile(documento, bytes);
    const publicado = await stat(documento);
    if (publicado.mtimeMs <= build.mtimeMs) throw new Error("Pacote não foi publicado após o build.");
    await cli("init", "--db", banco, "--origin", ORIGEM);
    const digest = createHash("sha256").update(bytes).digest("hex");
    // O comando publish experimental só conhece crm_cards. A precondição do
    // catálogo usa o parser do HOST acima e os helpers de storage/entry do CLI,
    // sem alargar seu contrato. Exportação, HTTP e instalação são os reais.
    const publicar = [
      "import hashlib,pathlib,runpy,sys",
      "api=runpy.run_path(sys.argv[1])",
      "body=pathlib.Path(sys.argv[3]).read_bytes()",
      "manifest=api['strict_json'](body)",
      "digest=hashlib.sha256(body).hexdigest()",
      "entry=api['entry_from_manifest'](manifest,digest,len(body))",
      "with api['connect'](pathlib.Path(sys.argv[2])) as con:",
      "  con.execute('insert into packages (sha256,publisher,name,version,byte_length,entry_json,artifact) values (?,?,?,?,?,?,?)',(digest,manifest['publisher'],manifest['name'],manifest['version'],len(body),api['json'].dumps(entry,ensure_ascii=False,separators=(',',':')),body))",
    ].join("\n");
    await executar("python3", ["-c", publicar, CLI, banco, documento], { cwd: process.cwd() });
    for (let revisao = 1; revisao <= proximaRevisao; revisao += 1) {
      catalogo = path.join(diretorio, `catalog-${revisao}.json`);
      await cli("export", "--db", banco, "--output", catalogo);
    }
    const snapshot = JSON.parse(await readFile(catalogo, "utf8")) as { revision: number };
    if (snapshot.revision !== proximaRevisao) throw new Error("Revisão do catálogo não avançou.");
    processo = spawn("python3", [CLI, "serve", "--db", banco, "--host", "127.0.0.1", "--port", "56331"], {
      cwd: process.cwd(), stdio: "pipe",
    });
    const proprio = processo;
    await new Promise<void>((resolve, reject) => {
      let saida = "";
      const limite = setTimeout(() => reject(new Error("Catálogo não iniciou em 10s.")), 10_000);
      proprio.stdout.on("data", (chunk: Buffer) => {
        saida += chunk.toString("utf8");
        if (saida.includes(ORIGEM)) { clearTimeout(limite); resolve(); }
      });
      proprio.once("error", (erro) => { clearTimeout(limite); reject(erro); });
      proprio.once("exit", (code) => {
        clearTimeout(limite); reject(new Error(`Catálogo encerrou antes de iniciar (${code}).`));
      });
    });
    const resposta = await fetch(`${ORIGEM}/packages/${digest}.json`);
    if (!resposta.ok || !Buffer.from(await resposta.arrayBuffer()).equals(bytes)) {
      throw new Error("Receiver do catálogo não entregou os bytes exatos do consumidor.");
    }
    await mkdir(evidencia, { recursive: true });
    await writeFile(path.join(evidencia, "catalogo.json"), JSON.stringify({
      source: FONTE, build_id: buildId, build_mtime: build.mtime.toISOString(),
      published_mtime: publicado.mtime.toISOString(), catalog_revision: snapshot.revision,
      package_sha256: digest, byte_length: bytes.byteLength, http_bytes_identical: true,
      publication: "Fixture pelo parser do host e storage do CLI; publish experimental só aceita crm_cards.",
    }, null, 2));
    return { catalogo, digest, bytes, publisher: manifesto.publisher, name: manifesto.name, version: manifesto.version, async limpar() {
      try { await encerrar(); } finally { await rm(diretorio, { recursive: true, force: true }); }
    } };
  } catch (erro) {
    try { await encerrar(); } finally { await rm(diretorio, { recursive: true, force: true }); }
    throw erro;
  }
}
