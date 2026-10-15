/**
 * Detector determinístico de PROMESSA DE RETORNO DO PRÓPRIO ASSISTENTE (issue #2916) —
 * o sinal LÉXICO que faltava ao `casePromiseGate`.
 *
 * ## O defeito medido (issue #2916, emersonraza, 2026-10-14)
 *
 * O cliente pede "pode ser daqui a duas horas" e o agente responde "Combinado, retomamos
 * daqui a duas horas." — SEM chamar nenhuma ferramenta no turno. O cliente fica esperando
 * uma mensagem que não vem. Medido pelo autor, mesmo prompt: **3 de 11 execuções** do
 * cenário, apesar da regra explícita no prompt ("a primeira ferramenta do turno é
 * crm_schedule_followup; escreva a resposta só depois que ela confirmar").
 *
 * ## Por que as camadas existentes não pegam
 *
 * O `casePromiseGate` (`before-send.ts`) já cobre a promessa de retorno do assistente
 * desde o #1873: ele libera "a promessa de retorno do próprio assistente" só quando há
 * `schedule_followup` agendado no turno (`followup.agendadoNesteTurno`). O problema é o
 * SINAL que a marcava: era só o SEMÂNTICO (`semantic.ts` → `retornoSoDoAssistente`), e o
 * classificador é um modelo — ele varia entre execuções e não marca "retomamos daqui a
 * duas horas" de forma confiável (não é "alguém da empresa volta a falar", por isso a
 * pergunta 2 não a considera `prometeuRetornoHumano`). O detector LÉXICO de humano
 * (`detectHumanPromise`) também não a pega: ela não nomeia alvo humano nenhum.
 * Resultado: as duas camadas deixam passar, e a frase sai sem destino.
 *
 * Este módulo é o sinal que faltava, na família do `detectHumanPromise`: uma regex PT-BR
 * que reconhece a frase em que o ASSISTENTE se compromete a RETOMAR A CONVERSA. O
 * `casePromiseGate` o consome em OU com o semântico, e SEMPRE subordinado a
 * `followup.agendadoNesteTurno` — sem follow-up agendado, é veto com ensino (o modelo
 * chama `schedule_followup` ou reformula).
 *
 * ## Conservador de propósito — vocabulário MÍNIMO (medido)
 *
 * Mesma disciplina do `human-promise.ts`: na dúvida entre falso-positivo e falso-negativo,
 * o gate prioriza NÃO vetar texto legítimo (veto é bloqueio de envio). Por isso o
 * vocabulário cobre só a família MEDIDA — verbos de RETOMAR A CONVERSA em 1ª pessoa, do
 * que o próprio assistente faz — e deliberadamente NÃO inclui:
 *
 *   - "te retorno" / "te dou um retorno" / "te retorno com a proposta": é a promessa de
 *     retorno de CONTEÚDO que o classificador semântico já cobre (`prometeuRetornoHumano`),
 *     e cuja inclusão aqui reabriria o que `tests/unit/cerca-prometer-de-ponta-a-ponta.test.ts`
 *     congela (as cinco frases que vazam SEM a camada semântica seguem vazando);
 *   - "te aviso" sozinho: é o território do `agendaStallGate` ("vou verificar a agenda e
 *     já te aviso") e do próprio léxico de humano ("assim que liberarem eu te aviso");
 *   - "nos falamos": ambíguo entre passado ("nos falamos sobre isso na visita") e futuro.
 *
 * As bordas adversas medidas (não casam): "Posso te chamar de Marcos?", "Como prefere que
 * eu te chame?", "Te chamei ontem", "Retomando o que conversamos…", "O sistema retoma
 * automaticamente", "Vou chamar o responsável" (tem alvo humano — o léxico o pega).
 */

/**
 * Normaliza como o `human-promise.ts`: minúsculas + sem diacríticos (NFD). Casa acento e
 * caixa uniformemente. O `\b` do JS é ASCII — por isso normalizar ANTES de casar, para
 * que "volto a falar" case tanto "falar" quanto "falávamos".
 */
