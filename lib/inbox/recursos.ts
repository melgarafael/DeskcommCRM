/**
 * Recursos pré-prontos do atendimento (#2833) — o modelo de TEXTO, de IMAGEM ou
 * de ÁUDIO que o operador escolhe num clique dentro do Inbox.
 *
 * O produto de mercado dispara o conteúdo no clique; a issue cobra o oposto:
 * a escolha só PREPARA o compositor. Um recurso de texto cai no campo editável
 * e um de mídia entra na FILA de anexos — é o operador quem decide o instante do
 * envio. Este módulo descreve o dado do recurso e NÃO tem nenhum caminho de
 * envio: quem manda é sempre um clique humano, separado.
 *
 * ── Um caminho só, o mesmo da resposta rápida do `/` ───────────────────────
 *
 * A escolha na barra entrega o recurso ao MESMO `applyTemplate` que o
 * slash-menu (`/`) usa. Não existe plano próprio da barra: um caminho só
 * significa que a mídia do recurso (imagem OU áudio) chega à fila de anexos com
 * prévia e retry pelo caminho que já estava provado, e o texto do corpo entra
 * como legenda da PRIMEIRA mídia — exatamente como o `/` já fazia.
 *
 * O desenho anterior tinha um segundo caminho (o plano que este módulo
 * descrevia), que devolvia só o texto e deixava a mídia para trás: uma resposta
 * rápida COM IMAGEM clicada na barra perdia a imagem. Foi o defeito medido no PR
 * #2847 e o motivo desta troca.
 *
 * ── Um recurso é uma linha de `message_templates` ──────────────────────────
 *
 * Texto mora no `body`; a mídia é uma entrada de `midias` — o MESMO vocabulário
 * de mídia da resposta rápida (#2526), no mesmo bucket privado e gravada pela
 * MESMA rota (`POST /message-templates/:id/midias`). Não existe coluna, bucket
 * nem rota próprios do áudio: era o desenho anterior, e o preço dele era um
 * segundo caminho de mídia ao lado do primeiro.
 *
 * Por isso `tipo` NÃO é campo do modelo: quem responde se o recurso é de áudio
 * é `midiaDeAudioDe`, lendo o CAMINHO do arquivo (que a rota escolheu pelos
 * bytes) — nunca uma coluna que outra escrita pode contradizer.
 */
import { midiaDeAudioDe, type MidiaDeTemplate } from "@/lib/templates/midias";

/**
 * Os tipos de recurso — vocabulário da TELA (o seletor do formulário e o ícone
 * da barra). Não espelha coluna nenhuma do banco de propósito: o que existe no
 * dado é a mídia; o tipo é a LEITURA dela.
 */
export const TIPOS_DE_RECURSO = ["texto", "audio"] as const;
export type TipoDeRecurso = (typeof TIPOS_DE_RECURSO)[number];

/**
 * O subconjunto de `message_templates` que o compositor precisa conhecer — e o
 * contrato que a barra de recursos e o slash-menu COMPARTILHAM: os dois passam o
 * mesmo objeto ao mesmo `applyTemplate`, e é isso que faz a mídia do recurso
 * seguir o caminho já provado da fila de anexos.
 *
 * `midias` é opcional de propósito, pela mesma razão de `MessageTemplate`:
 * linha anterior à migration 0643 (e fixture anterior a ela) chega sem a chave,
 * e a ausência é "recurso de texto".
 */
export interface Recurso {
  id: string;
  title: string;
  body: string;
  midias?: readonly MidiaDeTemplate[] | null;
}

/** O recurso é de ÁUDIO? A resposta sai da mídia, não de uma coluna `tipo`. */
export function ehRecursoDeAudio(recurso: {
  midias?: readonly MidiaDeTemplate[] | null;
}): boolean {
  return midiaDeAudioDe(recurso.midias) !== undefined;
}
