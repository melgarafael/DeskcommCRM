/**
 * Detector determinístico de PROMESSA-DE-HUMANO (spec 15 §10.2; Wave 4) — o
 * complemento anti-alucinação do guardrail de casos: dispara quando a candidata
 * a envio promete envolver a retaguarda humana (encaminhar/acionar/consultar a
 * equipe/setor/responsável, ou afirmar que "o time vai resolver/retornar"). É o
 * gatilho do `casePromiseGate` (before-send): se a IA prometeu humano e NÃO há
 * caso aberto, a mensagem é vetada até um caso existir (a invariante sagrada).
 *
 * Sem LLM (mesma disciplina de guardrails/promise/engine.ts): regex PT-BR
 * CONSERVADORA, calibrada para baixo falso-positivo. As duas armadilhas
 * (spec §10.2, congeladas em tests/invariants/case-promise-detector.test.ts):
 *   - "verificar seu pedido NO SISTEMA" ≠ acionar humano → NÃO dispara (o
 *     verbo de consulta exige um ALVO humano via "com <equipe/setor/...>");
 *   - "nossa equipe está sempre à disposição" é institucional, não promessa de
 *     ação → NÃO dispara (o alvo humano sozinho não basta; exige verbo de
 *     encaminhamento/consulta, OU "<time> vai <resolver/retornar>").
 * Trade-off documentado (spec §10.2): na dúvida entre falso-negativo em promessa
 * CLARA de humano e falso-positivo, o detector prioriza pegar a promessa clara —
 * o fail-safe do gate (auto-abre caso na 2ª insistência) cobre o excesso, mas
 * NUNCA deixa a promessa passar sem caso.
 */

/** Alvo humano/retaguarda genérico (já sem acento — o texto é normalizado antes de casar). */
const TARGET_WORDS = [
  "equipe",
  "time",
  "setor",
  "responsavel",
  "responsaveis",
  "pessoal",
  "especialista",
  "especialistas",
  "atendente",
  "atendentes",
  "gerente",
  "supervisor",
  "departamento",
] as const;
const TARGET_WORD_SET = new Set<string>(TARGET_WORDS);
const TARGET = `(?:${TARGET_WORDS.join("|")})`;

/**
 * Lacuna curta que NÃO cruza fim de frase (sem .!?\n): impede casar um verbo de
 * uma oração com um alvo humano de outra (evita falso-positivo entre sentenças).
 */
const gap = (n: number): string => `[^.!?\\n]{0,${n}}?`;

/**
 * AS FAMÍLIAS, SEPARADAS PELO QUE A PROMESSA PROMETE (issue #3725).
 *
 * A união das duas é o `detectHumanPromise` de sempre — nenhum comportamento
 * dele muda. A separação existe porque há UM leitor que precisa de só metade:
 * o fail-safe de `case_promise_without_case` (`inbound-turn.ts`), que ABRE UM
 * CASO HUMANO e manda o cliente para a fila.
 *
 *   - `buildPatternsDaAcao` — a IA diz que ENVOLVE alguém AGORA (encaminhar,
 *     transferir, acionar, consultar com, repassar). É passagem para humano de
 *     verdade: alguém da equipe fica com a conversa.
 *   - `buildPatternsDoRetorno` — a IA diz que a equipe/ele RESPONDE DEPOIS
 *     ("nossa equipe vai te retornar", "assim que liberarem eu te aviso"). É
 *     promessa de RETOMADA, não de passagem — o destino certo é
 *     `schedule_followup` (`retorno-do-assistente.ts`), não um caso humano.
 *
 * O defeito medido na issue: o cliente respondeu SÓ "Não" a uma pergunta de
 * horário, a IA respondeu "sem problema, nossa equipe te responde outro dia" —
 * família do RETORNO — e o fail-safe abriu caso humano com o blocker "a IA
 * prometeu envolver um humano". Ninguém prometeu humano: prometeu-se voltar.
 */
