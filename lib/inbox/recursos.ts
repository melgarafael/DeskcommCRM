/**
 * Recursos pré-prontos do atendimento (#2833) — o modelo de TEXTO ou de ÁUDIO
 * que o operador escolhe num clique dentro do Inbox.
 *
 * O produto de mercado dispara o conteúdo no clique; a issue cobra o oposto:
 * a escolha só PREPARA o compositor. Um recurso de texto cai no campo editável
 * e um de áudio vira anexo PENDENTE — e é o operador quem decide o instante do
 * envio. Este módulo descreve esse "plano" e NÃO tem nenhum caminho de envio:
 * quem manda é sempre um clique humano, separado.
 *
 * Reusa `message_templates` (o mesmo caminho de dados das respostas rápidas),
 * estendido com `tipo` e os campos de mídia pela migration 0662.
 */
import { interpolateTemplate, type TemplateContact } from "@/lib/inbox/template-vars";

/**
 * Os tipos de recurso. Fonte única do vocabulário — espelhada pelo CHECK
 * `message_templates_tipo_check` no banco e coberta por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 */
export const TIPOS_DE_RECURSO = ["texto", "audio"] as const;
export type TipoDeRecurso = (typeof TIPOS_DE_RECURSO)[number];

/**
 * O subconjunto de `message_templates` que o compositor precisa conhecer.
 *
 * `tipo` e os campos de mídia são OPCIONAIS de propósito, pela mesma razão de
 * `MessageTemplate`: linha anterior à migration 0662 (e fixture anterior a ela)
 * chega sem as chaves, e a ausência é "texto" — o default da coluna no banco.
 */
export interface Recurso {
  id: string;
  title: string;
  body: string;
  tipo?: TipoDeRecurso;
  media_path?: string | null;
  media_mime?: string | null;
  media_size_bytes?: number | null;
}

/** Um áudio pronto para virar anexo pendente — descreve, não envia. */
export interface AnexoDeRecurso {
  recursoId: string;
  titulo: string;
  media_path: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
}

/**
 * O que fazer quando o operador clica no recurso. PURO: só descreve o efeito
 * no compositor.
 *
 *   texto → o texto interpolado, que cai no CAMPO (editável) e não é enviado;
 *   áudio → o descritor do anexo PENDENTE, que o operador manda quando quiser.
 *
 * Não existe variante "enviado" de propósito: se um dia aparecer, o teste do
 * "não envia no clique" reprova.
 */
export type PlanoDoRecurso =
  | { tipo: "texto"; texto: string }
  | { tipo: "audio"; anexo: AnexoDeRecurso };

export function ehRecursoDeAudio(recurso: { tipo?: TipoDeRecurso }): boolean {
  return recurso.tipo === "audio";
}

export function planoDoRecurso(recurso: Recurso, contato: TemplateContact): PlanoDoRecurso {
  if (ehRecursoDeAudio(recurso)) {
    return {
      tipo: "audio",
      anexo: {
        recursoId: recurso.id,
        titulo: recurso.title,
        media_path: recurso.media_path ?? null,
        media_mime: recurso.media_mime ?? null,
        media_size_bytes: recurso.media_size_bytes ?? null,
      },
    };
  }
  return { tipo: "texto", texto: interpolateTemplate(recurso.body, contato) };
}
