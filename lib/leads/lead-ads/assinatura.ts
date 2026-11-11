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
 * ═══ A IDADE DO SINAL MARCA, E NÃO BARRA (mudou neste commit) ═══════════════
 *
 * A assinatura da Meta (`x-hub-signature-256`) cobre o CORPO e não carrega
 * instante: `sha256=<hex>` do corpo cru, e só. O instante que a Meta manda é o
 * `entry[].time` (epoch em segundos), que está DENTRO do corpo assinado: depois
 * de a assinatura conferir, ele é tão confiável quanto o resto do payload, e é
 * ele que diz a IDADE da entrega.
 *
 * A versão anterior recusava com 401 tudo o que passasse de cinco minutos, e o
 * custo disso está medido na documentação da própria plataforma: ela REENTREGA o
 * que não recebe 2xx, em backoff, por HORAS. Uma instalação fora do ar por dez
 * minutos acordava com uma fila de reentregas assinadas, recusava todas com 401 e
 * perdia o lead DE VEZ — a reentrega seguinte levava outro 401, e o lead nunca
 * mais voltava. A repetição que a janela tentava conter já é contida onde
 * importa: `crm_leads.external_id` + o índice único
 * `uniq_crm_leads_org_source_external` fazem de `leadgen_id` uma chave de
 * idempotência (ver `lib/leads/lead-ads/entrada.ts`), então "o mesmo lead duas
 * vezes" não é um risco que dependa de tempo.
 *
 * O que a janela protegeva de verdade — um corpo capturado na rede e reenviado
 * dias depois — não é resolvido por ela: a assinatura de uma entrega antiga
 * continua válida para sempre. Contra isso, o que sobra e é honesto é o RASTRO:
 * a entrega velha entra marcada, com a idade em segundos na linha de captação e
 * no log, e quem opera vê que ela chegou atrasada em vez de o lead sumir em
 * silêncio.
 *
 * Por isso o 401 fica reservado ao que não tem conserto: assinatura ausente,
 * inválida, ou segredo que não decifra. Idade não é recusa.
 *
 * ─── A idade nos DOIS sentidos ─────────────────────────────────────────────
 *
 * `Math.abs` de propósito: entrega datada no FUTURO também é anômala (relógio de
 * quem gerou o corpo adiantado, ou corpo remontado), e ela é marcada como
 * atrasada do mesmo jeito — o `segundos` sai com o sinal, para o log distinguir
 * "chegou tarde" de "veio do futuro".
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
 * Cinco minutos é o limiar do CARIMBO, não da recusa: até aqui a entrega é
 * "normal" (o retry imediato da plataforma, o atraso de fila); acima disso ela
 * entra do mesmo jeito e a linha de captação diz quanto tempo levou.
 *
 * O valor não vem de configuração de propósito: um limiar configurável por fonte
 * seria um número que alguém ajusta para o log parar de reclamar — e o ajuste não
 * deixaria rastro. E ele não pode ser confundido com permissão de entrada: quem
 * decide se o lead entra é a assinatura e a idempotência.
 */
export const ATRASO_QUE_CONTA_SEGUNDOS = 300;

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

export interface IdadeDoSinal {
  /**
   * Quantos segundos o sinal tem, CONTRA o relógio desta instalação — positivo =
   * chegou atrasado, negativo = datado no futuro. `null` quando o corpo não traz
   * `entry[].time`: sem instante não há idade para medir, e isso NÃO é motivo de
   * recusa (a assinatura é que diz se o corpo é de quem diz ser).
   */
  segundos: number | null;
  /** Passou do limiar (nos dois sentidos). Marca o rastro, não o desfecho. */
  atrasada: boolean;
}

/**
 * A idade da entrega — carimbo, não porteiro.
 *
 * `agora` é parâmetro, e não `Date.now()` escondido, porque um teste de idade que
 * dependesse do relógio da máquina mediria o relógio, não a regra.
 *
 * Nunca recusa: devolver um booleano de recusa aqui convidaria a rota a voltar a
 * tratar idade como entrada proibida, que é exatamente o defeito que esta versão
 * conserta (ver o cabeçalho).
 */
export function idadeDoSinal(
  instanteDoSinal: number | null,
  agora: Date,
  limiarSegundos: number = ATRASO_QUE_CONTA_SEGUNDOS,
): IdadeDoSinal {
  if (instanteDoSinal === null || !Number.isFinite(instanteDoSinal) || instanteDoSinal <= 0) {
    return { segundos: null, atrasada: false };
  }
  const segundos =
    Math.trunc(agora.getTime() / 1000) - Math.trunc(instanteDoSinal);
  return { segundos, atrasada: Math.abs(segundos) > limiarSegundos };
}