function buildPatternsDaAcao(target: string): RegExp[] {
  return [
    // (1a) encaminhar/passar/acionar/... → alvo humano: "encaminhar pro setor", "acionar o responsavel".
    new RegExp(`\\b(?:encaminh|repass|transfer|acion|escal|direcion|pass|cham)\\w*${gap(20)}\\b${target}\\b`),
    // (1a-bis) mesmo verbo de encaminhamento, mas o ALVO é retomado por PRONOME (eles/elas)
    // em vez do substantivo — achado na prova E2E da Wave 7 real: "já passo o pedido pra
    // eles resolverem" escapava (1a) porque "eles" não é TARGET). Exige um verbo de
    // RESOLUÇÃO depois do pronome (não só "passar pra eles" — precisa prometer AÇÃO deles).
    new RegExp(
      `\\b(?:encaminh|repass|transfer|acion|escal|direcion|pass|cham)\\w*${gap(30)}` +
        `\\b(?:pra|para|pro|com)\\b${gap(8)}\\b(?:eles|elas)\\b${gap(25)}` +
        `\\b(?:resolv|retorn|respond|liber|analis|verific|cuid|assum|atend|aprov|confirm|contat|ajud)\\w*`,
    ),
    // (1b) verbo de CONSULTA + "com" + alvo humano: "verificar com a equipe", "falar com o pessoal".
    //      Exige "com <humano>": "verificar seu pedido no sistema" (sem "com equipe") NÃO casa.
    new RegExp(`\\b(?:verific|fal|confer|confirm|consult|alinh|valid|chec)\\w*${gap(15)}\\bcom\\b${gap(15)}\\b${target}\\b`),
    // (1c) pedir/solicitar pra/ao alvo humano: "vou pedir pra equipe liberar".
    new RegExp(`\\b(?:ped|solicit)\\w*${gap(12)}\\b(?:pra|para|pro|ao|aos|a|as|com)\\b${gap(10)}\\b${target}\\b`),
    // (2b) "quem resolve/cuida ... e o nosso time": "isso quem resolve e o nosso time".
    new RegExp(
      `\\bquem\\b${gap(15)}\\b(?:resolv|cuid|respond|decid|aprov|liber|atend)\\w*${gap(20)}` +
        `(?:\\b(?:nosso|nossa|nossos|nossas|o|a|os|as)\\b\\s*)?${target}\\b`,
    ),
    // (2c) ESTADO passivo alegado — não uma promessa de AÇÃO futura (vai resolver),
    //      e sim uma AFIRMAÇÃO de que já está sendo tratado agora: "está em análise
    //      pela equipe", "ficou em análise com o responsável". Achado em produção
    //      (2026-08-30): o agente respondeu a uma reclamação de garantia
    //      de quase 1 dia dizendo que estava "em análise pela equipe responsável" sem
    //      NENHUM caso aberto — as 7 regras acima exigem verbo de AÇÃO (vai/vamos/
    //      encaminho) e nenhuma casa uma alegação de estado já em curso.
    new RegExp(
      `\\b(?:est[aá]|ficou|fica|segue)\\b${gap(10)}\\bem\\b\\s+an[aá]lise\\b${gap(20)}` +
        `\\b(?:com|pela|pelo|do|da|na|no)\\b${gap(10)}\\b${target}\\b`,
    ),
    // (2d) REPASSE ALEGADO SEM OBJETO, frase inteira: "Já encaminhei!", "Pronto, encaminhado!".
    //      Sem objeto, o que foi repassado é o pedido do cliente — a alegação de que alguém
    //      já foi acionado, ainda que o alvo só apareça na pergunta seguinte ("Quer que eu
    //      avise a equipe?"), onde nenhuma regra o alcança. Ancorada no começo da frase:
    //      "Já te encaminhei o link." tem objeto e "Seu pedido foi encaminhado." tem sujeito,
    //      e nenhum dos dois casa. Não depende de `target`.
    new RegExp(
      `(?:^|[.!?\\n]\\s*)(?:(?:pronto|ok|certo|feito|perfeito)\\s*[,!]?\\s*)?(?:(?:eu\\s+)?(?:ja\\s+)?` +
        `(?:encaminhei|repassei|transferi|acionei|escalei)|(?:ja\\s+)?(?:encaminhad|repassad|transferid|acionad|escalad)[oa])` +
        `(?:\\s+(?:aqui|agora|internamente))?\\s*(?:[.!]|$)`,
    ),
  ];
}

/**
 * A família do RETORNO — "a equipe vai resolver/retornar", "assim que liberarem
 * eu te aviso". Continua promessa (o `detectHumanPromise` a mantém vetada), mas
 * NÃO é passagem para humano: quem promete voltar a falar é o próprio
 * atendimento automático, e o compromisso que o cliente espera é uma nova
 * mensagem — `schedule_followup`.
 */
