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
 * Monta os 7 padrões de promessa-de-humano em cima de um ALVO (`target`)
 * substituível — o TARGET genérico por padrão, ou o TARGET estendido com
 * nome(s) próprio(s) do tenant (ver `detectHumanPromise`).
 */
function buildPatterns(target: string): RegExp[] {
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
    // (2) "<alvo humano> vai/pode <resolver/retornar/...>": "nosso time vai resolver", "um responsavel vai te retornar".
    //     "nossa equipe ESTA a disposicao" NÃO casa ("esta" fora do grupo vai/vao/pode).
    new RegExp(
      `\\b${target}\\b${gap(20)}\\b(?:vai|vao|ira|irao|pode|podem|poderao)\\b${gap(10)}` +
        `(?:\\b(?:te|lhe|se|nos)\\b\\s*)?(?:resolv|retorn|respond|liber|analis|verific|cuid|assum|atend|entr|aprov|confirm|contat|ajud)\\w*`,
    ),
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
    // (3) deferir a TERCEIROS via subjuntivo 3ª pessoa do plural: "assim que liberarem eu te aviso".
    //     Não depende de `target` — não repetido no alvo estendido.
    new RegExp(
      `\\b(?:assim que|assim q|quando|depois que|logo que|apos)\\b${gap(12)}` +
        `\\b(?:liber|aprov|autoriz|respond|retorn|verific|analis|resolv|confirm)(?:ar|er)em\\b`,
    ),
  ];
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
 */
function soPedeConsentimento(text: string): boolean {
  const frases = text.split(/(?<=[.!?\n])/).map((f) => f.trim()).filter(Boolean);
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
  if (body.trim() === "") return false;
  const text = normalize(body);
  if (soPedeConsentimento(text)) return false;
  if (extraHumanNames === undefined || extraHumanNames.length === 0) {
    return PATTERNS.some((re) => re.test(text));
  }
  const names = Array.from(
    new Set(
      extraHumanNames
        .map((w) => normalize(w).trim())
        .filter((w) => /^[a-z]{3,}$/.test(w) && !TARGET_WORD_SET.has(w)),
    ),
  );
  if (names.length === 0) return PATTERNS.some((re) => re.test(text));
  const extendedTarget = `(?:${TARGET_WORDS.join("|")}|${names.map(escapeRegex).join("|")})`;
  return buildPatterns(extendedTarget).some((re) => re.test(text));
}
