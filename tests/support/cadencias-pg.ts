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
