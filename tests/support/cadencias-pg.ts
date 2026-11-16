/** Fachada canônica; só o relógio entre consultas é controlado. Nenhum resultado
 * de negócio é inventado. Não prova RLS/HTTP Supabase (há casos SQL/UX separados). */
import pg from "pg";
import { pgComoSupabase } from "../pg-como-supabase";
export function novaConexaoDeCadencias(): pg.Client {
  const porta = Number(process.env.TEST_DB_PORT);
  if (!process.env.TEST_DB_CONTAINER || !Number.isInteger(porta) || porta < 1024 || porta > 65535) throw new Error("cadencias_exige_banco_descartavel_do_harness");
  return new pg.Client({ host: "127.0.0.1", port: porta, user: "postgres", password: "postgres", database: "postgres" });
}
export function adminEmConexao(client: pg.Client, hooks: { antes?: (sql: string, valores: unknown[]) => Promise<void>; depois?: (sql: string, valores: unknown[]) => Promise<void> } = {}) {
  const transporte = { query: async (sql: string, valores: unknown[] = []) => {
    await hooks.antes?.(sql, valores);
    const result = await client.query(sql, valores);
    await hooks.depois?.(sql, valores);
    return result;
  } };
  return pgComoSupabase(transporte as unknown as pg.Pool);
}
export function barreira() {
  let liberar!: () => void;
  const promessa = new Promise<void>((r) => { liberar = r; });
  return { promessa, liberar };
}
export async function ateCondicao(condicao: () => Promise<boolean>, mensagem: string) {
  const limite = Date.now() + 5000;
  while (Date.now() < limite) { if (await condicao()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(mensagem);
}

export async function esperarBarreira(b: ReturnType<typeof barreira>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([b.promessa, new Promise<never>((_, rejeitar) => { timer = setTimeout(() => rejeitar(new Error("barreira_de_concorrencia_nao_alcancada")), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Client da SESSÃO de um usuário: cada consulta roda como `authenticated` com o
 * JWT dele, então a RLS decide como no PostgREST. Use uma conexão só para isto:
 * a transação por consulta não pode se intercalar com outra no mesmo client. */
export function sessaoEmConexao(client: pg.Client, userId: () => string) {
  const transporte = { query: async (sql: string, valores: unknown[] = []) => {
    await client.query("begin");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId(), role: "authenticated" })]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, valores);
      await client.query("commit");
      return result;
    } catch (erro) { await client.query("rollback"); throw erro; }
  } };
  return pgComoSupabase(transporte as unknown as pg.Pool);
}

/** Destinatário de um envio da inscrição, na forma que a reserva grava; devolve o
 * id, que é o que o link de descadastro carrega. Para quando o caso não passa
 * pela reserva (inscrição já concluída, empresa desligada). */
export function sqlDestinatarioDaInscricao(inscricao: string): string {
  return `with d as (insert into public.email_cadence_recipients(organization_id,email_hash,contact_id,enrollment_id)
    select e.organization_id, public.fn_cadencia_hash_do_email(e.organization_id, c.email), e.contact_id, e.id
      from public.email_cadence_enrollments e join public.contacts c on c.id=e.contact_id and c.organization_id=e.organization_id
     where e.id='${inscricao}' returning id) select id from d;`;
}
