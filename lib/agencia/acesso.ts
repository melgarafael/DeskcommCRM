/**
 * Quem entra na área da agência, e com quais chaves (docs/agencia/SPEC-equipe.md).
 *
 * Mesmo desenho de `requirePlatformAdmin()`: o layout de `/agencia` chama
 * `requireAreaDaAgencia()`, que REDIRECIONA; toda escrita chama
 * `exigirPermissao()`, que LANÇA. A garantia precisa existir nos dois lugares,
 * porque uma server action é alcançável sem passar pelo layout.
 *
 * A decisão em si é pura (`decidirAcessoDaAgencia`), para ser testada sem banco.
 *
 * As tabelas `agencia_*` não têm policy de leitura (só os avisos têm): a linha do
 * membro é lida com o client de serviço, filtrada pelo `user.id` que o
 * `getUser()` acabou de validar — nunca por algo que veio do navegador.
 */
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { somarPermissoes, todasAsPermissoes, type PermissaoDaAgencia } from "./permissoes";

export interface MembroDoContexto {
  id: string;
  nome: string;
  veTodosClientes: boolean;
}

export interface ContextoDaAgencia {
  user: User;
  /** Dono = platform admin `full`: todas as permissões, sem cadastro de membro. */
  ehDono: boolean;
  /** A linha de membro, quando há. O dono pode não ter. */
  membro: MembroDoContexto | null;
  permissoes: ReadonlySet<PermissaoDaAgencia>;
}

export type DecisaoDeAcesso =
  | { tipo: "modulo_desligado" }
  | { tipo: "sem_login" }
  | { tipo: "sem_acesso" }
  | { tipo: "liberado"; ehDono: boolean; permissoes: ReadonlySet<PermissaoDaAgencia> };

export interface FuncaoDoMembro {
  ativa: boolean;
  permissoes: readonly string[];
}

export interface FatosDoAcesso {
  moduloLigado: boolean;
  logado: boolean;
  /** `scope` da linha ativa em `platform_admins`, ou `null` quando não há linha. */
  escopoDeAdmin: string | null;
  /** A linha em `agencia_membros`, quando há. */
  membro?: { situacao: string; funcoes: readonly FuncaoDoMembro[] } | null;
}

/**
 * A regra, sem efeito. A ordem importa: módulo desligado responde 404 antes de
 * qualquer outra coisa, para a área não confirmar que existe.
 */
export function decidirAcessoDaAgencia(f: FatosDoAcesso): DecisaoDeAcesso {
  if (!f.moduloLigado) return { tipo: "modulo_desligado" };
  if (!f.logado) return { tipo: "sem_login" };
  // `support_readonly` lê o painel e nada muda: não é dono da agência.
  if (f.escopoDeAdmin === "full") return { tipo: "liberado", ehDono: true, permissoes: todasAsPermissoes() };
  if (f.membro?.situacao === "ativo") {
    return { tipo: "liberado", ehDono: false, permissoes: somarPermissoes(f.membro.funcoes) };
  }
  return { tipo: "sem_acesso" };
}

interface LinhaDoMembro {
  id: string;
  nome: string;
  situacao: string;
  ve_todos_clientes: boolean;
  agencia_membros_funcoes: Array<{ agencia_funcoes: FuncaoDoMembro | FuncaoDoMembro[] | null }> | null;
}

/** A linha do membro com as funções, pelo id do usuário já validado. */
async function lerMembro(userId: string): Promise<LinhaDoMembro | null> {
  const { data, error } = await createAdminClient()
    .from("agencia_membros")
    .select("id, nome, situacao, ve_todos_clientes, agencia_membros_funcoes(agencia_funcoes(ativa, permissoes))")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    // Falha fechada: sem leitura, sem acesso de membro.
    logger.warn("agência: leitura do membro falhou — tratando como sem acesso", { codigo: error.code });
    return null;
  }
  return (data as LinhaDoMembro | null) ?? null;
}

function funcoesDaLinha(linha: LinhaDoMembro): FuncaoDoMembro[] {
  return (linha.agencia_membros_funcoes ?? []).flatMap((v) => {
    const f = v.agencia_funcoes;
    if (!f) return [];
    return Array.isArray(f) ? f : [f];
  });
}

