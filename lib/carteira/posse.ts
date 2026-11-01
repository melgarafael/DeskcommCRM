/**
 * A POSSE DO ATENDENTE SOBRE O CLIENTE — a régua ÚNICA do #3746.
 *
 * ─── O defeito que este arquivo fecha ────────────────────────────────────────
 *
 * Duas ações do dia a dia do Atendente estavam travadas em `manager`+:
 *
 *   • escolher o vendedor dono do cliente (`PATCH /api/v1/contacts/[id]/carteira`);
 *   • inscrever o contato num fluxo de follow-up pela conversa
 *     (`POST /api/v1/ai/followups/enrollments`).
 *
 * E é o Atendente quem descobre, na conversa, que o cliente é de outra pessoa —
 * e quem decide começar um follow-up quando o cliente pede para ser lembrado
 * depois. Mandá-lo pedir a um gerente é transformar a regra em espera.
 *
 * ─── O que "liberar para o Atendente" NÃO pode ser ───────────────────────────
 *
 * Baixar o piso para `agent` e parar ali daria a QUALQUER Atendente a carteira
 * de QUALQUER cliente da empresa: ele se poria como dono do cliente de um
 * colega e o negócio seguinte nasceria no nome errado — exatamente o defeito
 * que a carteira (#2591, regra 1/5) existe para consertar. Então a liberação
 * vem com ESCOPO DE POSSE: o Atendente age no cliente que já é dele de alguma
 * forma —
 *
 *   • a conversa está atribuída a ele, ou
 *   • o contato já está na carteira dele.
 *
 * Fora disso, 403 com o motivo escrito. `manager`+ continua podendo tudo, como
 * antes: papel de gerência não tem escopo de posse — quem responde pela equipe
 * inteira responde pela carteira inteira.
 *
 * ─── Por que um arquivo só, e não um `if` copiado em cada rota ───────────────
 *
 * As duas rotas precisam da MESMA resposta, e a TELA precisa dela também (para
 * não desenhar um botão que o servidor recusaria). Três cópias divergem na
 * primeira mudança, e a divergência aqui é silenciosa: a rota A libera o que a
 * rota B recusa, e a tela promete o que as duas negam.
 *
 *   `decidirPosse`  é PURA: papel + dois fatos já apurados, sem banco. É a
 *                   régua, e é o que se testa sem dublê.
 *   `conferirPosse` é a única leitura de banco da régua (contato e conversa) e
 *                   devolve a decisão de `decidirPosse`.
 *   `respostaDaPosse` é a recusa canônica, para as rotas não escolherem status
 *                   nem mensagem por conta própria.
 *
 * A TELA não é a guarda: ela lê o resultado (`pode_alterar` no GET da carteira,
 * `pode_inscrever` no GET dos enrollments), e quem recusa continua sendo o
 * servidor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { roleAtLeast } from "@/lib/auth/types";

/**
 * A recusa de quem não tem posse — a MESMA frase nas duas rotas, traduzida por
 * `traduzir` no idioma da sessão. Ela diz o que fazer, não só que falhou: quem
 * recebe isso é um atendente no meio de um atendimento.
 */
export const MENSAGEM_FORA_DA_POSSE =
  "Este cliente não está com você. Só o atendente da conversa, o dono da carteira ou um gerente pode fazer isso; peça a um gerente para assumir o cliente.";

/** A falha de leitura da régua — nunca vira "não é seu": é "não deu para conferir". */
export const MENSAGEM_POSSE_NAO_CONFERIDA =
  "Não foi possível conferir se este cliente está com você. Nada foi alterado.";

/** Por que a posse foi reconhecida — o motivo vai para o log/audit de quem chamar. */
export type MotivoDaPosse = "papel" | "conversa" | "carteira";

/**
 * O que a régua responde.
 *
 * `pode: false` tem quatro motivos, e cada um é um status diferente na rota —
 * juntá-los num "403" só esconderia um contato inexistente atrás de uma recusa
 * de permissão, que é o tipo de erro que faz o suporte caçar o problema errado.
 */
export type DecisaoDePosse =
  | { pode: true; motivo: MotivoDaPosse }
  | { pode: false; motivo: "fora_da_posse" | "contato_inexistente" | "conversa_inexistente" | "nao_conferida" };

/**
 * A RÉGUA, sem banco: papel + os dois fatos que decidem a posse.
 *
 * O `viewer` é recusado AQUI, e não só pelo piso das rotas: ter o contato na
 * carteira não transforma quem só lê em quem escreve. As duas rotas já cobram
 * `requireRole("agent")`, mas a régua não depende de quem chama ter lembrado.
 */
