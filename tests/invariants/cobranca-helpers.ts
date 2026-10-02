import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { lastLine, sql } from "./gov-helpers";

/**
 * APOIO DOS INVARIANTES DA COBRANÇA DO REVENDEDOR (migration 0510; spec cobrança
 * do revendedor §2, §5, §12). Nasce UMA vez e completo: tests/invariants/** é
 * congelado (loop/hooks/freeze-invariants.sh), então cada invariante da PR 2 vive
 * no seu arquivo e todos importam daqui. Transporte: o de gov-helpers.ts.
 */

const execFileP = promisify(execFile);
const container = process.env.TEST_DB_CONTAINER ?? "";

/** `<prefixo>-<n com 12 dígitos>`: uuid fixo por arquivo. */
export function uuid(prefixo: string, n: number): string {
  return `${prefixo}-${String(n).padStart(12, "0")}`;
}

export function valor(consulta: string): string {
  return lastLine(sql(consulta));
}

export function numero(consulta: string): number {
  return Number(valor(consulta));
}

/** stderr do psql com SQLSTATE (VERBOSITY verbose), ou "" se o script passou. */
export function erroDe(script: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

/** Como `authenticated` com o JWT do usuário: o caminho do PostgREST. */
export function comoUsuario(usuario: string, comando: string): string {
  return `set role authenticated;
select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', false);
${comando};`;
}

/** Como `anon`: a anon key que vai para o navegador. */
export function comoAnon(comando: string): string {
  return `set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
${comando};`;
}

/** Como `service_role`: rota de servidor, worker, cron. */
export function comoServidor(comando: string): string {
  return `set role service_role;
${comando};`;
}

/** Chama uma função jsonb como service_role e devolve o objeto. */
export function resultado(chamada: string): Record<string, unknown> {
  return JSON.parse(valor(comoServidor(`select ${chamada}`))) as Record<string, unknown>;
}

/** A chave da instalação, no formato que gravarModulo (lib/instalacao/modulos.ts) grava. */
export function chaveDeCobranca(estado: "ligado" | "desligado" | "ausente"): void {
  if (estado === "ausente") {
    sql(`delete from public.platform_config where chave = 'MODULO_COBRANCA';`);
    return;
  }
  sql(`insert into public.platform_config (chave, valor) values ('MODULO_COBRANCA', '${estado}')
         on conflict (chave) do update set valor = excluded.valor;`);
}

export interface PlanoDeTeste {
  id: string;
  nome: string;
  maxAssentos?: number;
  maxCanais?: number;
  tetoIaUsdCents?: number;
  trialDias?: number;
  padrao?: boolean;
}

function ouNulo(v: number | undefined): string {
  return v === undefined ? "null" : String(v);
}

export function criarPlano(p: PlanoDeTeste): void {
  sql(`insert into public.cobranca_planos
         (id, nome, preco_cents, intervalo, trial_dias, max_assentos, max_canais, teto_ia_usd_cents, padrao_no_cadastro)
       values ('${p.id}', '${p.nome}', 4990, 'mes', ${p.trialDias ?? 14}, ${ouNulo(p.maxAssentos)},
               ${ouNulo(p.maxCanais)}, ${ouNulo(p.tetoIaUsdCents)}, ${p.padrao === true})
       on conflict (id) do nothing;`);
}

/** Dá à organização uma assinatura (sem linha = isenta, spec §1.2). */
export function assinar(org: string, plano: string): void {
  sql(`insert into public.cobranca_assinaturas (organization_id, plano_id) values ('${org}', '${plano}')
         on conflict (organization_id) do update set plano_id = excluded.plano_id;`);
}

/** Organização criada pelo servidor (a 0501 recusa INSERT de organização pela sessão). */
export function criarOrg(id: string, slug: string, criadaPor: string | null = null): void {
  sql(`insert into public.organizations (id, slug, legal_name, display_name, created_by)
         values ('${id}', '${slug}', '${slug}', '${slug}', ${criadaPor === null ? "null" : `'${criadaPor}'`})
         on conflict (id) do nothing;`);
}

export function criarUsuarios(usuarios: ReadonlyArray<readonly [id: string, email: string]>): void {
  sql(`insert into auth.users (id, email) values
       ${usuarios.map(([id, email]) => `('${id}', '${email}')`).join(",\n       ")}
       on conflict do nothing;`);
}

export function tornarPlatformAdmin(usuario: string, escopo: "full" | "support_readonly", concedidoPor: string): void {
  sql(`insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
         values ('${usuario}', '${concedidoPor}', '${escopo}', false, 'fixture da cobrança (0510)')
         on conflict do nothing;`);
}

/** INSERT de vínculo ativo, SEM `;` (para erroDe, sessao e writeCountAs). */
export function insercaoDeVinculo(usuario: string, org: string, papel = "agent"): string {
  return `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
    values ('${usuario}', '${org}', '${papel}', now())`;
}

export function vincular(usuario: string, org: string, papel = "agent"): void {
  sql(`${insercaoDeVinculo(usuario, org, papel)};`);
}

export function assentosOcupados(org: string): number {
  return numero(`select count(*) from public.user_organizations
                  where organization_id = '${org}' and revoked_at is null and not provisional_until_handover;`);
}

/** INSERT de canal, SEM `;`. `wacalls` é voz e não conta como número de mensagem. */
export function insercaoDeCanal(id: string, org: string, provider: "waha" | "wacalls" = "waha"): string {
  const sufixo = id.slice(-12);
  return provider === "waha"
    ? `insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
         values ('${id}', '${org}', 'cob-${sufixo}', '\\x00'::bytea)`
    : `insert into public.channel_sessions (id, organization_id, provider, wacalls_session_id, webhook_secret_encrypted)
         values ('${id}', '${org}', 'wacalls', 'wac-${sufixo}', '\\x00'::bytea)`;
}

export function canaisOcupados(org: string): number {
  return numero(`select count(*) from public.channel_sessions
                  where organization_id = '${org}' and archived_at is null and provider <> 'wacalls';`);
}

export function eventos(org: string, tipo: string): number {
  return numero(`select count(*) from public.event_log where organization_id = '${org}' and event_type = '${tipo}';`);
}

/** Sessão psql própria e assíncrona, com SQLSTATE no erro. */
export async function sessao(script: string): Promise<{ ok: boolean; saida: string }> {
  try {
    const { stdout } = await execFileP(
      "docker",
      ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
       "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-tA", "-c", script],
      { encoding: "utf8" },
    );
    return { ok: true, saida: stdout };
  } catch (erro) {
    const e = erro as { stderr?: string; message?: string };
    return { ok: false, saida: e.stderr ?? e.message ?? "" };
  }
}

/**
 * A primeira sessão faz `primeira` e SEGURA a transação por 2 s; a segunda chega
 * 600 ms depois. Sem a trava consultiva do gatilho, as duas contam o mesmo
 * "cabe mais um" e passam juntas.
 */
export async function corrida(primeira: string, segunda: string) {
  const a = sessao(`begin; ${primeira}; select pg_sleep(2); commit;`);
  await new Promise((r) => setTimeout(r, 600));
  const b = sessao(`${segunda};`);
  return Promise.all([a, b]);
}

/** true quando alguma sessão deste banco está parada numa trava consultiva. */
export async function alguemEsperaTravaConsultiva(limiteMs = 5000): Promise<boolean> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const n = numero(`select count(*) from pg_stat_activity
                       where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory';`);
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
