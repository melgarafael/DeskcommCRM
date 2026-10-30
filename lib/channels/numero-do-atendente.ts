/**
 * DE QUEM É O NÚMERO DESTA CONVERSA — a pergunta que o envio humano faz antes de
 * gravar a mensagem (#3642, doc 237).
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 *
 * Com um número por vendedor (`channel_routing_policies` + os donos em
 * `channel_routing_responsibles`), a conversa tinha o número de UM vendedor e o
 * envio saía sempre pela sessão da conversa. Depois de uma transferência — ou de
 * uma troca de carteira — o vendedor novo respondia pelo WhatsApp do colega: a
 * mensagem saía pelo número do antigo, o cliente recebia a resposta dele ali, e o
 * antigo continuava recebendo as respostas no celular dele.
 *
 * A peça do banco (`fn_numero_da_transferencia` + `fn_conversation_assign`,
 * migration 9039) faz o número SEGUIR o dono na hora da troca. Esta peça fecha o
 * resto: quem TEM número próprio conectado não responde pelo número de outra
 * pessoa — a conversa precisa estar no número dele.
 *
 * ─── Quem não tem número segue respondendo como hoje (doc 237, escolha 1-B) ─
 *
 * A lista "Quem atende cada número" diz quem RECEBE as conversas de um número,
 * não quem pode responder. Um gerente fora da lista e sem número próprio — o
 * caso comum numa empresa com um número só — responde pelo número da conversa
 * como sempre respondeu. A trava existe para o vendedor que tem o próprio
 * WhatsApp e falaria pelo do colega; tirar a resposta de quem não tem número
 * nenhum faria a empresa parar de atender no dia da atualização.
 *
 * "Ter número" é a mesma régua da transferência: um número CONECTADO
 * (`WORKING`, não arquivado, não desativado) do MESMO canal da conversa. Assim,
 * quem a troca de dono não levaria para um número próprio também não é barrado
 * aqui — os dois lados respondem a mesma pergunta.
 *
 * ─── Por que recusar, e não "usar o número da conversa assim mesmo" ─────────
 *
 * O número da sessão é o telefone de uma PESSOA. Responder por ele é falar com o
 * cliente como se fosse ela, com o WhatsApp dela, e é exatamente o defeito que a
 * issue mediu. Entre recusar com uma frase clara ("esta conversa está no número
 * de outro atendente; transfira para você") e mandar a mensagem pelo celular do
 * colega, recusar é o desfecho honesto — e o único que não vaza.
 *
 * ─── Por que a organização sem roteamento por vendedor não muda ─────────────
 *
 * Sem policy no número (`legacy_unconfigured`) ou com a lista de responsáveis
 * vazia (`restricted_empty`), "de quem é o número" não é uma pergunta que a
 * instalação saiba responder — e o comportamento de sempre (todo mundo usa o
 * número da conversa) continua valendo. É o controle: a regra nova só existe
 * onde o produto já diz que cada vendedor tem o seu número.
 *
 * ─── Leitura ────────────────────────────────────────────────────────────────
 *
 * Sem banco na decisão: `vereditoDoNumero` é pura e recebe o quadro pronto. Quem
 * lê as duas tabelas é `quadroDoNumero`. Falha de leitura vira
 * `leitura: "indisponivel"` e o chamador recusa — o caminho do envio falha
 * FECHADO (a doutrina do `_handler`): um erro transitório não pode reabrir o
 * vazamento em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O atendente tem número próprio, mas esta conversa está no de outra pessoa. */
export const CODIGO_NUMERO_DE_OUTRO = "conversa_em_numero_de_outro_atendente" as const;

export type CodigoDoNumero = typeof CODIGO_NUMERO_DE_OUTRO;

/** O que a decisão precisa saber — já lido, sem banco. */
export interface QuadroDoNumero {
  /** O número da conversa está sob roteamento por vendedor (policy com responsáveis)? */
  roteamentoPorVendedor: boolean;
  /** Quem está enviando responde por esse número? */
  atendenteRespondePelaSessao: boolean;
  /** Quem está enviando tem número próprio CONECTADO, do mesmo canal da conversa? */
  atendenteTemNumero: boolean;
}

export type VereditoDoNumero = { ok: true } | { ok: false; codigo: CodigoDoNumero };

/** O quadro de quem não tem o que decidir: instalação sem um número por vendedor. */
const SEM_REGRA_DE_NUMERO: QuadroDoNumero = {
  roteamentoPorVendedor: false,
  atendenteRespondePelaSessao: true,
  atendenteTemNumero: false,
};

/**
 * A resposta, e só ela: pode ou não pode, e por quê.
 *
 * A ordem das perguntas é a regra. `roteamentoPorVendedor` primeiro porque é ela
 * que decide se a regra existe neste número; `atendenteRespondePelaSessao` antes
 * de `atendenteTemNumero` porque o número COMPARTILHADO (a conversa está no
 * número que os dois usam) é o caso legítimo e não pode virar recusa. Quem não
 * tem número próprio responde (doc 237, 1-B).
 */