function buildPatternsDoRetorno(target: string): RegExp[] {
  return [
    // (2) "<alvo humano> vai/pode <resolver/retornar/...>": "nosso time vai resolver", "um responsavel vai te retornar".
    //     "nossa equipe ESTA a disposicao" NÃO casa ("esta" fora do grupo vai/vao/pode).
    new RegExp(
      `\\b${target}\\b${gap(20)}\\b(?:vai|vao|ira|irao|pode|podem|poderao)\\b${gap(10)}` +
        `(?:\\b(?:te|lhe|se|nos)\\b\\s*)?(?:resolv|retorn|respond|liber|analis|verific|cuid|assum|atend|entr|aprov|confirm|contat|ajud)\\w*`,
    ),
    // (3) deferir a TERCEIROS via subjuntivo 3ª pessoa do plural: "assim que liberarem eu te aviso".
    new RegExp(
      `\\b(?:assim que|assim q|quando|depois que|logo que|apos)\\b${gap(12)}` +
        `\\b(?:liber|aprov|autoriz|respond|retorn|verific|analis|resolv|confirm)(?:ar|er)em\\b`,
    ),
  ];
}

/**
 * A união — o detector de sempre. A ordem É o contrato: ação primeiro, retorno
 * depois; `tests/invariants/case-promise-detector.test.ts` congela o veredito
 * das duas famílias, e é ele que impede alguém de "consertar" o fail-safe
 * afrouxando o detector.
 */
function buildPatterns(target: string): RegExp[] {
  return [...buildPatternsDaAcao(target), ...buildPatternsDoRetorno(target)];
}

/** Compilado uma vez no load do módulo — caminho quente sem nome próprio extra. */
const PATTERNS: readonly RegExp[] = buildPatterns(TARGET);

