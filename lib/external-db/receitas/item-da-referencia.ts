/**
 * O ITEM DA REFERÊNCIA EXISTE? (Spec 25, R5 — conserto da prova de 10/11/2026).
 *
 * Medido com IA real (gpt-4o-mini, 2 tentativas): o agente montou a referência
 * com um código inventado nas duas (`:1234`, e depois o número de exemplo da
 * descrição da ferramenta). Nenhum dos dois existia no banco de origem, e com o
 * destino configurado o negócio NASCEU apontando para um item que não existe — e
 * o agente disse ao cliente "registrado com sucesso".
 *
 * A forma `<receita>:<id>` não prova nada: aqui o sistema consulta o item pelo
 * id, na mesma receita e com as mesmas regras da listagem (só publicado, sem os
 * escondidos). Achou em alguma instância ativa da organização → vale.
 *
 * A organização vem SEMPRE de quem chama. O cliente de serviço ignora a RLS, então
 * o filtro é explícito — como em `destino-pela-referencia.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { abrirAcesso } from "@/lib/external-db/acesso";
import { ehReferenciaExterna } from "@/lib/leads/referencia-externa";
import { logger } from "@/lib/logger";

import { lerReceitasDoBanco } from "./instancias";
import { receitaDe } from "./registro";

export type ItemDaReferencia =
  | { ok: true }
  | { ok: false; motivo: "item_inexistente" | "indisponivel"; mensagem: string };

const PASSE_PARA_A_EQUIPE =
  "Não abra o negócio por conta própria: chame crm_request_human_handoff e diga ao cliente que a equipe dará continuidade.";

export async function conferirItemDaReferencia(
  admin: SupabaseClient,
  organizationId: string,
  referencia: string,
): Promise<ItemDaReferencia> {
  const inexistente: ItemDaReferencia = {
    ok: false,
    motivo: "item_inexistente",
    mensagem:
      `o item ${referencia} não existe no banco de origem. O código é o campo id de uma linha que ` +
      "crm_consultar_receita devolveu: não invente. Consulte de novo, mostre o item ao cliente com o cód. " +
      "e use esse código. O negócio NÃO foi aberto: não diga ao cliente que registrou o interesse.",
  };
  if (!ehReferenciaExterna(referencia)) return inexistente;
  const separador = referencia.indexOf(":");
  const receitaId = referencia.slice(0, separador);
  const idDoItem = referencia.slice(separador + 1);
  const receita = receitaDe(receitaId);
  if (!receita) return inexistente;

  const { data, error } = await admin
    .from("external_db_connections")
    .select("id, db_type, receitas")
    .eq("organization_id", organizationId)
    .eq("enabled", true);
  const indisponivel: ItemDaReferencia = {
    ok: false,
    motivo: "indisponivel",
    mensagem: `não foi possível conferir o item no banco de origem agora. ${PASSE_PARA_A_EQUIPE}`,
  };
  if (error) return indisponivel;

  // Sem nenhuma consulta que tenha respondido, "não achei" seria mentira: o banco
  // pode estar fora. Só é inexistente quem foi procurado e não estava lá.
  let consultou = false;
  let tentou = false;
  for (const conexao of (data ?? []) as { id: string; db_type: string; receitas: unknown }[]) {
    if (!receita.motores.includes(conexao.db_type as "mysql" | "postgres")) continue;
    const lida = lerReceitasDoBanco(conexao.receitas);
    if (!lida.ok) continue;
    const instancias = lida.instancias.filter((i) => i.ativa && i.receita === receitaId);
    if (instancias.length === 0) continue;
    tentou = true;
    const acesso = await abrirAcesso(admin, organizationId, conexao.id);
    if (!acesso.ok) continue;
    for (const instancia of instancias) {
      try {
        const { sql, valores } = receita.montar(instancia.fixos, receita.parametrosDaBusca.parse({}), 1, idDoItem);
        const resultado = await acesso.dialeto.executarReceita(
          {
            sql,
            valores,
            tabelas: receita.tabelas(instancia.fixos),
            colunasPorTabela: receita.colunas(instancia.fixos),
          },
          { limiteMax: 1 },
        );
        consultou = true;
        if (resultado.linhas.length > 0) return { ok: true };
      } catch (err) {
        // Fonte não liberada, banco fora, fixos que não montam: esta instância não
        // responde. A decisão sai do conjunto — ver `consultou` acima.
        logger.warn("conferencia do item da referencia nao respondeu", {
          organizationId,
          instanciaId: instancia.id,
          erro: err instanceof Error ? err.name : "desconhecido",
        });
      }
    }
  }
  if (tentou && !consultou) return indisponivel;
  return inexistente;
}