export function vereditoDoNumero(quadro: QuadroDoNumero): VereditoDoNumero {
  if (!quadro.roteamentoPorVendedor) return { ok: true };
  if (quadro.atendenteRespondePelaSessao) return { ok: true };
  if (!quadro.atendenteTemNumero) return { ok: true };
  return { ok: false, codigo: CODIGO_NUMERO_DE_OUTRO };
}

export type LeituraDoNumero =
  | { leitura: "ok"; quadro: QuadroDoNumero }
  | { leitura: "indisponivel" };

export interface QuadroDoNumeroParams {
  organizationId: string;
  /** A sessão da CONVERSA — o número em que ela está hoje. */
  channelSessionId: string | null;
  /** O canal (`channel_sessions.provider`) da sessão da conversa. */
  provider: string | null;
  /** Quem está enviando (o ator humano). */
  userId: string;
}

type LinhaDeSessao = {
  id: string;
  provider: string | null;
  status: string | null;
  archived_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** A régua de "número conectado" da `fn_numero_da_transferencia`, do lado de cá. */
function conectado(s: LinhaDeSessao, provider: string | null): boolean {
  return (
    s.provider === provider &&
    s.status === "WORKING" &&
    !s.archived_at &&
    String(s.metadata?.disabled ?? "false") !== "true"
  );
}

/**
 * Lê as tabelas do roteamento e devolve o quadro da decisão.
 *
 * Duas idas curtas no caso comum (`channel_routing_policies` sem linha = este
 * número não é de ninguém, e a resposta já está dada). As de "ele tem número
 * próprio conectado?" só acontecem quando a conversa está no número de outra
 * pessoa.
 */
export async function quadroDoNumero(
  db: SupabaseClient,
  p: QuadroDoNumeroParams,
): Promise<LeituraDoNumero> {
  if (!p.channelSessionId) return { leitura: "ok", quadro: SEM_REGRA_DE_NUMERO };

  const { data: policy, error: erroDaPolicy } = await db
    .from("channel_routing_policies")
    .select("id")
    .eq("organization_id", p.organizationId)
    .eq("channel_session_id", p.channelSessionId)
    .maybeSingle();
  if (erroDaPolicy) return { leitura: "indisponivel" };

  // Sem policy no número: a instalação não separa números por vendedor. Nada a
  // decidir, e nada muda no envio.
  if (!policy) return { leitura: "ok", quadro: SEM_REGRA_DE_NUMERO };

  const { data: responsaveis, error: erroDosResponsaveis } = await db
    .from("channel_routing_responsibles")
    .select("user_id")
    .eq("organization_id", p.organizationId)
    .eq("policy_id", policy.id);
  if (erroDosResponsaveis) return { leitura: "indisponivel" };

  const lista = (responsaveis ?? []).map((r) => String((r as { user_id: string }).user_id));
  // Policy sem responsáveis = número em montagem (ou legado da 0228 sem lista):
  // ninguém responde por ele, então a regra de "número de um vendedor" ainda não
  // vale — o comportamento de sempre continua.
  if (lista.length === 0) return { leitura: "ok", quadro: SEM_REGRA_DE_NUMERO };
  if (lista.includes(p.userId)) {
    return {
      leitura: "ok",
      quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: true, atendenteTemNumero: true },
    };
  }

  const fora = (atendenteTemNumero: boolean): LeituraDoNumero => ({
    leitura: "ok",
    quadro: { roteamentoPorVendedor: true, atendenteRespondePelaSessao: false, atendenteTemNumero },
  });

  const { data: meus, error: erroMeus } = await db
    .from("channel_routing_responsibles")
    .select("policy_id")
    .eq("organization_id", p.organizationId)
    .eq("user_id", p.userId);
  if (erroMeus) return { leitura: "indisponivel" };
  const minhasPolicies = (meus ?? []).map((r) => String((r as { policy_id: string }).policy_id));
  if (minhasPolicies.length === 0) return fora(false);

  const { data: politicas, error: erroPoliticas } = await db
    .from("channel_routing_policies")
    .select("channel_session_id")
    .eq("organization_id", p.organizationId)
    .in("id", minhasPolicies);
  if (erroPoliticas) return { leitura: "indisponivel" };
  const minhasSessoes = (politicas ?? []).map((r) =>
    String((r as { channel_session_id: string }).channel_session_id),
  );
  if (minhasSessoes.length === 0) return fora(false);

  const { data: sessoes, error: erroSessoes } = await db
    .from("channel_sessions")
    .select("id, provider, status, archived_at, metadata")
    .eq("organization_id", p.organizationId)
    .in("id", minhasSessoes);
  if (erroSessoes) return { leitura: "indisponivel" };

  return fora(((sessoes ?? []) as LinhaDeSessao[]).some((s) => conectado(s, p.provider)));
}

/** A frase do erro, no idioma de quem está atendendo. */
export const MENSAGEM_DO_NUMERO: Record<CodigoDoNumero, string> = {
  [CODIGO_NUMERO_DE_OUTRO]:
    "Esta conversa está no número de outro atendente, e você tem número próprio. Responda ao cliente pela conversa do seu número, ou peça que esta seja transferida para você.",
};
