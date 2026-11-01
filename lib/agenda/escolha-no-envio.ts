import type { ProtecaoAgenda } from "./protecao-followup";

/**
 * A ESCOLHA DE ENVIO QUANDO O CONTATO TEM HORÁRIO MARCADO (#3813).
 *
 * ═══ O defeito que isto fecha ═══
 *
 * A proteção de agenda (`protecaoDaAgenda`) adia TODO envio automático de quem
 * tem compromisso `pending`/`confirmed`, sem escolha nenhuma: um horário daqui a
 * três meses segura o pós-atendimento, o aniversário e a manutenção. O
 * operador não tem como dizer "neste fluxo, mande mesmo assim" nem "não mande,
 * mas me diga que pulou" — as duas coisas são decisões de PRODUTO que variam
 * por regra e por fluxo.
 *
 * ═══ O vocabulário ═══
 *
 * Uma chave só (`quando_ha_compromisso`) com três valores, na língua da tela:
 *
 *   - `adiar` (PADRÃO): comportamento de hoje, byte a byte. Quem nunca
 *     configurar não vê diferença — é o que a leitura tolerante garante;
 *   - `enviar`: a agenda não segura este envio;
 *   - `nao_enviar`: o envio é PULADO, registrado com o motivo
 *     `compromisso_na_agenda` no mesmo canal dos outros pulos (aba Atividade,
 *     fila do follow-up) — recusa invisível é o que a doutrina do repo proíbe.
 *
 * O precedente é `proteger_pela_agenda` (`automation_rules.trigger_config`): o
 * mesmo assunto já é opt-in por regra, e a leitura daquele booleano é tolerante
 * do mesmo jeito (`booleano()` em `lib/automation/gatilhos-de-tempo.ts`). Este
 * módulo NÃO substitui aquele: `proteger_pela_agenda` decide se o gatilho de
 * tempo gera lembrete; esta escolha decide o que o ENVIO faz quando a agenda
 * acusa compromisso — por isso ela mora no config do passo que envia
 * (`send_whatsapp_message`/`send_ai_message`) e no follow-up publicado, ao lado
 * de `send_window`, e não no gatilho.
 *
 * ═══ Leitura que nunca lança ═══
 *
 * Configuração velha, ausente, `null`, string torta ou objeto de outra versão
 * caem em `adiar` — nunca em erro. Uma regra gravada antes desta entrega não
 * tem a chave, e um `throw` aqui calaria o envio inteiro por causa de um campo
 * que não existe.
 */
export const ESCOLHAS_NO_ENVIO = ["adiar", "enviar", "nao_enviar"] as const;
export type EscolhaNoEnvio = (typeof ESCOLHAS_NO_ENVIO)[number];

/** Sem escolha configurada o comportamento é o de HOJE: adiar. */
export const ESCOLHA_PADRAO: EscolhaNoEnvio = "adiar";

/** A chave, uma só, nas três superfícies (regra, follow-up, tela). */
export const CHAVE_DA_ESCOLHA = "quando_ha_compromisso";

/**
 * O motivo do pulo, no vocabulário que a aba Atividade/fila já usa (snake_case,
 * curto, estável). É ele que aparece no registro do pulo — não uma frase.
 */
export const MOTIVO_DO_PULO = "compromisso_na_agenda";

function ehEscolha(valor: unknown): valor is EscolhaNoEnvio {
  return typeof valor === "string" && (ESCOLHAS_NO_ENVIO as readonly string[]).includes(valor);
}

/**
 * Lê a escolha de um config qualquer (config de ação da regra, config
 * publicada do follow-up). NUNCA lança: o que não for um dos três valores
 * conhecidos vira o padrão.
 */
export function lerEscolhaNoEnvio(bruto: unknown): EscolhaNoEnvio {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return ESCOLHA_PADRAO;
  const valor = (bruto as Record<string, unknown>)[CHAVE_DA_ESCOLHA];
  return ehEscolha(valor) ? valor : ESCOLHA_PADRAO;
}

/** O que o envio faz, dado o que a agenda respondeu e a escolha da regra/fluxo. */
export type DecisaoNoEnvio =
  | { acao: "enviar"; motivo: ProtecaoAgenda["motivo"]; appointment_id: string | null }
  | {
      acao: "adiar";
      motivo: ProtecaoAgenda["motivo"];
      appointment_id: string | null;
      reavaliar_em: string | null;
    }
  | { acao: "pular"; motivo: typeof MOTIVO_DO_PULO; appointment_id: string | null };

/**
 * A decisão do envio, pura.
 *
 * `leitura_indisponivel` continua FECHADO em qualquer escolha: ali não se sabe
 * se há compromisso, e "enviar mesmo assim" é uma resposta sobre um compromisso
 * CONHECIDO — não uma autorização para falar quando a agenda não respondeu.
 * Quem chama segue tratando esse motivo como falha de leitura (o
 * `agenda_read_failed` de sempre), não como adiamento silencioso.
 */
export function decidirNoEnvio(protecao: ProtecaoAgenda, escolha: EscolhaNoEnvio): DecisaoNoEnvio {
  if (!protecao.adiar) {
    return { acao: "enviar", motivo: protecao.motivo, appointment_id: protecao.appointment_id };
  }
  if (protecao.motivo === "leitura_indisponivel" || escolha === "adiar") {
    return {
      acao: "adiar",
      motivo: protecao.motivo,
      appointment_id: protecao.appointment_id,
      reavaliar_em: protecao.reavaliar_em,
    };
  }
  if (escolha === "enviar") {
    return { acao: "enviar", motivo: protecao.motivo, appointment_id: protecao.appointment_id };
  }
  // literal, e não a constante: a cerca motivo-de-parada-tem-frase só lê literais no produtor. O tipo typeof MOTIVO_DO_PULO obriga os dois a baterem.
  return { acao: "pular", motivo: "compromisso_na_agenda", appointment_id: protecao.appointment_id };
}

/**
 * A escolha `nao_enviar` é um PULO, não um adiamento — e um pulo precisa de um
 * tipo próprio para quem chama saber registrar o motivo em vez de tratar o
 * envio como falha (que é o que `AgendaDeferredError` viraria no `catch` de
 * qualquer ação). Mesma forma da irmã: carrega a proteção medida.
 */
export class AgendaPuladoError extends Error {
  constructor(public readonly protection: ProtecaoAgenda) {
    super(`agenda_pulo:${MOTIVO_DO_PULO}`);
    this.name = "AgendaPuladoError";
  }
}
