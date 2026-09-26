/**
 * O gatilho "N dias até uma data do funil" (issue #989) — a parte que NÃO fala
 * com o banco.
 *
 * ⚠️ Este módulo não importa NADA — nem fuso, nem env, nem cliente de banco. O
 * schema da API e o editor de regras (que roda no NAVEGADOR) leem a
 * configuração daqui; um `import` de módulo de servidor nesta linha levaria a
 * validação de ambiente para dentro do JavaScript entregue ao cliente.
 *
 * ═══ POR QUE ELE NÃO SE PARECE COM OS OUTROS GATILHOS ═══
 *
 * Todos os outros nascem de um EVENTO: a mensagem chega, a etapa muda, a tag é
 * posta, e o motor (`lib/automation/engine.ts`) reage na mesma hora. Aqui não
 * existe acontecimento nenhum — a data mora no `custom_fields` do lead e o dia
 * em que ela chega passa em silêncio. Quem percebe é o relógio, na varredura
 * `app/api/v1/cron/lead-date-field-due`, e é por isso que a regra precisa guardar
 * mais do que o aniversário guardava: o FUNIL e o CAMPO. O campo pertence a um
 * funil (`pipelines.settings.fields`), e sem essa dupla o cron não sabe onde
 * olhar — nem o operador sabe qual "data de entrega" escolheu.
 *
 * ═══ O CASO QUE MANDA NO DESENHO ═══
 *
 * O ateliê quer avisar 240 dias antes do casamento ("comece o vestido") e cobrar
 * 60 dias depois dele ("confirme a entrega"). Os dois são a MESMA regra de data
 * com `dias` de sinais opostos — daí `dias` ser ASSINADO, e não um "antes/depois"
 * mais um módulo. Quem lê a regra no banco lê a intenção: `dias: -240` é depois
 * da data, `dias: 60` é antes.
 *
 * ═══ UMA VEZ POR LEAD, POR REGRA ═══
 *
 * A varredura roda de hora em hora e o dia inteiro continua sendo o mesmo dia:
 * sem trava, a mensagem do ateliê sairia nove vezes. A trava NÃO tem janela (ao
 * contrário do aniversário, que usa 26h): o mesmo par regra+lead reaparece em N
 * diferentes ao longo da vida do lead, e uma janela deixaria passar a segunda
 * cobrança de um lead antigo. A chave é `regra:lead`.
 */
/** O nome do gatilho no `event_log`, na regra e no rótulo da tela. */
export const GATILHO_DE_DATA_DO_FUNIL = "lead.date_field_due";

/** Dez anos para cada lado da data. Fora disso é dedo no teclado, não regra. */
export const DIAS_MIN = -3650;
export const DIAS_MAX = 3650;

/** O que a regra guarda em `automation_rules.trigger_config`. */
export interface ConfigDoGatilhoDeData {
  /** O funil dono do campo — `pipelines.id`. */
  pipeline_id: string;
  /** A CHAVE do campo de data em `pipelines.settings.fields`, não o rótulo. */
  campo: string;
  /** Dias ATÉ a data. Negativo = depois dela. */
  dias: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})/;
const BRASILEIRA = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * A data do lead em `YYYY-MM-DD`, ou `null` se ali não há data.
 *
 * Aceita as três formas que chegam de verdade: o ISO que o formulário grava, o
 * timestamp de quem passou por API e o `dd/mm/aaaa` de importação/CSV. Aceitar só
 * o ISO seria a falha silenciosa desta feature: a regra existiria, o operador
 * esperaria, e nada aconteceria porque o dado entrou à brasileira.
 *
 * `2026-13-45` e `30/02/2026` são recusados pelo ida-e-volta no calendário — um
 * `Date` os "conserta" sozinho, e data corrigida por engano é pior que data
 * ausente.
 */
function dataDoValor(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();

  const iso = ISO.exec(texto);
  if (iso) {
    const [, ano, mes, dia] = iso;
    if (ano && mes && dia) return dataValida(ano, mes, dia);
  }

  const brasileira = BRASILEIRA.exec(texto);
  if (brasileira) {
    const [, dia, mes, ano] = brasileira;
    if (ano && mes && dia) return dataValida(ano, mes, dia);
  }

  return null;
}

function dataValida(ano: string, mes: string, dia: string): string | null {
  const a = Number(ano);
  const m = Number(mes);
  const d = Number(dia);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const data = new Date(Date.UTC(a, m - 1, d));
  const coerente =
    data.getUTCFullYear() === a && data.getUTCMonth() === m - 1 && data.getUTCDate() === d;
  return coerente ? `${ano}-${mes}-${dia}` : null;
}

/**
 * Soma (ou subtrai) dias a uma data, no calendário.
 *
 * A conta é em UTC de propósito: com o fuso do servidor no meio, um `-240` que
 * caísse sobre a virada de horário de verão moveria a data em um dia — e a
 * mensagem do ateliê sairia na véspera ou no dia seguinte à toa. Entrada que não
 * é data devolve `""`, que não casa com dia nenhum: falha fechada.
 */
