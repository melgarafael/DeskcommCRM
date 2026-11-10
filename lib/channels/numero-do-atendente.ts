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

/**
 * PARA ONDE A CONVERSA CONTINUA (#3732).
 *
 * A recusa da 409 dizia o que fazer ("transfira para você"), mas não dizia para
 * ONDE ir — e no caso que a issue mediu não há o que transferir: a conversa já
 * está no nome de quem tenta responder, presa num número que não é dele, e a
 * conversa viva do contato está no número dele, com outra conversa.
 *
 * Esta é a conversa que continua: a do MESMO contato no número de quem está
 * enviando — exatamente o que impede a conversa antiga de seguir o vendedor
 * (`fn_conversa_que_continua`, migration 9054). Quem decide é o banco, a mesma
 * peça que a adoção usa: duas cópias da regra divergiriam.
 */
export interface ConversaQueContinua {
  /** A conversa nova, a que o atendente deve abrir para responder. */
  id: string;
  /** Quem atende esse número hoje — `null` quando não há nome gravado. */
  nome: string | null;
  /** O número da conversa que continua é o de quem está enviando? */
  propria: boolean;
}

export interface ConversaQueContinuaParams {
  organizationId: string;
  /** A conversa em que o envio foi recusado. */
  conversationId: string;
  /** Quem está enviando. */
  userId: string;
}

type LinhaDaContinua = {
  id: string;
  assigned_to_user_id: string | null;
  assigned_to_user_name: string | null;
};

/**
 * Lê a conversa que continua, para o aviso da recusa.
 *
 * `db` precisa ser o cliente ADMIN: a conversa nova pode estar com outra pessoa,
 * e a RLS de quem envia responde zero linhas justamente no caso em que o aviso
 * mais importa ("continua pelo número de {nome}"). Toda leitura é filtrada pela
 * organização que a rota resolveu do cookie.
 *
 * Falha de leitura devolve `null` — o aviso cai na frase de sempre. O envio já
 * está recusado; um erro aqui não pode virar erro de outra coisa.
 */
export async function conversaQueContinua(
  db: SupabaseClient,
  p: ConversaQueContinuaParams,
): Promise<ConversaQueContinua | null> {
  const { data: alvo, error: erroDoAlvo } = await db.rpc("fn_conversa_que_continua", {
    p_organization_id: p.organizationId,
    p_conversation_id: p.conversationId,
    p_user_id: p.userId,
  });
  if (erroDoAlvo || !alvo) return null;

  const { data: linha, error: erroDaLinha } = await db
    .from("conversations")
    .select("id, assigned_to_user_id, assigned_to_user_name")
    .eq("organization_id", p.organizationId)
    .eq("id", alvo as string)
    .maybeSingle();
  if (erroDaLinha || !linha) return null;

  const conversa = linha as LinhaDaContinua;
  return {
    id: conversa.id,
    nome: conversa.assigned_to_user_name ?? null,
    // Sem dono também é "no seu número": a conversa que continua está sempre
    // num número de quem envia (é assim que `fn_conversa_que_continua` a acha).
    // É o caso da conversa que a IA atende, que a adoção não toma (doc 237, 3-B).
    propria: conversa.assigned_to_user_id === p.userId || conversa.assigned_to_user_id === null,
  };
}

/**
 * A frase do aviso, como MODELO — a interpolação do nome vem DEPOIS da
 * tradução, nos dois lados (servidor e tela). Interpolar antes trocaria a chave
 * do dicionário e o espanhol cairia no português.
 */
export function modeloDaContinua(c: Pick<ConversaQueContinua, "nome" | "propria">): string {
  if (c.propria) {
    return "Esta conversa continua no seu número, em outra conversa do mesmo contato. Abra a conversa para responder.";
  }
  if (c.nome) {
    return "Esta conversa continua pelo número de {nome}, em outra conversa do mesmo contato. Abra a conversa para responder.";
  }
  return "Esta conversa continua em outra conversa do mesmo contato, no número de outro atendente. Abra a conversa para responder.";
}

/** O modelo já traduzido e com o nome de quem atende — o caminho do servidor. */
export function mensagemDaContinua(c: ConversaQueContinua, traduzir: (t: string) => string): string {
  return traduzir(modeloDaContinua(c)).replace("{nome}", c.nome ?? "");
}

/**
 * O que a TELA faz com a recusa do envio (#3732).
 *
 * Pura de propósito: recebe o erro e devolve o que mostrar. O detalhe viaja no
 * corpo da recusa (`details.conversa_que_continua`), então a caixa de resposta
 * trava com o botão certo em vez de repetir a frase genérica que não dizia para
 * onde ir.
 */
export interface AvisoDaContinua {
  conversaId: string;
  /** O modelo em português — quem traduz é a tela (`t`), que é quem sabe o idioma. */
  modelo: string;
  nome: string | null;
}

export function avisoDaContinua(
  codigo: string | undefined,
  detalhes: Record<string, unknown> | undefined,
): AvisoDaContinua | null {
  if (codigo !== CODIGO_NUMERO_DE_OUTRO) return null;
  const bruto = detalhes?.conversa_que_continua;
  if (!bruto || typeof bruto !== "object") return null;
  const c = bruto as { id?: unknown; nome?: unknown; propria?: unknown };
  if (typeof c.id !== "string" || c.id === "") return null;
  const nome = typeof c.nome === "string" ? c.nome : null;
  return {
    conversaId: c.id,
    modelo: modeloDaContinua({ nome, propria: c.propria === true }),
    nome,
  };
}
