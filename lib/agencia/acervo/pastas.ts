/**
 * A estrutura de pastas do acervo (docs/agencia/SPEC-acervo.md, A3–A4).
 *
 * `Clientes/<Nome do cliente>/` com as 8 subpastas fixas. Tudo aqui é
 * idempotente e NUNCA lança: sem Drive conectado, cada função devolve `false` e
 * o cadastro do cliente segue (A6).
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { compartilhar, criarPasta, estadoDoDrive, renomear, retirarCompartilhamento } from "./drive";

export const SUBPASTAS = [
  "01 Formulário",
  "02 Contrato e proposta",
  "03 Planejamento",
  "04 Identidade visual",
  "05 Captações",
  "06 Edições",
  "07 Artes",
  "08 Relatórios",
] as const;
export type Subpasta = (typeof SUBPASTAS)[number];

export function ehSubpasta(v: string): v is Subpasta {
  return (SUBPASTAS as readonly string[]).includes(v);
}

/** Nome da pasta do cliente: sem barra (o Drive aceita, mas confunde quem lê). */
export function nomeDaPasta(nome: string): string {
  return nome.replace(/[\\/]+/g, "-").trim().slice(0, 120) || "Cliente";
}

/** A pasta raiz "Clientes". Cria na primeira vez. */
export async function garantirPastaRaiz(): Promise<string | null> {
  const estado = await estadoDoDrive();
  if (!estado.conectado) return null;
  if (estado.pastaRaizId) return estado.pastaRaizId;
  const r = await criarPasta("Clientes", null);
  if (!r.ok) return null;
  await createAdminClient().from("agencia_drive").update({ pasta_raiz_id: r.valor.id }).eq("id", true);
  return r.valor.id;
}

/**
 * A pasta do cliente e as subpastas que faltarem. Com `renomear`, ajusta o nome
 * da pasta ao nome atual do cliente. Devolve `true` quando a estrutura está completa.
 */
export async function garantirPastasDoCliente(clienteId: string, opcoes: { renomear: boolean }): Promise<boolean> {
  try {
    const raiz = await garantirPastaRaiz();
    if (!raiz) return false;
    const db = createAdminClient();
    const { data } = await db
      .from("agencia_clientes")
      .select("nome, drive_pasta_id, drive_subpastas")
      .eq("id", clienteId)
      .maybeSingle();
    const c = data as { nome: string; drive_pasta_id: string | null; drive_subpastas: Record<string, string> | null } | null;
    if (!c) return false;

    let pasta = c.drive_pasta_id;
    if (!pasta) {
      const r = await criarPasta(nomeDaPasta(c.nome), raiz);
      if (!r.ok) return false;
      pasta = r.valor.id;
    } else if (opcoes.renomear) {
      await renomear(pasta, nomeDaPasta(c.nome));
    }

    const subpastas: Record<string, string> = { ...(c.drive_subpastas ?? {}) };
    for (const nome of SUBPASTAS) {
      if (subpastas[nome]) continue;
      const r = await criarPasta(nome, pasta);
      if (!r.ok) break;
      subpastas[nome] = r.valor.id;
    }
    await db.from("agencia_clientes").update({ drive_pasta_id: pasta, drive_subpastas: subpastas }).eq("id", clienteId);
    return SUBPASTAS.every((n) => subpastas[n]);
  } catch (e) {
    logger.warn("agência: pastas do cliente não ficaram prontas", {
      detalhe: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/** "Criar pastas que faltam": todo cliente sem estrutura completa. */
export async function garantirPastasDeTodos(): Promise<{ prontos: number; falharam: number }> {
  const { data } = await createAdminClient().from("agencia_clientes").select("id, drive_subpastas");
  let prontos = 0;
  let falharam = 0;
  for (const c of (data ?? []) as Array<{ id: string; drive_subpastas: Record<string, string> | null }>) {
    const completa = SUBPASTAS.every((n) => c.drive_subpastas?.[n]);
    if (completa) {
      prontos++;
      continue;
    }
    if (await garantirPastasDoCliente(c.id, { renomear: false })) prontos++;
    else falharam++;
  }
  return { prontos, falharam };
}

/**
 * Compartilha a pasta raiz com a equipe ativa (A4): `writer` para quem gerencia
 * clientes, `reader` para os demais. Membro desativado perde o acesso.
 */
export async function sincronizarCompartilhamento(): Promise<void> {
  const raiz = await garantirPastaRaiz();
  if (!raiz) return;
  const { data } = await createAdminClient()
    .from("agencia_membros")
    .select("email, situacao, agencia_membros_funcoes(agencia_funcoes(ativa, permissoes))");
  type Funcao = { ativa: boolean; permissoes: string[] };
  for (const m of (data ?? []) as unknown as Array<{
    email: string;
    situacao: string;
    agencia_membros_funcoes: Array<{ agencia_funcoes: Funcao | Funcao[] | null }> | null;
  }>) {
    if (m.situacao === "ativo") {
      const funcoes = (m.agencia_membros_funcoes ?? []).flatMap((f) =>
        !f.agencia_funcoes ? [] : Array.isArray(f.agencia_funcoes) ? f.agencia_funcoes : [f.agencia_funcoes],
      );
      const gerencia = funcoes.some((f) => f.ativa && f.permissoes.includes("clientes.gerenciar"));
      await compartilhar(raiz, m.email, gerencia ? "writer" : "reader");
    } else if (m.situacao === "desativado") {
      await retirarCompartilhamento(raiz, m.email);
    }
  }
}