export function somarDias(dia: string, dias: number): string {
  const alvo = dataDoValor(dia);
  if (!alvo || !Number.isInteger(dias)) return "";

  const [ano, mes, d] = alvo.split("-").map(Number);
  if (ano === undefined || mes === undefined || d === undefined) return "";
  const base = Date.UTC(ano, mes - 1, d) + dias * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** O dia que a varredura de hoje persegue: o hoje local mais (ou menos) N dias. */
export function diaAlvo(hojeLocal: string, dias: number): string {
  return somarDias(hojeLocal, dias);
}

/**
 * A mesma data escrita à brasileira (`dd/mm/aaaa`) — a forma da importação/CSV.
 *
 * Existe porque a varredura precisa procurar as DUAS formas no banco: o
 * `custom_fields` guarda o que entrou, e o que entrou por planilha está assim.
 * Entrada que não é data devolve `""`, que não casa com nada — falha fechada,
 * como `somarDias`.
 */
export function diaBrasileiro(dia: string): string {
  const alvo = dataDoValor(dia);
  if (!alvo) return "";
  const [ano, mes, d] = alvo.split("-");
  return `${d}/${mes}/${ano}`;
}

/**
 * A data do lead cai hoje, para este N?
 *
 * É a pergunta inteira do gatilho. `dias` conta quanto FALTA até a data, então
 * o dia em que a regra dispara é `hoje + dias`: uma regra de 240 dias antes do
 * casamento pergunta isso em 12/02/2026 e só responde "sim" naquele dia; amanhã
 * o `hoje` já mudou e a mesma data não casa mais — é o que faz a varredura
 * horária emitir uma vez por dia e não a cada hora.
 *
 * O sinal é o mesmo do `trigger_config`: positivo é ANTES da data (o ateliê
 * avisa `240`), negativo é DEPOIS dela (a confirmação é `-60`).
 */
export function casaNaData(valor: unknown, hojeLocal: string, dias: number): boolean {
  const hoje = dataDoValor(hojeLocal);
  const data = dataDoValor(valor);
  if (!hoje || !data || !Number.isInteger(dias)) return false;

  return diaAlvo(hoje, dias) === data;
}

/**
 * O `rule_id` que a varredura carimba no payload — o evento é DIRIGIDO a UMA
 * regra, e não a toda regra do gatilho.
 *
 * Sem isso, duas regras do mesmo gatilho com `dias` diferentes cruzariam: a
 * varredura emite pelo par (negócio, regra) de 240 dias, e a regra de 60 dias
 * também rodaria — porque o motor só enxerga o `event_type` do evento, não de
 * qual regra ele veio. Quem decide o dia é a varredura, então é ela quem diz
 * para quem está falando.
 *
 * Devolve `null` quando não há `rule_id` legível — o caso de TODO outro gatilho,
 * que nasce do banco e não tem regra a apontar; o motor segue o caminho de
 * sempre.
 */
export function regraDoEvento(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = (payload as Record<string, unknown>).rule_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/** A chave do "já disparei": um par regra+lead, sem janela de tempo. */
export function chaveDeDisparo(regraId: string, leadId: string): string {
  return `${regraId}:${leadId}`;
}

/**
 * A MESMA chave com o VALOR da data no meio (#1540) — o rearme.
 *
 * O par `regra:lead` só dispara uma vez na vida do negócio: mudar a data depois
 * do aviso não ressuscitava nada, e a operação perdia o segundo aviso em silêncio
 * (a cobrança de 60 dias depois do casamento nunca saía quando o casamento era
 * remarcado). Com o valor na chave, cada data nova é um episódio novo — e a
 * mesma data continua disparando UMA vez.
 *
 * `valorNormalizado` é o ida-e-volta pelo calendário (`01/05/2026` e
 * `2026-05-01` são o MESMO episódio): sem normalizar, editar só o formato do
 * campo rearmaria o aviso sem mudar a data.
 */
export function chaveDeDisparoComValor(regraId: string, leadId: string, valor: unknown): string {
  return `${regraId}:${leadId}:${valorNormalizado(valor)}`;
}

/** A data em `YYYY-MM-DD`, ou `""` para o que não é data (nunca casa). */
export function valorNormalizado(valor: unknown): string {
  return typeof valor === "string" ? somarDias(valor, 0) : "";
}

/**
 * Tira do lote quem já disparou ESTA regra.
 *
 * O `event_log` devolve os pares (regra, lead) já emitidos; o que sobra é o que
 * a rodada pode emitir agora. Lead já disparado por OUTRA regra de data continua
 * na lista — a trava é por regra, não por lead.
 */
export function naoDisparados(
  leads: readonly string[],
  jaEmitidos: ReadonlySet<string>,
  regraId: string,
): string[] {
  return leads.filter((lead) => !jaEmitidos.has(chaveDeDisparo(regraId, lead)));
}

/**
 * Lê a configuração do gatilho como ela veio do banco (jsonb) ou da tela.
 *
 * Devolve `null` para linha malformada em vez de estourar: a varredura roda para
 * todas as organizações, e uma regra torta não pode derrubar as outras — ela
 * simplesmente não casa. É também o que o schema da API usa para recusar, na
 * criação, o que o operador mandaria errado.
 */
export function configDoGatilhoDeData(bruto: unknown): ConfigDoGatilhoDeData | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;

  const { pipeline_id: pipelineId, campo, dias } = bruto as Record<string, unknown>;
  if (typeof pipelineId !== "string" || !pipelineId.trim()) return null;
  if (typeof campo !== "string" || !campo.trim()) return null;
  if (!Number.isInteger(dias)) return null;

  const n = dias as number;
  if (n < DIAS_MIN || n > DIAS_MAX) return null;

  return { pipeline_id: pipelineId.trim(), campo: campo.trim(), dias: n };
}
