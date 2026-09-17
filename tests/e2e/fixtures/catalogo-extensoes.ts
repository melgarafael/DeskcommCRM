import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { ExtensionManifest } from "../../../lib/extensions/manifest";
import { credenciaisSupabaseDeTeste } from "../../../scripts/lib/env-de-teste";

const executar = promisify(execFile);
const ORIGEM_CATALOGO = "http://127.0.0.1:56331";
const CAMINHO_CLI = "experiments/extensoes/catalog/catalog.py";

export interface AtoresDasExtensoes {
  db: SupabaseClient;
  senha: string;
  organizacaoA: string;
  organizacaoB: string;
  usuarios: {
    owner: { id: string; email: string };
    agentA: { id: string; email: string };
    viewerA: { id: string; email: string };
    adminB: { id: string; email: string };
  };
  limpar(): Promise<void>;
}

export interface CatalogoDeExtensoes {
  diretorio: string;
  banco: string;
  catalogo: string;
  origem: string;
  revisao: number;
  digestCatalogo: string;
  publicadoEm: string;
  buildId: string;
  buildMtimeMs: number;
  manifestoMtimeMs: number;
  pacote: {
    publisher: string;
    name: string;
    version: string;
    title: string;
    cardId: string;
    cardTitle: string;
    cardDescription: string;
    digest: string;
    bytes: Buffer;
  };
  pacoteAlterado: {
    name: string;
    title: string;
    digestAdmitido: string;
    bytes: Buffer;
  };
  pid: number;
  estaLigado(): boolean;
  desligar(): Promise<void>;
  limpar(): Promise<void>;
}

function portaLocal(valor: string, rotulo: string): string {
  const url = new URL(valor);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) {
    throw new Error(`${rotulo} precisa apontar para loopback com porta; recebido ${url.host}.`);
  }
  return url.port;
}

/**
 * A fixture só aceita o runner canônico já publicado pelo Playwright. As
 * pré-condições vêm antes de `credenciaisSupabaseDeTeste()` para impedir o
 * fallback que abriria `.env.local` quando uma variável estivesse ausente.
 */
export function bancoE2eDasExtensoes(): SupabaseClient {
  const obrigatorias = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_URL",
    "NEXT_PUBLIC_APP_URL",
    "EXTENSIONS_LOCAL_CATALOG_ORIGIN",
  ] as const;
  const ausentes = obrigatorias.filter((chave) => !process.env[chave]);
  if (ausentes.length > 0) {
    throw new Error(`O runner E2E não publicou o ambiente canônico: ${ausentes.join(", ")}.`);
  }

  const credenciais = credenciaisSupabaseDeTeste();
  if (credenciais.origem !== "ambiente") {
    throw new Error("As credenciais das extensões precisam vir do ambiente do runner E2E.");
  }
  // 56xxx é o ambiente isolado desta integração; 54xxx/3001 é o Supabase
  // local fresco que o workflow oficial cria. Nenhum terceiro perfil passa.
  const portas = [
    portaLocal(credenciais.url, "Supabase API"),
    portaLocal(credenciais.dbUrl, "Postgres"),
    portaLocal(credenciais.appUrl, "Aplicação"),
  ].join(":");
  if (portas !== "56321:56322:56330" && portas !== "54321:54322:3001") {
    throw new Error(`Perfil de portas E2E inesperado: ${portas}.`);
  }
  if (process.env.EXTENSIONS_LOCAL_CATALOG_ORIGIN !== ORIGEM_CATALOGO) {
    throw new Error(`Catálogo E2E precisa ser ${ORIGEM_CATALOGO}.`);
  }

  return createClient(credenciais.url, credenciais.serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function inserir(
  db: SupabaseClient,
  tabela: string,
  valor: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error || !data) throw new Error(`${tabela}: ${error?.message ?? "linha ausente"}`);
  return data.id as string;
}

