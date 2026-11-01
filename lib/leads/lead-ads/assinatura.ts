/**
 * A PORTA DO LEAD ADS: assinatura do provedor e janela de entrega — FALHA FECHADA.
 *
 * ═══ O QUE "FALHA FECHADA" QUER DIZER AQUI, EM TRÊS FRASES ═══
 *
 * A rota que usa este módulo é PÚBLICA (o token no path resolve o tenant, mas
 * quem chama não tem sessão). Toda dúvida — cabeçalho ausente, hex de tamanho
 * errado, segredo que não pôde ser lido, entrega sem instante — tem UM desfecho
 * só: nada é processado. Não existe o ramo "sem assinatura configurada, então
 * aceita": esse ramo é o defeito que transforma um endpoint público em porta de
 * entrada de lead falso, e é o mesmo argumento escrito em
 * `lib/webhooks/secrets.ts` ("decrypt que falha retorna null. Quem confere
 * assinatura com o segredo trata null como não dá para conferir e RECUSA").
 *
 * ═══ POR QUE O SEGREDO VAZIO É RECUSADO ANTES DO HMAC ═══
 *
 * HMAC com chave vazia não é "sem assinatura" — é uma assinatura que QUALQUER
 * pessoa calcula. Deixar o `createHmac` rodar com `""` produziria um hex válido
 * que um atacante também produz, e o desfecho seria um 200 processando lead de
 * terceiro. Por isso o teste de segredo ausente vem primeiro e é explícito.
 *
 * ═══ A JANELA: `entry[].time`, E NÃO O CABEÇALHO ═══
 *
 * A assinatura da Meta (`x-hub-signature-256`) cobre o CORPO e não carrega
 * instante: `sha256=<hex>` do corpo cru, e só. Para uma entrega antiga capturada
 * na rede, a assinatura continua válida para sempre — e a idempotência por
 * `leadgen_id` só protege o lead que JÁ entrou. O instante que a Meta manda é o
 * `entry[].time` (epoch em segundos), que está DENTRO do corpo assinado: depois
 * de a assinatura conferir, ele é tão confiável quanto o resto do payload, e é
 * ele que a janela mede.
 *
 * Entrega sem `entry[].time` é recusada: sem instante não há como distinguir
 * reentrega legítima de replay, e "não dá para saber" tem de cair do lado de não
 * processar. O custo dessa escolha está declarado no corpo do PR: se a Meta
 * deixar de mandar `time`, a porta para de aceitar — e para, com 401 e log, que
 * é visível; aceitar sem janela pararia em silêncio.
 *
 * ─── Janela nos DOIS sentidos ───────────────────────────────────────────────
 *
 * `Math.abs` de propósito: entrega do futuro também é anômala (relógio errado de
 * quem forja, ou corpo remontado), e aceitar só o passado deixaria a janela ser
 * contornada por um `time` adiante. Tolerância simétrica é a mesma de qualquer
 * verificação de webhook assinado.
 *
 * Módulo PURO: recebe texto, cabeçalho, segredo e o relógio. Sem rede, sem banco,
 * e sem ler `process.env` — é o que deixa a recusa ser provada sem credencial.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * O cabeçalho da Meta. Mora aqui (e não solto na rota) porque tem dois leitores
 * que precisam concordar byte a byte: a rota que confere e quem depura a
 * integração do outro lado. Renomear invalida a conferência de todo mundo em
 * silêncio — o sintoma seria 401 sem explicação.
 */
export const CABECALHO_DA_ASSINATURA_DA_META = "x-hub-signature-256";

/**
 * Cinco minutos. Curto o bastante para que um corpo capturado não sirva depois,
 * e largo o bastante para o retry do provedor (e o atraso normal de fila) não
 * perder lead legítimo. O valor não vem de configuração de propósito: uma janela
 * configurável por fonte seria uma janela que alguém desliga para "resolver" um
 * 401, e o desligamento não deixaria rastro.
 */
export const JANELA_DA_ENTREGA_SEGUNDOS = 300;

export type RecusaDaAssinatura = "segredo_ausente" | "assinatura_ausente" | "assinatura_invalida";

/**
 * A assinatura confere? `null` = sim; qualquer outra coisa é o MOTIVO da recusa.
 *
 * O motivo é nomeado, e não um booleano, porque os três casos têm donos
 * diferentes: `segredo_ausente` é configuração da instalação (a fonte está sem
 * segredo cadastrado, ou a chave de cifra não está na GUC), `assinatura_ausente`
 * é quem chamou não assinou, e `assinatura_invalida` é assinatura que não
 * confere — o único dos três que pode ser ataque. O log e a resposta carregam a
 * distinção; quem opera não deve caçar ataque quando o problema é a GUC.
 */
export function assinaturaDaMetaConfere(
  corpo: string,
  cabecalho: string | null,
  segredo: string | null,
): RecusaDaAssinatura | null {
  if (segredo === null || segredo.trim() === "") return "segredo_ausente";
  if (cabecalho === null || cabecalho.trim() === "") return "assinatura_ausente";

  const bruto = cabecalho.trim();
  // A Meta manda `sha256=<hex>`. Sem o prefixo não é a assinatura dela — e
  // aceitar hex solto abriria a porta para um formato que nenhum provedor usa.
  const prefixo = "sha256=";
  if (!bruto.toLowerCase().startsWith(prefixo)) return "assinatura_invalida";
  const recebida = bruto.slice(prefixo.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recebida)) return "assinatura_invalida";

  const esperada = createHmac("sha256", segredo).update(corpo, "utf8").digest("hex");
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(recebida, "utf8");
  // `timingSafeEqual` lança em tamanhos diferentes; o regex acima já garante 64
  // caracteres dos dois lados, mas a guarda fica escrita porque um dia o formato
  // muda e o lançamento seria um 500 em vez de uma recusa.
  if (a.length !== b.length) return "assinatura_invalida";
  return timingSafeEqual(a, b) ? null : "assinatura_invalida";
}

export type RecusaDaJanela = "sem_instante" | "fora_de_tempo";

/**
 * O instante do sinal está dentro da janela? `null` = sim; senão, o motivo.
 *
 * `agora` é parâmetro, e não `Date.now()` escondido, porque um teste de janela
 * que dependesse do relógio da máquina mediria o relógio, não a regra.
 */
export function entregaDentroDaJanela(
  instanteDoSinal: number | null,
  agora: Date,
  janelaSegundos: number = JANELA_DA_ENTREGA_SEGUNDOS,
): RecusaDaJanela | null {
  if (instanteDoSinal === null || !Number.isFinite(instanteDoSinal) || instanteDoSinal <= 0) {
    return "sem_instante";
  }
  const diferenca = Math.abs(Math.trunc(agora.getTime() / 1000) - Math.trunc(instanteDoSinal));
  return diferenca > janelaSegundos ? "fora_de_tempo" : null;
}