export function decidirPosse(p: {
  papel: string | null | undefined;
  /** Alguma conversa do contato (ou a conversa em jogo) está atribuída ao ator? */
  donoDaConversa: boolean;
  /** O contato já está na carteira do ator? */
  contatoNaCarteira: boolean;
}): DecisaoDePosse {
  if (roleAtLeast(p.papel, "manager")) return { pode: true, motivo: "papel" };
  // O PISO também é da régua, e não só da rota: um `viewer` que "tem" o contato
  // não escreve nada — ele só lê. As duas rotas já cobram `agent`+, mas a régua
  // não pode depender de quem chama ter lembrado disso.
  if (!roleAtLeast(p.papel, "agent")) return { pode: false, motivo: "fora_da_posse" };
  if (p.donoDaConversa) return { pode: true, motivo: "conversa" };
  if (p.contatoNaCarteira) return { pode: true, motivo: "carteira" };
  return { pode: false, motivo: "fora_da_posse" };
}

/**
 * A posse, apurada no banco e decidida pela régua pura.
 *
 * `db` é o cliente ADMIN (service-role) de propósito: a checagem não pode
 * depender da RLS de `conversations`, que esconde justamente a conversa do
 * colega — e é contra ela que o escopo está sendo medido. Os dois `.eq` com a
 * organização são obrigatórios: service-role não segura nada sozinho.
 *
 * `conversaId` é a conversa EM JOGO, quando a rota tem uma (o POST de
 * enrollment, que nasce dentro da conversa). Sem ela — o PATCH da carteira, que
 * é do CONTATO — qualquer conversa atribuída ao ator serve: quem está
 * atendendo o cliente por um número é dono dele, não importa por qual.
 */
export async function conferirPosse(p: {
  db: SupabaseClient;
  organizationId: string;
  atorId: string;
  papel: string | null | undefined;
  contactId: string;
  conversaId?: string | null;
}): Promise<DecisaoDePosse> {
  // Gerência não tem escopo de posse: as duas leituras abaixo só existem para
  // quem precisa provar que o cliente é dele.
  if (roleAtLeast(p.papel, "manager")) return { pode: true, motivo: "papel" };

  const consultaDaConversa = p.db
    .from("conversations")
    .select("id, assigned_to_user_id")
    .eq("organization_id", p.organizationId)
    .eq("contact_id", p.contactId);
  const conversas = p.conversaId
    ? consultaDaConversa.eq("id", p.conversaId)
    : consultaDaConversa;

  const [{ data: contato, error: erroDoContato }, { data: linhas, error: erroDaConversa }] =
    await Promise.all([
      p.db
        .from("contacts")
        .select("carteira_user_id")
        .eq("id", p.contactId)
        .eq("organization_id", p.organizationId)
        .maybeSingle(),
      conversas,
    ]);

  if (erroDoContato) return { pode: false, motivo: "nao_conferida" };
  if (!contato) return { pode: false, motivo: "contato_inexistente" };
  if (erroDaConversa) return { pode: false, motivo: "nao_conferida" };

  const conversasDoContato = (linhas ?? []) as Array<{ assigned_to_user_id?: string | null }>;
  // Pediram a posse de uma conversa ESPECÍFICA que não é deste contato/empresa:
  // isso é um id errado no payload, não uma recusa de permissão.
  if (p.conversaId && conversasDoContato.length === 0) {
    return { pode: false, motivo: "conversa_inexistente" };
  }

  const carteira = (contato as { carteira_user_id?: string | null }).carteira_user_id ?? null;
  return decidirPosse({
    papel: p.papel,
    donoDaConversa: conversasDoContato.some((c) => c.assigned_to_user_id === p.atorId),
    contatoNaCarteira: carteira === p.atorId,
  });
}

/**
 * A recusa pronta para a rota devolver — status, código e frase no lugar único.
 *
 * `traduzir` vem do chamador (é o `traduzir(texto, idioma)` do dicionário, já
 * amarrado ao idioma da sessão), para este arquivo não importar o dicionário
 * inteiro nem escolher idioma por conta própria.
 */
export function respostaDaPosse(
  decisao: DecisaoDePosse,
  p: { traduzir: (texto: string) => string; requestId: string },
): NextResponse<ApiError> {
  if (decisao.pode) throw new Error("respostaDaPosse chamada com posse reconhecida");

  switch (decisao.motivo) {
    case "contato_inexistente":
      return fail("contact_not_found", p.traduzir("Contato não encontrado nesta empresa."), 404, {
        requestId: p.requestId,
      });
    case "conversa_inexistente":
      return fail(
        "conversation_not_found",
        p.traduzir("Conversa não encontrada para este contato."),
        404,
        { requestId: p.requestId },
      );
    case "nao_conferida":
      return fail("posse_nao_conferida", p.traduzir(MENSAGEM_POSSE_NAO_CONFERIDA), 500, {
        requestId: p.requestId,
      });
    default:
      return fail("fora_da_posse", p.traduzir(MENSAGEM_FORA_DA_POSSE), 403, {
        requestId: p.requestId,
      });
  }
}