export async function criarAtoresDasExtensoes(): Promise<AtoresDasExtensoes> {
  const db = bancoE2eDasExtensoes();
  const sufixo = randomUUID().slice(0, 10);
  const senha = `Ext-${randomUUID()}!aA9`;
  const definicoes = {
    owner: `extensions-owner-${sufixo}@invariant.test`,
    agentA: `extensions-agent-${sufixo}@invariant.test`,
    viewerA: `extensions-viewer-${sufixo}@invariant.test`,
    adminB: `extensions-admin-b-${sufixo}@invariant.test`,
  } as const;
  const usuarios = {} as AtoresDasExtensoes["usuarios"];
  const idsCriados: string[] = [];
  const organizacoesCriadas: string[] = [];

  try {
    for (const [papel, email] of Object.entries(definicoes) as Array<
      [keyof typeof definicoes, string]
    >) {
      const { data, error } = await db.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(error?.message ?? `Usuário ${papel} ausente.`);
      usuarios[papel] = { id: data.user.id, email };
      idsCriados.push(data.user.id);
    }

    const agora = new Date().toISOString();
    const organizacaoA = await inserir(db, "organizations", {
      display_name: `Extensões A ${sufixo}`,
      legal_name: `Extensões A ${sufixo}`,
      slug: `extensions-a-${sufixo}`,
      onboarded_at: agora,
      settings: { security: { mfa_required: false } },
    });
    organizacoesCriadas.push(organizacaoA);
    const organizacaoB = await inserir(db, "organizations", {
      display_name: `Extensões B ${sufixo}`,
      legal_name: `Extensões B ${sufixo}`,
      slug: `extensions-b-${sufixo}`,
      onboarded_at: agora,
      settings: { security: { mfa_required: false } },
    });
    organizacoesCriadas.push(organizacaoB);

    const memberships = await db.from("user_organizations").insert([
      {
        organization_id: organizacaoA,
        user_id: usuarios.owner.id,
        role: "admin",
        accepted_at: agora,
      },
      {
        organization_id: organizacaoB,
        user_id: usuarios.owner.id,
        role: "admin",
        accepted_at: agora,
      },
      {
        organization_id: organizacaoA,
        user_id: usuarios.agentA.id,
        role: "agent",
        accepted_at: agora,
      },
      {
        organization_id: organizacaoA,
        user_id: usuarios.viewerA.id,
        role: "viewer",
        accepted_at: agora,
      },
      {
        organization_id: organizacaoB,
        user_id: usuarios.adminB.id,
        role: "admin",
        accepted_at: agora,
      },
    ]);
    if (memberships.error) throw new Error(memberships.error.message);

    const plataforma = await db.from("platform_admins").insert({
      user_id: usuarios.owner.id,
      granted_by: usuarios.owner.id,
      scope: "full",
      mfa_required: false,
      reason: "Fixture local E2E de extensões declarativas",
    });
    if (plataforma.error) throw new Error(plataforma.error.message);

    return {
      db,
      senha,
      organizacaoA,
      organizacaoB,
      usuarios,
      async limpar() {
        for (const id of organizacoesCriadas) {
          const resultado = await db.from("organizations").delete().eq("id", id);
          if (resultado.error) throw new Error(resultado.error.message);
        }
        await db.from("platform_admins").delete().eq("user_id", usuarios.owner.id);
        for (const id of idsCriados) {
          const { error } = await db.auth.admin.deleteUser(id);
          if (error) throw new Error(error.message);
        }
      },
    };
  } catch (error) {
    for (const id of organizacoesCriadas) {
      await db.from("organizations").delete().eq("id", id);
    }
    for (const id of idsCriados) await db.auth.admin.deleteUser(id);
    throw error;
  }
}

