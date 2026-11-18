/**
 * OS FLUXOS DE "ETAPA PARADA" QUE ALCANÇAM CADA ETAPA (#3603).
 *
 * ─── Por que este módulo existe (e o que ele NÃO guarda) ───────────────────
 *
 * O acompanhamento por etapa é uma automação: `automation_rules` com
 * `trigger_event = lead.stage_stale` e `trigger_config = { dias, pipeline_id,
 * stage_id, proteger_pela_agenda }` (`configDaEtapaParada`, em
 * `gatilhos-de-tempo.ts`). O PRAZO mora nessa regra e em nenhum outro lugar.
 *
 * A primeira versão desta tela guardava um SEGUNDO prazo, em
 * `organizations.settings.followup_por_etapa`, e mandava nele: a varredura
 * passou a obedecer a tela no lugar das regras. Isso deu dois donos para o mesmo
 * prazo — dois lembretes saíam juntos, um fluxo de 30 dias disparava em 6 h, e a
 * tela podia dizer o contrário do que acontecia. Foi recusado, e com razão.
 *
 * A tela de hoje é uma JANELA para as regras que já existem: lê
 * `automation_rules`, mostra por etapa todos os fluxos que alcançam aquela etapa
 * e grava o prazo NO PRÓPRIO FLUXO. Não há chave paralela, e este módulo é a
 * prova em código disso: não há função que produza um pedido de gravação para
 * algo que não seja o id de uma regra lida do banco.
 *
 * ─── Quem alcança quem ─────────────────────────────────────────────────────
 *
 * A mesma régua da varredura (`app/api/v1/cron/lead-time-triggers`): a regra
 * filtra por `pipeline_id` quando ele existe, e por `stage_id` quando ele
 * existe. Logo, regra sem etapa alcança TODAS as etapas do funil dela; regra sem
 * funil alcança todos os funis. Uma etapa com três fluxos mostra os três — nunca
 * um valor agregado, porque não existe "o prazo da etapa": existe o prazo de
 * cada fluxo.
 *
 * Regra com `trigger_config` que não parseia fica FORA da tela: sem `dias` não há
 * prazo para mostrar, e adivinhar um valor gravaria por cima do que ninguém
 * configurou. Quem conserta é o construtor de fluxos, que é o dono do gatilho.
 */
import { configDaEtapaParada } from "./gatilhos-de-tempo";

/**
 * As ações que carregam TEXTO de mensagem. Onde uma delas existe, a tela linka o
 * construtor do fluxo — o texto não tem campo aqui, nem deve ter: ele é revisado
 * por uma pessoa no fluxo, onde é enviado.
 */
export const ACOES_QUE_LEVAM_TEXTO: readonly string[] = ["send_whatsapp_message", "send_ai_message"];

/** Uma regra como o banco a devolve — só as colunas que esta tela lê. */
export interface RegraDeEtapaParadaCrua {
  id: string;
  name: string | null;
  trigger_config: unknown;
  is_active: boolean | null;
  actions: unknown;
}

/** Um fluxo de etapa parada, do jeito que a tela precisa dele. */
export interface FluxoDeEtapaParada {
  /** `automation_rules.id` — a ÚNICA chave de gravação desta tela. */
  id: string;
  nome: string;
  ativo: boolean;
  /** Dias na mesma etapa, como a regra promete ao motor. */
  dias: number;
  pipelineId: string | null;
  stageId: string | null;
  /** O `trigger_config` cru, para a gravação preservar as outras chaves. */
  config: Record<string, unknown>;
  /** O fluxo manda mensagem? Então a tela linka o construtor em vez de um campo. */
  temMensagem: boolean;
}

/**
 * O prazo que a tela pede para gravar. `regraId` é sempre o id de um fluxo que
 * veio do banco: `pedidosDePrazo` só percorre a lista de fluxos, nunca as chaves
 * do rascunho.
 */
export interface PedidoDePrazo {
  regraId: string;
  dias: number;
}

