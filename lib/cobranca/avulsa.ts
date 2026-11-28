/**
 * A COBRANÇA AVULSA DE UM NEGÓCIO — o lado TypeScript de `cobrancas_avulsas`
 * (migration 9345, issue #4058).
 *
 * Não é a assinatura da instalação (`lib/cobranca/vocabulario.ts`, o que o dono
 * do servidor cobra das empresas): é o que a EMPRESA cobra do cliente DELA,
 * presa ao negócio e/ou à conversa em que a cobrança vai ser enviada.
 *
 * Três coisas moram aqui, e todas são puras de propósito — sem banco, sem rede,
 * sem gateway. A fatia seguinte (envio pela conversa) e o webhook de pagamento
 * consomem este módulo; eles não são pré-requisito dele.
 *
 *   1. `conferirCobranca` — a validação que a rota faz ANTES do insert, e que
 *      devolve o PAYLOAD pronto (snake_case, como a coluna). Erro de digitação
 *      vira 400, não 500 do Postgres.
 *   2. `estadoExibido` — "vencida" DERIVADA. O banco guarda três estados; quem
 *      exibe mostra quatro. Guardar `vencida` criaria duas verdades sobre a
 *      mesma linha (o relógio e a coluna), e a coluna perderia a corrida no
 *      primeiro dia sem régua.
 *   3. `hojeDaEmpresa` — o "hoje" é o da empresa, não o do servidor. VPS em UTC
 *      e cliente em São Paulo discordam por três horas, e às 21h de 31/12 o
 *      vencimento do dia seguinte já estaria vencido.
 */

/** Par de `cobrancas_avulsas.estado` (CHECK da migration 9345). */
export const ESTADOS_DA_COBRANCA = ["pendente", "paga", "cancelada"] as const;
export type EstadoDaCobranca = (typeof ESTADOS_DA_COBRANCA)[number];

/** O que a tela mostra: os três do banco MAIS o derivado. */
export const ESTADOS_EXIBIDOS = ["pendente", "vencida", "paga", "cancelada"] as const;
export type EstadoExibido = (typeof ESTADOS_EXIBIDOS)[number];

/** O que `estadoExibido` precisa da linha. */
export interface LinhaDaCobranca {
  estado: EstadoDaCobranca;
  vencimento: string | null;
}

export const ESTADO_INICIAL: EstadoDaCobranca = "pendente";

/** Teto da descrição: cabe no corpo de uma mensagem com o valor e o vencimento. */
export const DESCRICAO_MAXIMA = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MOEDA = /^[A-Z]{3}$/;

/**
 * O "hoje" no fuso da EMPRESA, como `YYYY-MM-DD`.
 *
 * `en-CA` é o locale que formata em ISO (2026-11-07); o fuso ilegível cai no
 * padrão, como em `formatadorDeData` — fuso é dado de tela, não pré-condição
 * para calcular se uma cobrança venceu.
 *
 * `agora` é injetável para o teste não depender do relógio da máquina.
 */
export function hojeDaEmpresa(fuso: string | null, agora: Date = new Date()): string {
  const formatador = (() => {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: fuso ?? "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }
  })();
  return formatador.format(agora);
}

/**
 * O estado que a tela mostra.
 *
 * "Vencida" NÃO é estado gravado: é `pendente` cujo `vencimento` já passou.
 * A comparação é de STRINGS e é segura porque as duas são `YYYY-MM-DD` de
 * largura fixa — ordem lexicográfica de data ISO é ordem cronológica. Comparar
 * como `Date` traria o fuso de volta para dentro de uma decisão que é de
 * calendário.
 *
 * `vencimento` nulo (cobrança sem prazo combinado) nunca vence: fica `pendente`
 * até alguém dar baixa ou cancelar.
 */
export function estadoExibido(linha: LinhaDaCobranca, hoje: string): EstadoExibido {
  if (linha.estado !== "pendente") return linha.estado;
  if (linha.vencimento === null) return "pendente";
  return linha.vencimento < hoje ? "vencida" : "pendente";
}

/** O que a rota recebe para emitir uma cobrança. */
export interface EntradaDaCobranca {
  descricao: string;
  valorCents: number;
  moeda?: string;
  vencimento?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  createdByUserId?: string | null;
}

