/**
 * A Operação do dia lida PELA SESSÃO — o que a tela e `GET /api/v1/operacao/dia`
 * fazem igual, num lugar só.
 *
 * Os dados vêm do client da SESSÃO: a RLS isola a organização e aplica o
 * escopo de visibilidade da conversa (quem só vê as próprias conversas vê só
 * as próprias aqui também). O único uso do service role é o nome dos donos dos
 * negócios (`fn_nomes_dos_membros`, que a sessão não executa), com a
 * organização da SESSÃO escrita.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { montarOperacaoDoDia, nomesPelaFuncao } from "./operacao-do-dia";
import { diaNoFuso, resolverDia } from "./regras";
import { contextoDaOrganizacao } from "./relatorio-diario";
import type { OperacaoDoDia } from "./tipos";


export async function lerOperacaoDaSessao(
  orgId: string,
  diaBruto: string | null | undefined,
): Promise<{ ok: true; operacao: OperacaoDoDia; hoje: string } | { ok: false; motivo: "dia_invalido" | "dia_no_futuro" }> {
  const db = await createClient();
  const ctx = await contextoDaOrganizacao(db, orgId);
  const agora = new Date();
  const pedido = resolverDia(diaBruto, ctx.fuso, agora);
  if (!pedido.ok) return pedido;
  const operacao = await montarOperacaoDoDia({
    db,
    orgId,
    dia: pedido.dia,
    fuso: ctx.fuso,
    config: ctx.config,
    agora,
    nomesDaEquipe: nomesPelaFuncao(createAdminClient(), orgId),
  });
  return { ok: true, operacao, hoje: diaNoFuso(agora, ctx.fuso) };
}