/** O menor e o maior prazo que a varredura aceita numa regra (1 dia a 10 anos). */
export const DIAS_DA_ETAPA_MIN = 1;
export const DIAS_DA_ETAPA_MAX = 3650;

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/** Lê as regras cruas e devolve só as que têm prazo legível. Nunca lança. */
export function fluxosDaEtapaParada(
  regras: ReadonlyArray<RegraDeEtapaParadaCrua>,
): FluxoDeEtapaParada[] {
  const fluxos: FluxoDeEtapaParada[] = [];
  for (const regra of regras) {
    const config = configDaEtapaParada(regra.trigger_config);
    if (!config) continue;
    const acoes = Array.isArray(regra.actions) ? regra.actions : [];
    fluxos.push({
      id: regra.id,
      nome: regra.name?.trim() || regra.id,
      ativo: regra.is_active === true,
      dias: config.dias,
      pipelineId: config.pipeline_id,
      stageId: config.stage_id,
      config: ehObjeto(regra.trigger_config) ? regra.trigger_config : {},
      temMensagem: acoes.some(
        (acao) => ehObjeto(acao) && ACOES_QUE_LEVAM_TEXTO.includes(String(acao.type)),
      ),
    });
  }
  return fluxos;
}

/**
 * O fluxo alcança esta etapa? A conta é a da varredura, termo a termo: funil
 * vazio alcança todos os funis; etapa vazia alcança todas as etapas do funil.
 */
export function alcancaEtapa(
  fluxo: Pick<FluxoDeEtapaParada, "pipelineId" | "stageId">,
  funilId: string,
  etapaId: string,
): boolean {
  if (fluxo.pipelineId && fluxo.pipelineId !== funilId) return false;
  if (fluxo.stageId && fluxo.stageId !== etapaId) return false;
  return true;
}

/** Todos os fluxos que alcançam a etapa, na ordem em que vieram do banco. */
export function fluxosQueAlcancam(
  fluxos: ReadonlyArray<FluxoDeEtapaParada>,
  funilId: string,
  etapaId: string,
): FluxoDeEtapaParada[] {
  return fluxos.filter((fluxo) => alcancaEtapa(fluxo, funilId, etapaId));
}

function prazoValido(valor: string | undefined, atual: number): number | null {
  if (valor === undefined) return null;
  const texto = valor.trim();
  if (!texto) return null;
  const numero = Number(texto);
  if (!Number.isInteger(numero)) return null;
  if (numero < DIAS_DA_ETAPA_MIN || numero > DIAS_DA_ETAPA_MAX) return null;
  return numero === atual ? null : numero;
}

/**
 * O que o "Salvar" grava — e a garantia de que a tela NÃO cria prazo solto.
 *
 * Percorre os FLUXOS (não o rascunho, que é um mapa por id de etapa na versão
 * antiga da tela). Rascunho cuja chave não é o id de um fluxo lido do banco é
 * ignorado por construção: não há caminho de código que o transforme em
 * gravação. Prazo igual ao que já está na regra também não vira escrita — salvar
 * sem mexer não faz N requisições.
 */
export function pedidosDePrazo(
  rascunhos: Readonly<Record<string, string>>,
  fluxos: ReadonlyArray<FluxoDeEtapaParada>,
): PedidoDePrazo[] {
  const pedidos: PedidoDePrazo[] = [];
  for (const fluxo of fluxos) {
    const dias = prazoValido(rascunhos[fluxo.id], fluxo.dias);
    if (dias === null) continue;
    pedidos.push({ regraId: fluxo.id, dias });
  }
  return pedidos;
}

/**
 * O corpo do PATCH: o `trigger_config` da regra com o prazo trocado.
 *
 * Copia o jsonb gravado em vez de remontar `{dias, pipeline_id, stage_id,
 * proteger_pela_agenda}`: chave que a regra tenha e este módulo não conheça
 * (uma opção nova do gatilho) sobrevive à edição do prazo. `dias` é o único campo
 * que a tela toca — o texto da mensagem continua no fluxo.
 */
export function configComNovoPrazo(
  config: Readonly<Record<string, unknown>>,
  dias: number,
): Record<string, unknown> {
  return { ...config, dias };
}