async function catalogoCli(argumentos: string[]): Promise<string> {
  const { stdout } = await executar("python3", [CAMINHO_CLI, ...argumentos], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return stdout.trim();
}

async function aguardarDepoisDoBuild(buildMtimeMs: number): Promise<void> {
  const espera = Math.max(0, Math.ceil(buildMtimeMs - Date.now()) + 5);
  if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
}

async function iniciarServidor(banco: string): Promise<{
  processo: ChildProcessWithoutNullStreams;
  pid: number;
}> {
  const processo = spawn(
    "python3",
    [CAMINHO_CLI, "serve", "--db", banco, "--host", "127.0.0.1", "--port", "56331"],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  const pid = processo.pid;
  if (!pid) throw new Error("O servidor do catálogo não informou PID.");

  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        reject(new Error(`Catálogo não iniciou em 10s. ${stderr}`));
      }, 10_000);
      processo.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes(ORIGEM_CATALOGO)) {
          clearTimeout(timer);
          resolve();
        }
      });
      processo.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      processo.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Catálogo encerrou antes de iniciar (exit ${code}). ${stderr}`));
      });
    });
  } catch (error) {
    await encerrarProcessoProprio(processo, pid).catch(() => undefined);
    throw error;
  }
  return { processo, pid };
}

async function encerrarProcessoProprio(
  processo: ChildProcessWithoutNullStreams,
  pid: number,
): Promise<void> {
  if (processo.exitCode !== null || processo.signalCode !== null) return;
  if (processo.pid !== pid) throw new Error("PID do catálogo mudou; cleanup recusado.");
  processo.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const forceTimer = setTimeout(() => {
      if (processo.pid === pid) processo.kill("SIGKILL");
    }, 5_000);
    const deadline = setTimeout(
      () => reject(new Error("O processo próprio do catálogo não encerrou após SIGKILL.")),
      7_000,
    );
    processo.once("exit", () => {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
      resolve();
    });
  });
}

export async function criarCatalogoDeExtensoes(
  db: SupabaseClient,
  evidenceDir: string,
): Promise<CatalogoDeExtensoes> {
  const buildPath = path.join(process.cwd(), ".next", "BUILD_ID");
  const buildStat = await stat(buildPath).catch(() => null);
  if (!buildStat?.isFile()) {
    throw new Error("A publicação do pacote exige `.next/BUILD_ID` de um build já concluído.");
  }
  const buildId = (await readFile(buildPath, "utf8")).trim();
  if (!buildId) throw new Error("O BUILD_ID está vazio.");

  const { data: atual, error: erroAtual } = await db
    .from("extension_catalogs")
    .select("revision")
    .eq("origin", ORIGEM_CATALOGO)
    .maybeSingle();
  if (erroAtual) throw new Error(erroAtual.message);
  const revisaoAtual = (atual?.revision as number | undefined) ?? 0;

  const diretorio = await mkdtemp(path.join(tmpdir(), "deskcomm-extensions-e2e-"));
  let servidor: Awaited<ReturnType<typeof iniciarServidor>> | undefined;
  try {
    const banco = path.join(diretorio, "catalog.sqlite");
    const manifesto = path.join(diretorio, "guide.json");
    const manifestoAlterado = path.join(diretorio, "guide-altered.json");
    const sufixo = randomUUID().replaceAll("-", "").slice(0, 10);
    const publisher = `ensaio-${sufixo}`;
    const name = `guia-${sufixo}`;
    const title = `Guia ${sufixo}`;
    const cardId = `proximo-passo-${sufixo}`;
    const cardTitle = `Próximo passo ${sufixo}`;
    const cardDescription = `Descrição exclusiva ${sufixo}`;
    const badName = `guia-falha-${sufixo}`;
    const badTitle = `Guia alterado ${sufixo}`;

    await aguardarDepoisDoBuild(buildStat.mtimeMs);
    await catalogoCli(["init", "--db", banco, "--origin", ORIGEM_CATALOGO]);
    await catalogoCli(["make-example", "--output", manifesto]);
    const base = JSON.parse(await readFile(manifesto, "utf8")) as ExtensionManifest;
    base.publisher = publisher;
    base.name = name;
    base.display.title["pt-BR"] = title;
    base.display.summary["pt-BR"] = `Publicado depois do build ${buildId}.`;
    const firstCard = base.contributions.crm_cards[0];
    if (!firstCard) throw new Error("O exemplo do CLI não contém um card CRM.");
    firstCard.id = cardId;
    firstCard.title["pt-BR"] = cardTitle;
    firstCard.description["pt-BR"] = cardDescription;
    await writeFile(manifesto, JSON.stringify(base), "utf8");

    const bad = structuredClone(base);
    bad.name = badName;
    bad.display.title["pt-BR"] = badTitle;
    await catalogoCli(["make-example", "--output", manifestoAlterado]);
    await writeFile(manifestoAlterado, JSON.stringify(bad), "utf8");

    const manifestoStat = await stat(manifesto);
    if (manifestoStat.mtimeMs <= buildStat.mtimeMs) {
      throw new Error("O pacote não foi criado depois do BUILD_ID.");
    }
    const bytes = await readFile(manifesto);
    const digest = await catalogoCli(["publish", "--db", banco, "--manifest", manifesto]);
    const digestAlterado = await catalogoCli([
      "publish",
      "--db",
      banco,
      "--manifest",
      manifestoAlterado,
    ]);
    const bytesAlterados = await readFile(manifestoAlterado);
    if (digest !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error("O digest publicado pelo CLI diverge dos bytes originais.");
    }

    let catalogo = "";
    let digestCatalogo = "";
    for (let revisao = 1; revisao <= revisaoAtual + 1; revisao += 1) {
      catalogo = path.join(diretorio, `catalog-revision-${revisao}.json`);
      digestCatalogo = await catalogoCli(["export", "--db", banco, "--output", catalogo]);
    }
    const snapshot = JSON.parse(await readFile(catalogo, "utf8")) as { revision: number };
    if (snapshot.revision !== revisaoAtual + 1) {
      throw new Error("A revisão exportada não sucede o catálogo já admitido.");
    }

    const consultaSqlite = [
      "import hashlib,json,sqlite3,sys",
      "db,digest=sys.argv[1],sys.argv[2]",
      "con=sqlite3.connect(db)",
      "row=con.execute('select artifact,byte_length from packages where sha256=?',(digest,)).fetchone()",
      "assert row is not None",
      "body=bytes(row[0])",
      "print(json.dumps({'sha256':hashlib.sha256(body).hexdigest(),'byte_length':row[1]}))",
    ].join(";");
    const sqlite = JSON.parse(
      (
        await executar("python3", ["-c", consultaSqlite, banco, digest], {
          encoding: "utf8",
        })
      ).stdout,
    ) as { sha256: string; byte_length: number };
    if (sqlite.sha256 !== digest || sqlite.byte_length !== bytes.byteLength) {
      throw new Error("O SQLite não preservou o documento publicado byte a byte.");
    }

    // O segundo pacote continua admitido pelo digest original, mas o receiver
    // real entregará bytes diferentes. A falha nasce no HTTP e na validação do
    // host; não existe mock de download.
    const alterarSqlite = [
      "import hashlib,json,sqlite3,sys",
      "db,digest=sys.argv[1],sys.argv[2]",
      "con=sqlite3.connect(db)",
      "row=con.execute('select artifact,byte_length from packages where sha256=?',(digest,)).fetchone()",
      "assert row is not None",
      "body=bytearray(row[0])",
      'needle=b\'"body":{"pt-BR":"\'',
      "offset=body.find(needle)+len(needle)",
      "assert offset>=len(needle)",
      "body[offset]=89 if body[offset]==88 else 88",
      "mutated=bytes(body)",
      "assert len(mutated)==row[1]",
      "con.execute('update packages set artifact=? where sha256=?',(mutated,digest))",
      "con.commit()",
      "print(json.dumps({'sha256':hashlib.sha256(mutated).hexdigest(),'byte_length':len(mutated)}))",
    ].join(";");
    const adulterado = JSON.parse(
      (
        await executar("python3", ["-c", alterarSqlite, banco, digestAlterado], {
          encoding: "utf8",
        })
      ).stdout,
    ) as { sha256: string; byte_length: number };
    if (
      adulterado.byte_length !== bytesAlterados.byteLength ||
      adulterado.sha256 === digestAlterado
    ) {
      throw new Error("A adulteração precisa manter o tamanho e mudar somente a integridade.");
    }

    const servidorIniciado = await iniciarServidor(banco);
    servidor = servidorIniciado;
    const recebido = Buffer.from(
      await (await fetch(`${ORIGEM_CATALOGO}/packages/${digest}.json`)).arrayBuffer(),
    );
    if (!recebido.equals(bytes)) {
      throw new Error("O serviço HTTP não entregou o corpo original publicado.");
    }

    const publicadoEm = new Date().toISOString();
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "catalog-publish.json"),
      JSON.stringify(
        {
          build_id: buildId,
          build_mtime: new Date(buildStat.mtimeMs).toISOString(),
          manifest_mtime: new Date(manifestoStat.mtimeMs).toISOString(),
          published_at: publicadoEm,
          catalog_revision: snapshot.revision,
          catalog_sha256: digestCatalogo,
          package_sha256: digest,
          sqlite_document_sha256: sqlite.sha256,
          altered_admitted_sha256: digestAlterado,
          altered_served_sha256: adulterado.sha256,
          altered_byte_length: adulterado.byte_length,
          server_pid: servidorIniciado.pid,
        },
        null,
        2,
      ),
      "utf8",
    );

    let ligado = true;
    return {
      diretorio,
      banco,
      catalogo,
      origem: ORIGEM_CATALOGO,
      revisao: snapshot.revision,
      digestCatalogo,
      publicadoEm,
      buildId,
      buildMtimeMs: buildStat.mtimeMs,
      manifestoMtimeMs: manifestoStat.mtimeMs,
      pacote: {
        publisher,
        name,
        version: "1.0.0",
        title,
        cardId,
        cardTitle,
        cardDescription,
        digest,
        bytes,
      },
      pacoteAlterado: {
        name: badName,
        title: badTitle,
        digestAdmitido: digestAlterado,
        bytes: bytesAlterados,
      },
      pid: servidorIniciado.pid,
      estaLigado: () => ligado && servidorIniciado.processo.exitCode === null,
      async desligar() {
        if (!ligado) return;
        ligado = false;
        await encerrarProcessoProprio(servidorIniciado.processo, servidorIniciado.pid);
      },
      async limpar() {
        let erroDoProcesso: unknown;
        if (ligado) {
          try {
            await encerrarProcessoProprio(servidorIniciado.processo, servidorIniciado.pid);
          } catch (error) {
            erroDoProcesso = error;
          }
        }
        ligado = false;
        const raizPermitida = path.join(tmpdir(), "deskcomm-extensions-e2e-");
        if (!diretorio.startsWith(raizPermitida)) {
          throw new Error("Diretório temporário inesperado; cleanup recusado.");
        }
        await rm(diretorio, { recursive: true, force: true });
        if (erroDoProcesso) throw erroDoProcesso;
      },
    };
  } catch (error) {
    if (servidor) {
      await encerrarProcessoProprio(servidor.processo, servidor.pid).catch(() => undefined);
    }
    await rm(diretorio, { recursive: true, force: true });
    throw error;
  }
}

export interface CatalogoDeVersoes {
  diretorio: string;
  catalogo: string;
  origem: string;
  revisao: number;
  publisher: string;
  name: string;
  title: string;
  /** Existe nas duas versões: identidade estável entre versões (regra 1 do formato). */
  cardEstavel: { id: string; titulo: string };
  /** Só a 1.1.0 traz: é o que prova que a organização passou a ver a versão nova. */
  cardNovo: { id: string; titulo: string };
  estaLigado(): boolean;
  desligar(): Promise<void>;
  religar(): Promise<void>;
  limpar(): Promise<void>;
}

/**
 * Catálogo do J26: a MESMA identidade publicada em 1.0.0 e 1.1.0 depois do build, num SQLite
 * próprio, servido pelo processo HTTP real na porta do ensaio. Diferente da fixture do J25, o
 * catálogo pode ser desligado e religado: desfazer tem de funcionar com ele fora do ar, e
 * reinstalar precisa dele de volta.
 */
export async function criarCatalogoDeVersoes(
  db: SupabaseClient,
  evidenceDir: string,
): Promise<CatalogoDeVersoes> {
  const buildPath = path.join(process.cwd(), ".next", "BUILD_ID");
  const buildStat = await stat(buildPath).catch(() => null);
  if (!buildStat?.isFile()) {
    throw new Error("A publicação dos pacotes exige `.next/BUILD_ID` de um build já concluído.");
  }
  const { data: atual, error: erroAtual } = await db
    .from("extension_catalogs")
    .select("revision")
    .eq("origin", ORIGEM_CATALOGO)
    .maybeSingle();
  if (erroAtual) throw new Error(erroAtual.message);
  const revisaoAtual = (atual?.revision as number | undefined) ?? 0;

  const diretorio = await mkdtemp(path.join(tmpdir(), "deskcomm-extensions-e2e-"));
  let servidor: Awaited<ReturnType<typeof iniciarServidor>> | undefined;
  try {
    const banco = path.join(diretorio, "catalog.sqlite");
    const sufixo = randomUUID().replaceAll("-", "").slice(0, 10);
    const publisher = `versoes-${sufixo}`;
    const name = `guia-${sufixo}`;
    const title = `Guia versionado ${sufixo}`;
    const cardEstavel = { id: `passo-${sufixo}`, titulo: `Passo que fica ${sufixo}` };
    const cardNovo = { id: `novidade-${sufixo}`, titulo: `Novidade da 1.1.0 ${sufixo}` };

    await aguardarDepoisDoBuild(buildStat.mtimeMs);
    await catalogoCli(["init", "--db", banco, "--origin", ORIGEM_CATALOGO]);
    const exemplo = path.join(diretorio, "exemplo.json");
    await catalogoCli(["make-example", "--output", exemplo]);
    const base = JSON.parse(await readFile(exemplo, "utf8")) as ExtensionManifest;
    base.publisher = publisher;
    base.name = name;
    base.display.title["pt-BR"] = title;
    base.display.summary["pt-BR"] = `Versão 1.0.0 publicada depois do build.`;
    const primeiro = base.contributions.crm_cards[0];
    if (!primeiro) throw new Error("O exemplo do CLI não contém um card CRM.");
    primeiro.id = cardEstavel.id;
    primeiro.title["pt-BR"] = cardEstavel.titulo;

    const nova = structuredClone(base);
    nova.version = "1.1.0";
    nova.display.summary["pt-BR"] = `Versão 1.1.0 publicada depois do build.`;
    nova.contributions.crm_cards.push({
      ...structuredClone(primeiro),
      id: cardNovo.id,
      title: { "pt-BR": cardNovo.titulo },
    });

    const digests: Record<string, string> = {};
    for (const [versao, manifesto] of [
      ["1.0.0", base],
      ["1.1.0", nova],
    ] as const) {
      const arquivo = path.join(diretorio, `guia-${versao}.json`);
      await writeFile(arquivo, JSON.stringify(manifesto), "utf8");
      if ((await stat(arquivo)).mtimeMs <= buildStat.mtimeMs) {
        throw new Error("O pacote não foi criado depois do BUILD_ID.");
      }
      digests[versao] = await catalogoCli(["publish", "--db", banco, "--manifest", arquivo]);
    }

    let catalogo = "";
    for (let revisao = 1; revisao <= revisaoAtual + 1; revisao += 1) {
      catalogo = path.join(diretorio, `catalog-revision-${revisao}.json`);
      await catalogoCli(["export", "--db", banco, "--output", catalogo]);
    }
    const snapshot = JSON.parse(await readFile(catalogo, "utf8")) as {
      revision: number;
      entries: Array<{ name: string; version: string }>;
    };
    if (snapshot.revision !== revisaoAtual + 1) {
      throw new Error("A revisão exportada não sucede o catálogo já admitido.");
    }
    if (snapshot.entries.filter((entrada) => entrada.name === name).length !== 2) {
      throw new Error("O catálogo exportado precisa listar as duas versões da mesma identidade.");
    }

    servidor = await iniciarServidor(banco);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, "catalogo-de-versoes.json"),
      JSON.stringify(
        { publisher, name, revision: snapshot.revision, package_sha256: digests },
        null,
        2,
      ),
      "utf8",
    );

    let ligado = true;
    const encerrar = async () => {
      if (!ligado || !servidor) return;
      ligado = false;
      await encerrarProcessoProprio(servidor.processo, servidor.pid);
    };
    return {
      diretorio,
      catalogo,
      origem: ORIGEM_CATALOGO,
      revisao: snapshot.revision,
      publisher,
      name,
      title,
      cardEstavel,
      cardNovo,
      estaLigado: () => ligado && servidor?.processo.exitCode === null,
      desligar: encerrar,
      async religar() {
        if (ligado) return;
        servidor = await iniciarServidor(banco);
        ligado = true;
      },
      async limpar() {
        let erroDoProcesso: unknown;
        try {
          await encerrar();
        } catch (error) {
          erroDoProcesso = error;
        }
        const raizPermitida = path.join(tmpdir(), "deskcomm-extensions-e2e-");
        if (!diretorio.startsWith(raizPermitida)) {
          throw new Error("Diretório temporário inesperado; cleanup recusado.");
        }
        await rm(diretorio, { recursive: true, force: true });
        if (erroDoProcesso) throw erroDoProcesso;
      },
    };
  } catch (error) {
    if (servidor) {
      await encerrarProcessoProprio(servidor.processo, servidor.pid).catch(() => undefined);
    }
    await rm(diretorio, { recursive: true, force: true });
    throw error;
  }
}
