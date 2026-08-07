/**
 * De onde um script de seed/sonda lê as credenciais do Supabase.
 *
 * ═══ O DEFEITO QUE ISTO CONSERTA (medido em 2026-08-06) ═══
 *
 * Os scripts liam `.env.local` **direto do disco**, ignorando `process.env`:
 *
 *     const envFile = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
 *
 * Num checkout de trabalho, `.env.local` aponta para PRODUÇÃO. Consequência: a
 * suíte E2E semeava organizações, usuários e agentes de teste no banco real — e
 * o `.env.e2e` no `webServer` do Playwright **não alcançava** esses scripts,
 * porque eles nunca olharam para o ambiente. O sintoma que denunciou: o factor
 * TOTP gravado em `.e2e-creds.json` não existia no banco local, porque tinha
 * sido criado na nuvem.
 *
 * A org `e2e-test-org` está na produção deste projeto desde 2026-04-29. Ela não
 * chegou lá por acidente de uma sessão: chegou porque **este era o comportamento
 * normal** da suíte.
 *
 * ═══ A REGRA ═══
 *
 * `process.env` VENCE o arquivo. É o que permite `set -a; . ./.env.e2e` (ou o
 * `env` do Playwright) redirecionar qualquer script sem editar nenhum deles.
 * Sem valor no ambiente, cai em `.env.local` — o comportamento de sempre, para
 * quem roda uma sonda à mão durante o desenvolvimento.
 */
import fs from "node:fs";
import path from "node:path";

export interface CredenciaisSupabase {
  url: string;
  serviceRole: string;
  /** anon key — alguns seeds fazem signIn como usuário comum (ex.: enroll TOTP). */
  anonKey: string;
  /** base do app, para links gerados pelo seed. */
  appUrl: string;
  /**
   * Conexão DIRETA ao Postgres, para os seeds que abrem `pg.Pool` (13 deles).
   *
   * Nasceu faltando: a interface não a declarava e nenhum dos dois ramos a
   * devolvia, mas os seeds já liam `credenciais.dbUrl`. O compilador não pegou
   * porque `tsconfig.json` tem `"exclude": ["scripts/**"]` — ler propriedade
   * inexistente aqui não custa nada a ele.
   *
   * E o sintoma escolhia o ambiente: local costuma cair no ramo do ARQUIVO e o
   * shell já ter a variável; no CI o workflow exporta as credenciais para o
   * ambiente, o ramo "ambiente" vence, `dbUrl` sai `undefined`, e o `pg` cai no
   * default do libpq — `ECONNREFUSED 127.0.0.1:5432`, uma porta que ninguém
   * pediu (o Supabase local publica na 54322).
   */
  dbUrl: string;
  /** de onde os valores vieram — vai ao log, para o operador não adivinhar. */
  origem: "ambiente" | "arquivo";
}

function lerArquivo(arquivo: string): Record<string, string> {
  const caminho = path.join(process.cwd(), arquivo);
  if (!fs.existsSync(caminho)) return {};
  const env: Record<string, string> = {};
  for (const linha of fs.readFileSync(caminho, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linha);
    if (m) env[m[1]!] = (m[2] ?? "").replace(/^"(.*)"$/, "$1").trim();
  }
  return env;
}

/**
 * Resolve URL + service role. `process.env` primeiro; `.env.local` depois.
 *
 * Lança quando não acha — nunca devolve string vazia, que viraria uma chamada
 * ao Supabase com credencial vazia e um erro três camadas adiante.
 */
export function credenciaisSupabaseDeTeste(): CredenciaisSupabase {
  const doAmbiente = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  };
  if (doAmbiente.url !== "" && doAmbiente.serviceRole !== "") {
    return {
      ...doAmbiente,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      // Cai no arquivo antes de desistir: quem exporta URL + service role no
      // ambiente (o CI faz isso) não necessariamente exporta a conexão direta,
      // e ela costuma estar no `.env.local` do lado. Só o ambiente venceria a
      // regra desta função; nada aqui a contradiz — `process.env` continua
      // tendo precedência quando existe.
      dbUrl: process.env.SUPABASE_DB_URL ?? lerArquivo(".env.local").SUPABASE_DB_URL ?? "",
      origem: "ambiente",
    };
  }

  const arquivo = lerArquivo(".env.local");
  const url = arquivo.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRole = arquivo.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (url === "" || serviceRole === "") {
    throw new Error(
      "Sem credenciais do Supabase: defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY " +
        "no ambiente (ex.: `set -a; . ./.env.e2e; set +a`) ou no .env.local.",
    );
  }
  return {
    url,
    serviceRole,
    anonKey: arquivo.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    appUrl: arquivo.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    dbUrl: arquivo.SUPABASE_DB_URL ?? "",
    origem: "arquivo",
  };
}

/**
 * Diz em voz alta contra QUAL banco o script vai escrever.
 *
 * Existe porque o modo de falha caro aqui é silencioso: um seed que escreve na
 * produção acha exatamente os mesmos dados de teste de sempre e termina com
 * "✅ Seed completo". Uma linha impressa é o que transforma isso em algo que
 * alguém pode notar antes de apertar enter na próxima vez.
 */
export function anunciarDestino(script: string, c: CredenciaisSupabase): void {
  const local = c.url.startsWith("http://127.0.0.1") || c.url.startsWith("http://localhost");
  const rotulo = local ? "LOCAL" : "⚠️  REMOTO";
  console.info(`[${script}] escrevendo em ${rotulo}: ${c.url} (origem: ${c.origem})`);
}

/**
 * O ambiente efetivo para um script de teste/sonda: `process.env` por cima do
 * `.env.local`.
 *
 * ═══ POR QUE ESTA FUNÇÃO EXISTE (e não só `credenciaisSupabaseDeTeste`) ═══
 *
 * As ~96 sondas e provas do repo não leem só as credenciais do Supabase: cada
 * uma pega o que precisa (`WAHA_API_KEY`, `OPENAI_API_KEY`, `SUPABASE_DB_URL`…)
 * de um `Record<string,string>` que elas montavam à mão lendo o arquivo. Trocar
 * isso por um acessor tipado exigiria reescrever 96 arquivos com oito formatos
 * diferentes — risco desproporcional ao problema.
 *
 * Esta função devolve **o mesmo shape** que aquele loader inline devolvia, com
 * duas diferenças que são o conserto inteiro:
 *
 *   1. **`process.env` VENCE o arquivo.** É o que permite `set -a; . ./.env.e2e`
 *      redirecionar qualquer sonda sem editá-la.
 *   2. **A ausência do arquivo não é erro.** No worktree dedicado de e2e não
 *      existe `.env.local`, e é essa ausência que impede a escrita acidental em
 *      produção. O loader antigo estourava com `ENOENT` ali.
 *
 * Também popula `process.env` com o que veio do arquivo (sem sobrescrever), para
 * os módulos que leem de lá — `lib/env.ts`, por exemplo.
 */
export function carregarEnvLocal(): Record<string, string> {
  const doArquivo = lerArquivo(".env.local");
  for (const [k, v] of Object.entries(doArquivo)) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
  // `process.env` por cima: o que o shell definiu manda, o arquivo completa.
  const efetivo: Record<string, string> = { ...doArquivo };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && v !== "") efetivo[k] = v;
  }
  return efetivo;
}
