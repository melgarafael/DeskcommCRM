/**
 * PREFERÊNCIA E REGRA DO LEMBRETE DE TAREFA (#2529).
 *
 * A tarefa vencida só aparecia em vermelho para quem ABRIA a lista de tarefas.
 * Quem não abria perdia o prazo em silêncio — e o silêncio é o defeito caro:
 * "retorno combinado com o cliente passa do prazo sem aviso" é contrato
 * furado, não cosmética.
 *
 * ═══ AS DUAS CATEGORIAS ═══
 *
 *   `task_due`     — falta pouco para vencer (a janela que a pessoa escolheu);
 *   `task_overdue` — venceu sem conclusão.
 *
 * As duas são categoria de NOTIFIFICAÇÃO, e não status de tarefa: o status
 * continua sendo `pending`/`in_progress`/`done`/`cancelled`
 * (`lib/tarefas/tipos.ts`, amarrado ao CHECK da migration 0210 pelo invariante
 * `vocabulario-banco-x-typescript`). Aqui só se decide QUANDO um prazo pede
 * gente.
 *
 * ═══ POR QUE A PREFERÊNCIA VIVE NO METADATA DA PESSOA ═══
 *
 * As categorias de notificação da tela (`lib/notifications/prefs.ts`) moram no
 * `localStorage` — são por NAVEGADOR, e decidem se a aba aberta faz toast e
 * bandeja. Este aviso é o oposto: nasce num cron, com o site fechado, e tem de
 * chegar a quem não abriu nada. O cron não lê `localStorage` de ninguém, então a
 * escolha da pessoa precisa estar no servidor, por PESSOA: `raw_user_meta_data`,
 * o mesmo sítio onde o perfil grava idioma e fuso
 * (`app/actions/settings/updateProfile.ts`). Sem migration, por pessoa (não por
 * navegador), e legível por `service_role` na varredura.
 *
 * ═══ O METADATA É DADO ALHEIO ═══
 *
 * `lerPreferenciaDeLembrete` nunca lança e nunca devolve menos que o padrão:
 * valor torto volta ao padrão DAQUELE campo. Um `antecedencia_min` de 45 (que a
 * tela não oferece) virar "nunca avisa" seria o mesmo silêncio que esta feature
 * veio consertar, uma camada acima.
 */

import { z } from "zod";

/**
 * As duas categorias, na ordem em que a tela as mostra.
 *
 * Estes são TAMBÉM os `kind` do aviso na Central (`agent_inbox_items.kind`,
 * migration 0655) e os rótulos de `lib/ai/agent-inbox-copy.ts` — um vocabulário
 * só, para o aviso da Central e a regra que o produz falarem o mesmo nome.
 */
export const TIPOS_DE_AVISO_DE_TAREFA = ["task_due", "task_overdue"] as const;
export type TipoDeAvisoDeTarefa = (typeof TIPOS_DE_AVISO_DE_TAREFA)[number];

/**
 * As antecedências que a tela oferece, em minutos: 15 min, 1 h, 1 dia.
 *
 * Lista fechada de propósito: o valor vira também a janela da varredura do
 * cron, e uma antecedência de "37 minutos" que ninguém pode escolher na tela
 * só existe como origem de confusão. Fora da lista, `lerPreferenciaDeLembrete`
 * volta ao padrão.
 */
export const ANTCEDENCIAS_DE_TAREFA_MIN = [15, 60, 1440] as const;
export type AntecedenciaDaTarefa = (typeof ANTCEDENCIAS_DE_TAREFA_MIN)[number];
export const ANTCEDENCIA_PADRAO_MIN = 60;

/** Onde a preferência é gravada no `raw_user_meta_data` da pessoa. */
export const CHAVE_DA_PREFERENCIA = "lembretes_de_tarefa";

export interface PreferenciaDeLembrete {
  /** Aviso quando falta pouco para vencer. */
  task_due: boolean;
  /** Aviso quando vence sem conclusão — nasce desligado (repetição é opt-in). */
  task_overdue: boolean;
  /** De quanto tempo o `task_due` avisa, em minutos. */
  antecedencia_min: AntecedenciaDaTarefa;
  /** WhatsApp para o número do responsável — OPCIONAL, nasce desligado. */
  whatsapp: boolean;
  /** O número que a pessoa própria deixou para receber o aviso. */
  whatsapp_numero: string | null;
}