/** O payload do INSERT. Nome de coluna, não de tela — a rota não traduz nada. */
export interface CobrancaParaGravar {
  descricao: string;
  valor_cents: number;
  moeda: string;
  vencimento: string | null;
  estado: EstadoDaCobranca;
  lead_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  created_by_user_id: string | null;
}

/**
 * Por que uma cobrança foi recusada. Vocabulário FECHADO: a rota mapeia cada
 * um para uma frase; string livre viraria mensagem de erro improvisada em cada
 * chamada.
 *
 *   sem_ancora        — nem negócio nem conversa: não se sabe de quem cobrar
 *   descricao_vazia   — o cliente abriria a cobrança sem saber do que é
 *   valor_invalido    — zero, negativo, fracionário ou fora do inteiro seguro
 *   moeda_invalida    — não é ISO de três letras maiúsculas
 *   vencimento_invalido — não é data de calendário `YYYY-MM-DD`
 *   id_invalido       — âncora ou contato não é UUID (viraria 22P02 no banco)
 */
export type RecusaDaCobranca =
  | "sem_ancora"
  | "descricao_vazia"
  | "valor_invalido"
  | "moeda_invalida"
  | "vencimento_invalido"
  | "id_invalido";

export type ConferenciaDaCobranca =
  | { ok: true; cobranca: CobrancaParaGravar }
  | { ok: false; motivo: RecusaDaCobranca };

function uuidOuNulo(valor: string | null | undefined): string | null | "invalido" {
  if (valor === null || valor === undefined || valor === "") return null;
  return UUID.test(valor) ? valor : "invalido";
}

/** Data de calendário de verdade: `2026-02-30` casa o regex e não existe. */
function dataDeCalendario(valor: string): boolean {
  if (!ISO_DATE.test(valor)) return false;
  const data = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === valor;
}

/**
 * Confere a entrada e devolve o payload do INSERT — ou o motivo, sem lançar.
 *
 * Não confere TENANT: a organização vem da sessão, nunca do corpo da requisição,
 * e quem recusa âncora de outro tenant é o gatilho
 * `fn_verificar_org_da_cobranca_avulsa` (23514). Duplicar essa decisão aqui
 * criaria uma segunda regra para desencontrar da primeira.
 */
export function conferirCobranca(entrada: EntradaDaCobranca): ConferenciaDaCobranca {
  const descricao = entrada.descricao.trim();
  if (descricao.length === 0 || descricao.length > DESCRICAO_MAXIMA) {
    return { ok: false, motivo: "descricao_vazia" };
  }

  if (!Number.isSafeInteger(entrada.valorCents) || entrada.valorCents <= 0) {
    return { ok: false, motivo: "valor_invalido" };
  }

  const moeda = entrada.moeda ?? "BRL";
  if (!ISO_MOEDA.test(moeda)) return { ok: false, motivo: "moeda_invalida" };

  const vencimento = entrada.vencimento ?? null;
  if (vencimento !== null && !dataDeCalendario(vencimento)) {
    return { ok: false, motivo: "vencimento_invalido" };
  }

  const leadId = uuidOuNulo(entrada.leadId);
  const conversationId = uuidOuNulo(entrada.conversationId);
  const contactId = uuidOuNulo(entrada.contactId);
  const createdByUserId = uuidOuNulo(entrada.createdByUserId);
  if (
    leadId === "invalido" ||
    conversationId === "invalido" ||
    contactId === "invalido" ||
    createdByUserId === "invalido"
  ) {
    return { ok: false, motivo: "id_invalido" };
  }

  // Espelha `cobrancas_avulsas_tem_ancora`: negócio OU conversa. Contato sozinho
  // não basta — é a conversa que dá o canal do envio e o negócio que dá o valor.
  if (leadId === null && conversationId === null) {
    return { ok: false, motivo: "sem_ancora" };
  }

  return {
    ok: true,
    cobranca: {
      descricao,
      valor_cents: entrada.valorCents,
      moeda,
      vencimento,
      estado: ESTADO_INICIAL,
      lead_id: leadId,
      conversation_id: conversationId,
      contact_id: contactId,
      created_by_user_id: createdByUserId,
    },
  };
}
