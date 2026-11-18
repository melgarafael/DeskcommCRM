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

// A tradução transporte→rede vem de `./presentation` (também sem estado): o
// aviso não inventa uma segunda tabela para dizer que o canal é Instagram.
import { channelBrand } from "./presentation";

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

/**
 * As colunas que o aviso lê de `channel_sessions`.
 *
 * Mora AQUI, e não na rota, porque uma delas é a coluna do TRANSPORTE
 * (`waha_session_name`) e este é o lado da fronteira que pode nomeá-lo
 * (`docs/doctrine/restricao-de-canal.md`, invariante 1: feature não nomeia
 * provider). Mesmo desenho de `CHANNEL_SESSION_REF_COLUMNS` em `./session-ref`:
 * a lista é do canal, não de quem pergunta. Uma segunda ida ao banco por canal
 * releria a mesma linha, então tudo entra numa consulta só.
 */
// String literal, e NÃO array com `join`: o cliente tipado do Supabase lê o
// tipo do literal para montar o `Row` da consulta — com `string` genérico ele
// devolve `GenericStringError[]` e a conversão para `CanalParaAvaliar` para de
// compilar (TS2352, medido).
export const COLUNAS_DA_SESSAO_NO_AVISO =
  "id, organization_id, status, archived_at, last_status_change_at, metadata, display_name, phone_number, waha_session_name, provider";

/** O que o cron lê de cada conexão. Só isto, e nada de PII. */
export interface CanalParaAvaliar {
  id: string;
  organization_id: string;
  status: string | null;
  archived_at: string | null;
  last_status_change_at: string | null;
  metadata: Record<string, unknown> | null;
  /**
   * O nome que o operador vê em Conexões (`display_name`). Sem ele o aviso diz
   * "este canal" e quem lê pensa no número principal — foi assim que um
   * Instagram em teste virou "o aviso está errado, a IA responde no WhatsApp".
   */
  display_name?: string | null;
  /** O número pareado — segunda escolha de nome, em canal de WhatsApp. */
  phone_number?: string | null;
  /** O nome da sessão no transporte — último recurso antes de "Canal sem nome". */
  waha_session_name?: string | null;
  /** O transporte (`waha`, `meta_cloud`, `zernio`, `zernio_social`, `telegram`, …). */
  provider?: string | null;
  /**
   * Existe agente atendendo este canal — versão publicada presa a ele, vínculo
   * em `ai_agent_version_channels` ou roteador ativo?
   *
   * Obrigatório de propósito: é o que separa os DOIS avisos. Sem agente, o que
   * falta é publicar/ligar o agente; mandar "abra o canal ao público" ali manda
   * a pessoa para o clique que não resolve nada (issue #4909). Quem lê as
   * conexões é o cron, e ele não pode esquecer de perguntar.
   */
  tem_agente: boolean;
}

/**
 * Qual dos dois avisos cabe — e a AÇÃO que cada um oferece.
 *
 * `falta_testador`: o canal já tem agente, só não tem ninguém autorizado a
 * conversar com ele. `sem_agente`: nenhum agente publicado atende o canal, e
 * abrir ao público não muda isso.
 */
export type CasoDoAviso = "falta_testador" | "sem_agente";

export type DesfechoDoCanal =
  /**
   * Ligado, em modo de teste, sem número e assim há dias: o aviso é devido — e
   * ele diz QUAL caso, porque o texto e a saída são diferentes.
   */
  | { acao: "avisar"; diasMudo: number; caso: CasoDoAviso }
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
 * O NOME do canal, como o operador o vê em Conexões.
 *
 * `display_name` primeiro porque é o nome que ele mesmo deu; o número depois
 * (canal de WhatsApp costuma se identificar por ele); o nome da sessão no
 * transporte por último, porque é o menos legível. `null` quando não há nenhum
 * — quem escreve o aviso decide a reserva, no idioma de quem vai ler.
 */
export function nomeDoCanal(canal: CanalParaAvaliar): string | null {
  for (const bruto of [canal.display_name, canal.phone_number, canal.waha_session_name]) {
    const nome = typeof bruto === "string" ? bruto.trim() : "";
    if (nome !== "") return nome;
  }
  return null;
}

/**
 * A REDE do canal — `whatsapp`, `instagram`, `messenger`, `telegram` ou
 * `unknown`.
 *
 * Vem de `channelBrand` e não de uma tabela local: o transporte
 * (`zernio_social` pode ser Instagram, Facebook ou Telegram) não diz a rede, e
 * duas cópias dessa tradução divergem na primeira rede nova. O aviso diz
 * "Instagram", que é o que a pessoa conectou — nunca "zernio_social".
 */
export function redeDoCanal(canal: CanalParaAvaliar): string {
  const plataforma = canal.metadata?.["social_platform"];
  return channelBrand({
    provider: canal.provider ?? null,
    social_platform: typeof plataforma === "string" ? plataforma : null,
  });
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
  if (diasMudo < DIAS_ATE_AVISAR) return { acao: "aguardar" };
  // O caso sai daqui, e não de quem escreve o texto: é a MESMA leitura que
  // decide se o canal responde. Sem agente, "autorize um testador" seria a
  // saída errada, e o aviso mandaria a pessoa para o clique que não resolve.
  return { acao: "avisar", diasMudo, caso: canal.tem_agente ? "falta_testador" : "sem_agente" };
}