/**
 * O padrão do produto: avisa 1 h antes; não repete em vencida; não manda
 * WhatsApp. Cada um dos três é uma decisão, e as três são opt-in — notificação
 * que ninguém pediu é a que ensina a ignorar a Central.
 */
export function preferenciaPadraoDeLembrete(): PreferenciaDeLembrete {
  return {
    task_due: true,
    task_overdue: false,
    antecedencia_min: ANTCEDENCIA_PADRAO_MIN, // literal de `AntecedenciaDaTarefa`, pela constante tipada
    whatsapp: false,
    whatsapp_numero: null,
  };
}

export function ehAntecedenciaValida(min: unknown): min is AntecedenciaDaTarefa {
  return typeof min === "number" && (ANTCEDENCIAS_DE_TAREFA_MIN as readonly number[]).includes(min);
}

/**
 * O que a action de gravar aceita (Server Action é endpoint público: o tipo do
 * parâmetro não chega ao servidor). Mora AQUI, e não na action, porque um
 * arquivo "use server" só pode exportar função async — exportar a schema de lá
 * derrubava o módulo inteiro no `next start` (prova pela tela do #2809).
 */
export const preferenciaDeLembreteSchema = z.object({
  task_due: z.boolean(),
  task_overdue: z.boolean(),
  /** As três que a tela oferece — a MESMA régua que a varredura aceita. */
  antecedencia_min: z.number().refine(ehAntecedenciaValida),
  whatsapp: z.boolean(),
  /** O número que a PESSOA deixa para receber o aviso no WhatsApp — o dela. */
  whatsapp_numero: z
    .string()
    .trim()
    .regex(/^[0-9]{8,15}$/, "whatsapp_numero_invalido")
    .nullable(),
});

function booleanoOuPadrao(valor: unknown, padrao: boolean): boolean {
  return typeof valor === "boolean" ? valor : padrao;
}

function numeroOuPadrao(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo ? limpo : null;
}

/**
 * Lê a preferência gravada no `raw_user_meta_data` — com tolerância total.
 *
 * O insumo é o objeto inteiro de metadata (`user_metadata`), não a chave: o
 * cron lê a pessoa uma vez e tira daqui só o que interessa. Qualquer forma que
 * a chave não tome devolve o padrão campo a campo.
 */
export function lerPreferenciaDeLembrete(metadata: unknown): PreferenciaDeLembrete {
  const padrao = preferenciaPadraoDeLembrete();
  if (typeof metadata !== "object" || metadata === null) return padrao;
  const cru = (metadata as Record<string, unknown>)[CHAVE_DA_PREFERENCIA];
  if (typeof cru !== "object" || cru === null) return padrao;
  const p = cru as Record<string, unknown>;
  return {
    task_due: booleanoOuPadrao(p.task_due, padrao.task_due),
    task_overdue: booleanoOuPadrao(p.task_overdue, padrao.task_overdue),
    antecedencia_min: ehAntecedenciaValida(p.antecedencia_min) ? p.antecedencia_min : padrao.antecedencia_min,
    whatsapp: booleanoOuPadrao(p.whatsapp, padrao.whatsapp),
    whatsapp_numero: numeroOuPadrao(p.whatsapp_numero),
  };
}

/** O recorte de `crm_tasks` que a régua examina. */
export interface TarefaDeLembrete {
  due_date: string | null;
  status: string;
}

