/**
 * A AFIRMAÇÃO DE REGISTRO (issue #3333) — o sinal LÉXICO do gate `registro_sem_efeito`
 * (`before-send.ts`), irmão de `retorno-do-assistente.ts`.
 *
 * ─── O defeito, medido ───────────────────────────────────────────────────────
 *
 * Imobiliária montada do zero no ambiente de teste: o agente lista os imóveis, o cliente diz
 * "tenho interesse nesse", e o agente responde **"já registrei seu interesse"** sem chamar
 * `crm_create_lead`. O negócio não nasce, e o cliente fica esperando um contato que ninguém
 * vai fazer. Com `gpt-5.6-luna`, em 4 tentativas e 3 configurações de prompt: 3 de 4 (e as
 * outras variantes) escreveram que registraram sem chamar a ferramenta.
 *
 * Este módulo reconhece o TEXTO do defeito. Ele não julga se o registro existe: quem
 * responde isso é o PREDICADO ÚNICO do efeito (`lib/ai/runtime/efeito-das-escritas.ts`), e
 * quem decide o destino da fala é o gate. Separar as duas perguntas é o ponto: o detector
 * pode errar para o lado de não ver (falso negativo), mas a decisão de vetar NUNCA é tomada
 * aqui.
 *
 * ─── Conservador de propósito: vocabulário MÍNIMO ───────────────────────────
 *
 * Mesma disciplina de `human-promise.ts` e `retorno-do-assistente.ts`: veto é BLOQUEIO de
 * envio, então na dúvida entre falso-positivo e falso-negativo o vocabulário cobre só a
 * família MEDIDA, e as bordas adversas ficam como controle NEGATIVO no teste
 * (`tests/unit/gate-registro-sem-efeito.test.ts`):
 *
 *   - **futuro/infinitivo não é afirmação**: "vou registrar seu interesse", "se eu registrar
 *     seu interesse, prefere qual unidade?" — o verbo não está no passado consumado.
 *   - **outra coisa registrada não é o interesse**: "registrei sua visita para sábado" (é
 *     agenda, e o objeto do interesse não está na frase), "o sistema registra tudo" (3ª
 *     pessoa, presente).
 *   - **o verbo precisa estar em 1ª pessoa do PASSADO, ou o estado já consumado** ("está
 *     registrado"): "registro" substantivo ("o registro do imóvel") não afirma nada.
 *   - **negado não é afirmado**: "ainda não registrei seu interesse" passa. Não é detalhe: é a
 *     fala que o próprio veto pede ao modelo, e casá-la criaria um laço — o gate vetando a
 *     correção que ele mesmo ensinou. A negação é checada COLADA no verbo, então "não se
 *     preocupe, já registrei seu interesse" (o defeito real) continua vetado.
 *
 * O que a #3333 lista como medido — "registrei seu interesse" e "já está registrado" — está
 * coberto, e só isso mais as paráfrases diretas do mesmo tempo verbal.
 */

/**
 * As escritas que REGISTRAM o interesse do cliente — a família que o gate consulta no
 * predicado único. Lista curta e explícita DE PROPÓSITO: cada nome aqui é uma ferramenta cujo
 * sucesso autoriza a fala a dizer "registrei". Crescer a lista é uma decisão de produto (o
 * que conta como "o interesse ficou registrado"), não um detalhe de implementação.
 *
 * `crm_create_lead` é a escrita MEDIDA na issue: o negócio nasce no funil e na etapa
 * configurados, com `referencia_externa`. As demais escritas de negócio (`crm_update_lead`,
 * `crm_move_lead_stage`, `crm_close_demand`) NÃO entram: elas exigem um negócio que já
 * existe, então não são "o registro do interesse que acabou de ser dito" — e incluí-las
 * deixaria passar justamente o turno em que nada nasceu.
 */
export const ESCRITAS_QUE_REGISTRAM_O_INTERESSE: readonly string[] = ["crm_create_lead"];

/**
 * As ferramentas da família que ESTE agente tem — a lista que arma o gate e que o veto
 * nomeia. Lista, e não booleano, pelo mesmo motivo do `agenda.ferramentas`: o texto do veto é
 * ENSINO, e nomear ferramenta que o agente não tem faz o modelo tentar chamá-la, falhar, e a
 * correção virar um segundo defeito.
 *
 * Vazia = gate desarmado. Sem nenhuma ferramenta de registro não existe cura determinística
 * (o agente não teria como registrar nem como cumprir o ensino), e vetar toda menção a
 * registro seria punir o agente por uma capacidade que o dono não ligou.
 */
export function ferramentasDeRegistroDoAgente(toolIds: readonly string[]): string[] {
  return ESCRITAS_QUE_REGISTRAM_O_INTERESSE.filter((t) => toolIds.includes(t));
}

