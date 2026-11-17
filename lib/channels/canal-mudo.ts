/**
 * O CANAL QUE NASCE MUDO NÃO PODE FICAR MUDO EM SILÊNCIO (doc 11, decisão B).
 *
 * Um canal de WhatsApp em **modo de teste** só responde aos números que o
 * operador autorizou. É o padrão, e é o certo: ninguém recebe resposta
 * automática por acidente enquanto a instalação está sendo montada.
 *
 * O problema é o esquecimento, e o sintoma é o pior possível: as mensagens
 * CHEGAM no Inbox, tudo parece funcionar, e a IA simplesmente nunca responde.
 * Quem instalou conclui que o produto está quebrado — não que falta um clique.
 * A tela de Conexões já diz "Nenhum número autorizado — a IA não responde
 * ninguém neste canal"; falta alcançar quem não abre Conexões.
 *
 * Este arquivo é só a REGRA, sem banco e sem rede, porque é ela que precisa de
 * casos: o cron (`app/api/v1/cron/canal-mudo-watcher`) lê as linhas e aplica.
 *
 * ── Por que "alguns dias", e não "agora" ────────────────────────────────────
 *
 * Canal recém-conectado sem número autorizado é o estado NORMAL de quem está no
 * meio do wizard — avisar ali seria ruído no minuto em que a pessoa está
 * trabalhando nisso. O aviso existe para o canal que ficou assim e foi
 * esquecido. Por isso a régua é o tempo desde a última mudança de situação da
 * conexão (`last_status_change_at`), que é quando ela passou a funcionar.
 *
 * ── O laço de retorno (DoD 13) ──────────────────────────────────────────────
 *
 * O aviso se resolve sozinho quando deixa de ser verdade: o canal ganhou número
 * autorizado, saiu do modo de teste, parou de funcionar (aí o assunto é outro,
 * e quem avisa é o `channel-health`) ou foi arquivado. Aviso que só some no
 * clique de alguém vira lista que ninguém lê.
 */

/** O kind do aviso em `agent_inbox_items` (vocabulário fechado por CHECK). */
export const KIND_CANAL_MUDO = "canal_mudo_sem_numero" as const;

/**
 * Quantos dias de canal ligado e mudo antes de avisar.
 *
 * Três dias, e o número é escolha: um dia pegaria quem parou o wizard para
 * almoçar; uma semana é mais que o tempo que uma instalação nova leva para
 * receber a primeira mensagem de cliente de verdade — e o aviso chegaria depois
 * do prejuízo que ele existe para evitar.
 */
export const DIAS_ATE_AVISAR = 3;

/** O que o cron lê de cada conexão. Só isto, e nada de PII. */
export interface CanalParaAvaliar {
  id: string;
  organization_id: string;
  status: string | null;
  archived_at: string | null;
  last_status_change_at: string | null;
  metadata: Record<string, unknown> | null;
}

export type DesfechoDoCanal =
  /** Ligado, em modo de teste, sem número e assim há dias: o aviso é devido. */
  | { acao: "avisar"; diasMudo: number }
  /** Não é (ou deixou de ser) o caso: aviso aberto deste canal se resolve. */
  | { acao: "resolver"; motivo: MotivoDaResolucao }
  /** Ainda é cedo — ou o canal nem está de pé. Não avisa nem resolve. */
  | { acao: "aguardar" };

/**
 * Por que o aviso deixou de valer. O motivo entra no registro da resolução: sem
 * ele, "o operador resolveu" e "o sistema viu que acabou" ficam iguais.
 */
export type MotivoDaResolucao =
  | "ganhou_numero"
  | "saiu_do_modo_de_teste"
  | "canal_arquivado";

/** Os números de teste autorizados, tolerando metadata malformada. */
export function numerosAutorizados(metadata: Record<string, unknown> | null): string[] {
  const bruto = metadata?.["ai_test_phone_numbers"];
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((n): n is string => typeof n === "string" && n.trim() !== "");
}

/**
 * As identidades sociais de teste (Instagram/Facebook, `ai_test_social_identities`),
 * tolerando metadata malformada. Um testador social também faz o canal deixar de
 * ser mudo: a IA responde a alguém.
 */
export function identidadesSociaisAutorizadas(metadata: Record<string, unknown> | null): string[] {
  const bruto = metadata?.["ai_test_social_identities"];
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((n): n is string => typeof n === "string" && n.trim() !== "");
}

/** O canal está no modo de teste? É o `ai_gate` que decide, como no runtime. */
export function emModoDeTeste(metadata: Record<string, unknown> | null): boolean {
  return metadata?.["ai_gate"] === "allowlist";
}

/**
 * A decisão, para UM canal, num instante.
 *
 * Canal que não está `WORKING` não entra em nenhuma das duas pontas: parado ele
 * não responde a ninguém de qualquer jeito, e quem avisa sobre conexão caída é
 * o `channel-health`. Dois avisos para o mesmo silêncio seria a Central
 * disputando com ela mesma a atenção de quem lê.
 */
export function avaliarCanal(canal: CanalParaAvaliar, agora: Date): DesfechoDoCanal {
  if (canal.archived_at !== null) return { acao: "resolver", motivo: "canal_arquivado" };
  if (!emModoDeTeste(canal.metadata))
    return { acao: "resolver", motivo: "saiu_do_modo_de_teste" };
  if (
    numerosAutorizados(canal.metadata).length > 0 ||
    identidadesSociaisAutorizadas(canal.metadata).length > 0
  )
    return { acao: "resolver", motivo: "ganhou_numero" };
  if (canal.status !== "WORKING") return { acao: "aguardar" };

  const desde = canal.last_status_change_at;
  if (desde === null) return { acao: "aguardar" };
  const inicio = new Date(desde).getTime();
  if (Number.isNaN(inicio)) return { acao: "aguardar" };

  const diasMudo = Math.floor((agora.getTime() - inicio) / 86_400_000);
  return diasMudo >= DIAS_ATE_AVISAR ? { acao: "avisar", diasMudo } : { acao: "aguardar" };
}