/**
 * Qual aviso esta tarefa pede AGORA — `null` = nenhuma.
 *
 * A ordem das duas perguntas é a régua: vencimento primeiro. Quem já passou do
 * prazo recebe o aviso de vencimento, e não o de antecedência atrasado (que
 * diria "falta pouco" para algo que já venceu — mentira impressa). E vencida
 * NÃO recai em `task_due`: os dois avisos não empilham sobre a mesma tarefa.
 *
 * Situações que nunca avisam, e por quê:
 *
 *   - `done`/`cancelled` — não há prazo a perder; avisar sobre tarefa concluída
 *     é o ruído que faz a pessoa desligar a categoria inteira;
 *   - sem `due_date` — a tarefa não tem prazo, e "perto do vencimento" de algo
 *     sem data não é pergunta que tenha resposta;
 *   - data ilegível — nunca lança: a varredura é de TODAS as organizações, e
 *     uma linha torta não pode derrubar a rodada das outras (a mesma régua de
 *     `vesperaNoDiaDaMarcacao`, no lembrete de compromisso).
 */
export function decidirLembreteDeTarefa(
  tarefa: TarefaDeLembrete,
  agora: Date,
  preferencia: PreferenciaDeLembrete,
): TipoDeAvisoDeTarefa | null {
  if (!tarefa.due_date) return null;
  if (tarefa.status === "done" || tarefa.status === "cancelled") return null;
  const vence = new Date(tarefa.due_date);
  if (Number.isNaN(vence.getTime())) return null;

  const antecedencia = ehAntecedenciaValida(preferencia.antecedencia_min)
    ? preferencia.antecedencia_min
    : ANTCEDENCIA_PADRAO_MIN;

  if (agora.getTime() >= vence.getTime()) {
    return preferencia.task_overdue ? "task_overdue" : null;
  }
  if (vence.getTime() - antecedencia * 60_000 <= agora.getTime()) {
    return preferencia.task_due ? "task_due" : null;
  }
  return null;
}

/** Por que o WhatsApp deste lembrete não vai sair — `null` quando vai. */
export type MotivoDePularWhatsapp =
  | "whatsapp_desligado"
  | "sem_canal"
  | "sem_telefone"
  | "sem_contato";

export interface DecisaoDeWhatsatsapp {
  enviar: boolean;
  motivo: MotivoDePularWhatsapp | null;
}

/**
 * O canal OPCIONAL, decidido ANTES de qualquer consulta (#2529).
 *
 * A guarda que a issue pede é esta: sem opt-in, ou sem sessão de canal da
 * organização, o cron NÃO TENTA — não resolve telefone, não abre conversa, não
 * chama a API do provedor. Tentar e falhar depois custa o mesmo que tentar de
 * verdade para quem olha o log, e deixa a dúvida de por que o número do
 * provedor apareceu.
 *
 * A ordem dos motivos é a ordem de barateamento: o que decide sem consulta
 * (`whatsapp_desligado`, `sem_canal`) vem antes dos que dependem de banco.
 */
export function decidirWhatsappDoLembrete(input: {
  pref: PreferenciaDeLembrete;
  /** A organização tem sessão de canal capaz de mandar mensagem? */
  temCanal: boolean;
  /** A pessoa deixou número para receber no WhatsApp. */
  temTelefone: boolean;
  /** Esse número existe como contato da própria organização. */
  temContato: boolean;
}): DecisaoDeWhatsatsapp {
  if (!input.pref.whatsapp) return { enviar: false, motivo: "whatsapp_desligado" };
  if (!input.temCanal) return { enviar: false, motivo: "sem_canal" };
  if (!input.temTelefone) return { enviar: false, motivo: "sem_telefone" };
  if (!input.temContato) return { enviar: false, motivo: "sem_contato" };
  return { enviar: true, motivo: null };
}

/**
 * O texto do PUSH — sem dado de cliente, pelo mesmo motivo do push da Central.
 * O item da Central usa só o `corpo` (o nome da tarefa) como título: lá o
 * rótulo traduzido do kind já diz o que aconteceu (doc de decisão 162).
 */
export function textoDoAvisoDeTarefa(
  categoria: TipoDeAvisoDeTarefa,
  tarefa: { title: string },
): { titulo: string; corpo: string } {
  const titulo = tarefa.title.trim();
  return categoria === "task_due"
    ? { titulo: "Uma tarefa está perto do vencimento", corpo: titulo }
    : { titulo: "Uma tarefa venceu sem conclusão", corpo: titulo };
}