/** Minúsculas + remove diacríticos (NFD) — casa acento/caixa uniformemente. */
function normalize(body: string): string {
  return body
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Escapa metacaracteres de regex — nome próprio vira literal, nunca sintaxe. */
function escapeRegex(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pergunta de consentimento ("quer que eu encaminhe para a equipe?") ainda não é
 * operação executada. A isenção vale para a mensagem INTEIRA, nunca frase a
 * frase: basta uma frase com operação alegada, prazo ou retorno anunciado
 * ("O responsável retorna em 10 minutos") para a análise voltar ao texto todo.
 *
 * Única folga (issue #3725): UMA abertura antes das perguntas, se ela inteira for
 * reconhecimento sem conteúdo ("Entendi!", "Sem problema, entendi!"). É lista
 * FECHADA de propósito — falha fechada, como o §10.2 manda: qualquer outra
 * abertura ("Já encaminhei.", "Vou anotar aqui.") devolve a análise à mensagem
 * inteira. Três rodadas de lista de sinais de promessa (verbos, posição,
 * marcadores de ação) acharam, cada uma, uma família nova que escapava.
 * Ficam de fora "pode deixar" e "fica tranquilo": são garantia, não reconhecimento.
 */
const RECONHECIMENTOS_SEM_CONTEUDO = new Set([
  "entendi",
  "entendido",
  "certo",
  "claro",
  "ok",
  "combinado",
  "anotado",
  "perfeito",
  "beleza",
  "tudo bem",
  "tudo certo",
  "sem problema",
  "sem problemas",
]);

function ehReconhecimentoSemConteudo(frase: string): boolean {
  const partes = frase.split(",").map((p) => p.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim());
  return partes.every((p) => RECONHECIMENTOS_SEM_CONTEUDO.has(p));
}

function soPedeConsentimento(text: string): boolean {
  const todas = text.split(/(?<=[.!?\n])/).map((f) => f.trim()).filter(Boolean);
  const frases = todas.length > 1 && ehReconhecimentoSemConteudo(todas[0] ?? "") ? todas.slice(1) : todas;
  return frases.length > 0 && frases.every((f) =>
    f.endsWith("?") &&
    /^(?:(?:voce|vc)\s+)?(?:quer|gostaria|prefere|deseja|autoriza|posso|podemos)\b/.test(f) &&
    /\b(?:encaminh|transfer|pass|fal|consult|verific|cham)\w*/.test(f) &&
    !/\b(?:ja|vou|vamos|vai|vao|ira|irao|transferi|encaminhei|registrei|acabei)\b/.test(f) &&
    !/\b(?:hoje|amanha|agora|logo|ate|minutos?|horas?|semana|dias?|\d+\s*h|\d{1,2}:\d{2})\b/.test(f) &&
    !/\b(?:te|lhe)\s+(?:lig|retorn|respond|contat|procur|cham|d[ae])\w*|\bretorn\w*|\bentr\w*\s+em\s+contato/.test(f));
}

/**
 * True se a candidata promete envolver um humano/retaguarda. Determinístico,
 * conservador (spec §10.2). Vazio/whitespace = false.
 *
 * `extraHumanNames` (opcional) — nome(s) próprio(s) que o PROMPT do tenant usa
 * para a retaguarda humana (ex.: "Fulano", o gerente citado no system_prompt
 * de um agente em produção). Sem isto, um agente cujo prompt nomeia a pessoa em vez do
 * cargo ("vou confirmar com o Fulano") escapa 100% do detector — TARGET só
 * conhece cargos genéricos (medido em produção, 2026-08-29/30:
 * dezenas de promessas nomeando o gerente pelo nome, 1 só detecção em 3 dias). A fonte
 * natural é `ai_agent_versions.handoff_keywords` — já é o vocabulário que o
 * tenant escreveu pra "isto é uma pessoa/situação que exige humano" (reusado
 * hoje só do lado do CLIENTE, em `matchesHandoffKeyword`); aqui aplicamos o
 * mesmo vocabulário do lado do que o MODELO promete. Palavras compostas
 * ("falar com humano") e as já cobertas por TARGET_WORDS são descartadas —
 * só nomes próprios simples entram no alvo estendido.
 */
export function detectHumanPromise(body: string, extraHumanNames?: readonly string[]): boolean {
  return avaliaFamilias(body, extraHumanNames, buildPatterns);
}

/**
 * O ALVO do tenant, resolvido uma vez: o genérico (`PATTERNS`) quando não há
 * nome próprio aproveitável, senão o TARGET estendido. Devolve `null` para o
 * caminho quente — o compilado no load do módulo.
 */
function alvoDoTenant(extraHumanNames?: readonly string[]): string | null {
  if (extraHumanNames === undefined || extraHumanNames.length === 0) return null;
  const names = Array.from(
    new Set(
      extraHumanNames
        .map((w) => normalize(w).trim())
        .filter((w) => /^[a-z]{3,}$/.test(w) && !TARGET_WORD_SET.has(w)),
    ),
  );
  if (names.length === 0) return null;
  return `(?:${TARGET_WORDS.join("|")}|${names.map(escapeRegex).join("|")})`;
}

function avaliaFamilias(
  body: string,
  extraHumanNames: readonly string[] | undefined,
  familia: (target: string) => RegExp[],
): boolean {
  if (body.trim() === "") return false;
  const text = normalize(body);
  if (soPedeConsentimento(text)) return false;
  const target = alvoDoTenant(extraHumanNames);
  return (target === null ? familia(TARGET) : familia(target)).some((re) => re.test(text));
}

/**
 * ═══ A METADE QUE ABRE CASO HUMANO (issue #3725) ═══
 *
 * True só quando a candidata promete ENVOLVER alguém AGORA — encaminhar,
 * transferir, acionar, consultar com o responsável, ou alegar que já o fez.
 * Fica de fora, de propósito, a família do RETORNO ("nossa equipe vai te
 * responder outro dia", "assim que liberarem eu te aviso"): ela É promessa (o
 * `detectHumanPromise` a veta, e tem de continuar vetando), mas o destino dela
 * não é a fila de atendimento humano — é o `schedule_followup`.
 *
 * Quem lê esta função é o fail-safe do `case_promise_without_case`
 * (`inbound-turn.ts`): ele ABRE UM CASO e manda o cliente ler "passei seu
 * pedido para um atendente humano". Abrir isso porque a IA disse que a equipe
 * responde depois — ao cliente que só respondeu "Não" a uma pergunta de horário
 * — foi o defeito medido. A régua agora exige uma das duas: pedido explícito do
 * cliente (`detectHumanHandoffRequest`) OU esta promessa explícita de ação.
 *
 * A isenção da pergunta de consentimento vale aqui também: "Quer que eu
 * encaminhe para a equipe?" é OFERTA, não promessa.
 */
export function detectHumanHandoffPromise(
  body: string,
  extraHumanNames?: readonly string[],
): boolean {
  return avaliaFamilias(body, extraHumanNames, buildPatternsDaAcao);
}