/** Normaliza como `human-promise.ts`/`retorno-do-assistente.ts`: minúsculas + sem diacríticos. */
function normalize(body: string): string {
  return body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** O objeto cuja existência a fala está afirmando. */
const OBJETO = "(?:interesses?|solicitacao|solicitacoes|pedidos?|preferencias?|oportunidades?|leads?|negocios?|cadastros?|dados)";

/**
 * O vocabulário mínimo. Todos os padrões rodam sobre o texto JÁ normalizado (sem acento,
 * minúsculo) — por isso não há classe de acento aqui, e por isso `\b` (ASCII) é seguro.
 *
 * `verbo` é onde está a AFIRMAÇÃO dentro do casamento: o início do match na maioria, mas não
 * em (2) e (2b), em que o objeto vem antes. É essa posição que a checagem de negação olha —
 * ver `NEGACAO_COLADA`.
 */
interface Padrao {
  re: RegExp;
  verbo?: RegExp;
}

const PATTERNS: readonly Padrao[] = [
  // (1) 1ª pessoa do PASSADO com o objeto do interesse na mesma frase:
  //     "registrei seu interesse", "já registrei o interesse dela na unidade 2".
  { re: new RegExp(`\\bregistrei\\b[^.!?\\n]{0,60}\\b${OBJETO}\\b`) },
  //     e a ordem inversa, menos comum mas medida em texto de WhatsApp: "seu interesse, eu registrei".
  { re: new RegExp(`\\b${OBJETO}\\b[^.!?\\n]{0,20}\\bregistrei\\b`), verbo: /\bregistrei\b/ },
  // (2) estado afirmado no presente/passado. O particípio sozinho também aparece
  //     em futuro/possibilidade ("será registrado", "pode ser registrado").
  {
    re: new RegExp(`\\b${OBJETO}\\b[^.!?\\n]{0,30}\\b(?:esta|estao|estava|estavam|ficou|ficaram|foi|foram)\\s+(?:registrad|anotad|guardad|salv|gravad)[oa]s?\\b`),
    verbo: /(?:registrad|anotad|guardad|salv|gravad)[oa]s?\b/,
  },
  // (3) "já está registrado" — a forma que a issue lista como medida, sem objeto explícito.
  { re: /\bja\s+(?:esta|esta\s+tudo|foi|ficou)\s+registrad[oa]\b/ },
  // (4) o substantivo do ato: "fiz o registro", "registro feito/concluído".
  { re: /\bfiz\s+(?:o|um|seu)\s+registro\b/ },
  {
    // "o registro do seu interesse foi feito" — o objeto do interesse é obrigatório aqui: sem
    // ele, "o registro do imóvel foi feito" (o do cartório, numa imobiliária) seria vetado.
    re: new RegExp(
      `\\bregistro\\s+(?:d[oa]s?\\s+)?(?:(?:seu|sua|teu|tua)\\s+)?${OBJETO}\\b[^.!?\\n]{0,20}(?:foi\\s+)?(?:feito|concluido|efetuado)\\b`,
    ),
    verbo: /(?:feito|concluido|efetuado)\b/,
  },
  // (5) "acabei de registrar" — o passado imediato é consumado do mesmo jeito.
  { re: /\bacabei de (?:registrar|cadastrar)\b/ },
  // (6) "deixei registrado/anotado".
  { re: /\bdeixei\s+(?:tudo\s+|ja\s+)?(?:registrad|anotad)/ },
  // (7) "cadastrei seu interesse", "cadastrei você no sistema".
  { re: /\bcadastrei\b[^.!?\n]{0,40}\b(?:interesse|solicita|pedido|voce|vc|seu|sua)\b/ },
];

/**
 * A NEGAÇÃO que anula a afirmação — e ela precisa estar COLADA no verbo, não solta na frase.
 *
 * Isto separa a fala que o gate existe para PRODUZIR da fala que ele deve deixar passar. Depois
 * do veto, a resposta honesta do modelo é exatamente "ainda não registrei seu interesse; vou
 * passar para a equipe" — e um detector que casasse o verbo ignorando a negação vetaria a
 * própria correção, em loop.
 *
 * Ancorar no VERBO (e não na oração inteira) é o que mantém o caso real vetado:
 * "não se preocupe, já registrei seu interesse" tem um "não" na frase, mas ele não nega o
 * registro — e é justamente a frase que o defeito produziu. Já "seu interesse **não** está
 * registrado" e "ainda **não** foi registrado" têm a negação a até dois conectivos do verbo.
 */
const NEGACAO_COLADA = /\b(?:nao|nunca|jamais)\s+(?:\w+\s+){0,2}$/;

/** O mesmo vocabulário, em versão global, para olhar o contexto de CADA ocorrência. */
const PATTERNS_GLOBAIS: readonly Padrao[] = PATTERNS.map((p) => ({
  re: new RegExp(p.re.source, "g"),
  ...(p.verbo ? { verbo: p.verbo } : {}),
}));

/**
 * `true` quando alguma ocorrência do padrão NÃO está negada. A verificação é por ocorrência:
 * "registrei seu interesse na unidade 1, mas não registrei o da unidade 2" afirma a primeira e
 * nega a segunda — a afirmação existe e o gate tem de vê-la.
 */
function algumaAfirmacao(text: string, padrao: Padrao): boolean {
  for (const m of text.matchAll(padrao.re)) {
    const inicio = m.index ?? 0;
    const deslocamento = padrao.verbo ? m[0].search(padrao.verbo) : 0;
    const posVerbo = inicio + Math.max(0, deslocamento);
    const antes = text.slice(Math.max(0, posVerbo - 26), posVerbo);
    if (NEGACAO_COLADA.test(antes)) continue;
    return true;
  }
  return false;
}

/**
 * True se o corpo AFIRMA, no passado, que um registro foi feito — a família medida da #3333.
 * Puro, sem LLM, sem I/O. Vazio = false.
 *
 * Não julga se o registro existe: essa é a pergunta do predicado único do efeito, lida pelo
 * gate `registro_sem_efeito` com o estado do turno.
 */
export function detectarAfirmacaoDeRegistro(body: string): boolean {
  if (body.trim() === "") return false;
  const text = normalize(body);
  return PATTERNS_GLOBAIS.some((padrao) => algumaAfirmacao(text, padrao));
}
