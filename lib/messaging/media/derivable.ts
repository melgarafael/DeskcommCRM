/**
 * Tipos de mensagem cujo conteúdo vira TEXTO antes de o agente responder
 * (áudio → transcrição, imagem → descrição, documento → extração).
 *
 * Vive fora do worker porque duas peças precisam da MESMA resposta e não podem
 * discordar: o worker que deriva e o drain que decide se vale esperar a
 * derivação antes de despachar o turno. Duas listas separadas divergiriam no
 * primeiro tipo novo, e o sintoma seria o agente respondendo "não consigo
 * ouvir" só para um formato.
 */
export const TIPOS_DERIVAVEIS: ReadonlySet<string> = new Set([
  "audio",
  "image",
  "document",
  "video",
]);

/**
 * Estados finais de `messages.media_derived_status` — não há o que esperar.
 *
 * `skipped` é a mídia que o worker desiste de ler DE PROPÓSITO (vídeo com a
 * leitura desligada, que é o padrão; mensagem sem arquivo no storage). Sem ele
 * a linha ficava null para sempre, e o drain — que espera a mídia da CONVERSA —
 * segurava a resposta do texto seguinte até o teto.
 */
export const DERIVACAO_TERMINADA: ReadonlySet<string> = new Set(["ready", "failed", "skipped"]);

/**
 * O texto que substitui a string vazia quando a mídia não pôde ser lida.
 *
 * Não é cosmético: o agente recebe este texto como derivado da mensagem, então
 * ele passa a SABER que chegou algo que não conseguiu interpretar, em vez de
 * concluir que a mensagem veio vazia. A diferença aparece na resposta ao
 * cliente — "não consegui abrir sua foto, pode me dizer o que é?" no lugar de
 * um silêncio que parece descaso.
 *
 * O worker grava este texto também com status `ready` (instalação sem chave de
 * transcrição, por exemplo), então o balão da inbox o compara para não mostrá-lo
 * como se fosse a transcrição. Por isso ele mora aqui, num módulo sem import
 * que pode ir para o cliente, e não no worker.
 */
export const MARCADOR_NAO_LIDA = "[o cliente enviou uma mídia que não consegui interpretar]";

/**
 * Teto de quanto uma resposta pode ESPERAR a derivação terminar.
 *
 * Um número só para as duas pontas que esperam, porque as duas respondem à
 * mesma pergunta ("já dá para responder com o texto?"): o despacho do turno
 * (`lib/agent-engine/edge/crm/drain.ts`) e o turno JÁ EM ANDAMENTO
 * (`lib/agent-engine/agent/espera-da-midia.ts`, #3836). Dois tetos separados
 * divergiriam no primeiro ajuste, e o sintoma seria uma espera que termina antes
 * da outra.
 *
 * Era 45s até 2026-09-03, quando um áudio real levou ~86s para transcrever: o
 * turno estourou o teto, respondeu "não consegui ouvir seu áudio" às 14:25:46,
 * e a transcrição correta só ficou pronta às 14:26:04 — 18s tarde demais, e o
 * cliente teve que digitar a pergunta de novo. Medição de p50/p90/p99 de
 * conclusão da derivação nos últimos 7 dias daquela instalação: 14s / 407s /
 * 2538s — a cauda longa (minutos) é de retry após falha transitória, não da
 * transcrição em si, e nenhum teto razoável a cobre sem o cliente esperando
 * minutos pela primeira resposta. 120s cobre o caso comum de derivação lenta
 * sem impor essa espera longa.
 */
export const TETO_DA_ESPERA_DA_DERIVACAO_MS = 120_000;