function normalize(body: string): string {
  return body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Os padrões do vocabulário mínimo. Cada um exige a 1ª pessoa do próprio assistente — é o
 * que separa "VOU retomar" (promessa) de "retomar" num gerúndio de assunto ("Retomando o
 * que conversamos…") ou de uma 3ª pessoa de sistema ("o sistema retoma automaticamente").
 */
const PATTERNS: readonly RegExp[] = [
  // (1) RETOMAR no FUTURO do indicativo: "retomarei", "retomaremos". A forma já é a promessa.
  /\bretomar(?:ei|emos)\b/,
  // (2) VOLTAR a falar/conversar/contatar: "volto a falar", "volto a te conversar",
  //     "vou voltar a falar", "voltarei a contatar". O verbo de retomada já é futuro.
  /\b(?:volto|voltarei|vou voltar)\b[^.!?\n]{0,25}\b(?:fal|convers|contat|cham|procur|lig|escrev)\w*/,
  // (3) CHAMAR/PROCURAR/LIGAR o cliente em 1ª pessoa: "te chamo", "te procuro", "te ligo".
  //     Formas específicas (não `\w*`) para NÃO casar pergunta ("prefere que eu te chame?")
  //     nem passado ("te chamei ontem").
  /\bte\s+(?:chamo|chamarei|procuro|procurarei|ligo|ligarei)\b/,
  // (4) "chamo você" / "chamo vocês" na mesma 1ª pessoa.
  /\b(?:chamo|chamarei)\b[^.!?\n]{0,12}\b(?:voce|vc|voces)\b/,
  // (5) "a gente se fala" — futuro por construção (o passado seria "a gente se falou").
  /\ba gente se fala\b/,
];

/**
 * RETOMAR no presente ou em perífrase ("retomo", "retomamos", "vou/vamos/irei retomar") é
 * AMBÍGUO: tanto é a promessa ("retomamos daqui a duas horas", o caso medido) quanto a
 * retomada AGORA, no próprio turno ("Vamos retomar o agendamento: prefere segunda ou
 * terça?", "Retomo a segunda via do boleto: …"). Num CRM que marca horário, dia e hora
 * aparecem como ASSUNTO da retomada o tempo todo, então "a frase tem um marcador de tempo"
 * não separa as duas (medido na triagem do #2928). O que separa é a POSIÇÃO: na promessa,
 * o QUANDO vem colado ao verbo — logo depois dele (só com o objeto da conversa no meio:
 * "vou retomar o contato na segunda") ou logo antes ("amanhã retomamos").
 */
const RETOMAR_AMBIGUO = /(?:retom(?:o|amos)|(?:vou|vamos|irei|iremos) retomar)/.source;
const OBJETO_DA_CONVERSA =
  /(?: (?:o|a|nosso|nossa|o nosso|a nossa) (?:contato|conversa|atendimento|assunto|papo)| de onde (?:paramos|parou|parei))?(?: com (?:voce|vc)| contigo)?/
    .source;
// O QUANDO que torna a retomada uma promessa. Dia da semana só com preposição de data ou
// "-feira" ("a segunda via" não é data); hora só com h, minutos ou "horas" ("as 2 opções"
// não é hora).
const QUANDO =
  /(?:amanha|depois|mais tarde|daqui (?:a|ha|uns|umas|\d)|em breve|logo mais|assim que|semana que vem|mes que vem|(?:na |no )?proxim[ao] (?:semana|mes|hora|dia|segunda|terca|quarta|quinta|sexta|sabado|domingo)|(?:na|no|ate|para|pra) (?:segunda|terca|quarta|quinta|sexta|sabado|domingo)|(?:segunda|terca|quarta|quinta|sexta)-feira|(?:de|pela|a|na|hoje a) (?:manha|tarde|noite)|(?:no )?(?:fim|final) do dia|outra hora|outro dia|as \d{1,2}(?:h|:\d{2}| ?horas?)\b|\d{1,2} ?h\b|\d{1,2}:\d{2}|em \d+ ?(?:min|minutos?|horas?|dias?)\b)/
    .source;
const RETOMADA_COM_QUANDO = new RegExp(
  // Depois do verbo: "retomamos daqui a duas horas", "vou retomar o contato na segunda".
  // Antes dele, só abrindo a oração ("Combinado, amanhã retomamos"): em "Sua consulta é
  // amanhã às 10h, vamos retomar?" o quando é da consulta, não da retomada.
  `\\b${RETOMAR_AMBIGUO}${OBJETO_DA_CONVERSA},? ${QUANDO}` +
    `|(?:^|[.!?;:,\\n] *)${QUANDO}(?: ${QUANDO})?,? (?:a gente |nos |eu )?${RETOMAR_AMBIGUO}\\b`,
);

/**
 * True se o corpo é (ou contém) uma promessa do PRÓPRIO assistente de voltar a falar com
 * o cliente — a família medida da issue #2916. Puro, sem LLM, sem I/O. Vazio = false.
 *
 * NÃO julga se a promessa é legítima: quem decide o destino (follow-up agendado × caso ×
 * veto) é o `casePromiseGate` (`before-send.ts`), com o estado do turno.
 */
export function detectarPromessaDeRetornoDoAssistente(body: string): boolean {
  if (body.trim() === "") return false;
  const text = normalize(body);
  return PATTERNS.some((re) => re.test(text)) || RETOMADA_COM_QUANDO.test(text);
}