interface Lido {
  decisao: DecisaoDeAcesso;
  user: User | null;
  membro: MembroDoContexto | null;
}

/** Lê os fatos e decide. Uma vez por requisição (`cache`). */
export const contextoDaAgencia = cache(async (): Promise<Lido> => {
  const ligado = await moduloLigado(createAdminClient(), "agencia");
  if (!ligado) {
    return { decisao: decidirAcessoDaAgencia({ moduloLigado: false, logado: false, escopoDeAdmin: null }), user: null, membro: null };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { decisao: decidirAcessoDaAgencia({ moduloLigado: true, logado: false, escopoDeAdmin: null }), user: null, membro: null };
  }

  // RLS de `platform_admins`: só um platform admin lê a própria linha.
  const [{ data: admin }, linha] = await Promise.all([
    supabase.from("platform_admins").select("scope").eq("user_id", user.id).is("revoked_at", null).maybeSingle(),
    lerMembro(user.id),
  ]);

  const decisao = decidirAcessoDaAgencia({
    moduloLigado: true,
    logado: true,
    escopoDeAdmin: (admin as { scope?: string } | null)?.scope ?? null,
    membro: linha ? { situacao: linha.situacao, funcoes: funcoesDaLinha(linha) } : null,
  });
  const membro =
    linha && linha.situacao === "ativo"
      ? { id: linha.id, nome: linha.nome, veTodosClientes: linha.ve_todos_clientes }
      : null;
  return { decisao, user, membro };
});

/** Para o layout e as páginas: redireciona quem não pode estar aqui. */
export async function requireAreaDaAgencia(): Promise<ContextoDaAgencia> {
  const { decisao, user, membro } = await contextoDaAgencia();
  if (decisao.tipo === "modulo_desligado") notFound();
  if (decisao.tipo === "sem_login" || !user) redirect("/login?next=/agencia");
  if (decisao.tipo === "sem_acesso") redirect("/agencia/sem-acesso");
  return { user, ehDono: decisao.ehDono, membro, permissoes: decisao.permissoes };
}

/** Para uma página que exige uma permissão: quem não tem volta ao início da área. */
export async function requirePermissaoNaPagina(permissao: PermissaoDaAgencia): Promise<ContextoDaAgencia> {
  const ctx = await requireAreaDaAgencia();
  if (!ctx.permissoes.has(permissao)) redirect("/agencia");
  return ctx;
}

export class AcessoDaAgenciaNegado extends Error {
  constructor(
    readonly codigo: "sem_acesso" | "sem_permissao",
    readonly permissao?: PermissaoDaAgencia,
  ) {
    super(codigo === "sem_acesso" ? "Acesso à área da agência negado" : `Permissão necessária: ${permissao}`);
    this.name = "AcessoDaAgenciaNegado";
  }
}

/** Para server actions: LANÇA em vez de redirecionar. */
export async function exigirPermissao(permissao: PermissaoDaAgencia): Promise<ContextoDaAgencia> {
  const { decisao, user, membro } = await contextoDaAgencia();
  if (decisao.tipo !== "liberado" || !user) throw new AcessoDaAgenciaNegado("sem_acesso");
  if (!decisao.permissoes.has(permissao)) throw new AcessoDaAgenciaNegado("sem_permissao", permissao);
  return { user, ehDono: decisao.ehDono, membro, permissoes: decisao.permissoes };
}

/** O contexto de quem está liberado na área, sem exigir permissão — para leituras. `null` = sem acesso. */
export async function contextoLiberado(): Promise<ContextoDaAgencia | null> {
  const { decisao, user, membro } = await contextoDaAgencia();
  if (decisao.tipo !== "liberado" || !user) return null;
  return { user, ehDono: decisao.ehDono, membro, permissoes: decisao.permissoes };
}

/**
 * Para o layout de `/app`: quem é membro ativo da agência e não tem organização
 * vai para `/agencia`. Módulo desligado ou falha de leitura = não é (falha
 * fechada para o lado de seguir o fluxo normal).
 */
export async function ehMembroAtivoDaAgencia(userId: string): Promise<boolean> {
  try {
    if (!(await moduloLigado(createAdminClient(), "agencia"))) return false;
    const linha = await lerMembro(userId);
    return linha?.situacao === "ativo";
  } catch {
    return false;
  }
}
