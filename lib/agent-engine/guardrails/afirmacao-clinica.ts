/**
 * AFIRMAÇÃO CLÍNICA NA BOCA DO ASSISTENTE — o detector do `clinicalClaimGate`.
 *
 * ## O problema
 *
 * Em clínica, consultório e qualquer negócio de saúde, quatro frases não podem sair
 * do assistente, por mais que o prompt peça: dizer o que a pessoa TEM ("você tem uma
 * micose"), mandar TOMAR ou PASSAR algo ("tome 500 mg", "passe uma pomada de
 * corticoide"), GARANTIR resultado ("cura garantida") e dizer que uma lesão É câncer
 * ("isso é um melanoma"). Uma frase dessas, escrita, é ato médico praticado por quem
 * não é médico — e o prompt sozinho não segura: ele é uma instrução, e o modelo erra.
 *
 * Os outros portões da cadeia (`promise`, `internal_vocabulary`, `agenda_stall`) são a
 * mesma ideia aplicada a outro risco: uma regra fixa, sem custo de modelo, que barra a
 * frase e devolve ao modelo o que fazer no lugar.
 *
 * ## Por que é OPCIONAL por organização (camada `afirmacao_clinica`)
 *
 * Fora da saúde, as mesmas palavras são normais: "você tem 10% de desconto", "use o
 * cupom", "passe na loja", "garanto a entrega". O detector já é estreito (ver abaixo),
 * mas o produto é multi-nicho e a pergunta da doutrina de extensões vale: se nenhuma
 * organização ligar isto, a operação comum continua inteira. Por isso nasce DESLIGADO e
 * quem é de saúde liga em Segurança.
 *
 * ## Dois idiomas: português e espanhol
 *
 * O vocabulário cobre as duas línguas que a clínica brasileira e a hispanofalante usam
 * no WhatsApp (dermatologia + clínica geral). As listas carregam as duas grafias, com
 * as variantes de acento, e as frases de cada idioma vivem no corpus de
 * `afirmacao-clinica.test.ts` — termo novo entra com um caso lá, nos DOIS sentidos.
 *
 * ## O que ele NÃO pega, de propósito
 *
 * - Pergunta. "Você tem psoríase há quanto tempo?" repete o que o paciente contou; a
 *   frase terminada em `?` não é afirmação.
 * - Hipótese condicional. "Se for câncer de pele, o médico faz a cirurgia de Mohs" é
 *   informação de serviço, não diagnóstico. Marcadores de hipótese (`se for`, `caso
 *   seja`, `pode ser`, `suspeita de`) desarmam SÓ a regra oncológica e a de diagnóstico.
 * - "Você tem" sem doença. "Você tem preferência de horário?" e "você tem algum exame?"
 *   são a rotina da recepção. A regra exige um termo clínico logo depois.
 * - Verbo de tomar/usar sem remédio. "Tome nota", "use o estacionamento", "passe na
 *   recepção" passam: a regra exige um medicamento, uma forma farmacêutica ou uma dose.
 * - Instrução NEGADA. "Não passe creme no dia do laser" e "no puede aplicar crema" são
 *   preparo de procedimento, não prescrição — a negação antes do verbo (inclusive
 *   `não pode`/`no puede`) desarma a regra de prescrição.
 *
 * É REDE, não cura — como o `internal_vocabulary`. A cura é o prompt e o modelo; isto
 * pega o que escapa e transforma o escape em número no `before_send_traces`.
 */

/** As quatro categorias. Rótulos NOSSOS e fechados: vão ao trace, nunca o texto. */
export type CategoriaClinica =
  | 'diagnostico'
  | 'prescricao'
  | 'promessa_de_resultado'
  | 'afirmacao_oncologica';

export interface AchadoClinico {
  achou: boolean;
  categorias: CategoriaClinica[];
}

/**
 * Doenças e achados que, ditos como "você tem / está com", viram diagnóstico.
 * Lista curta e de dermatologia + clínica geral: é o vocabulário que aparece em
 * atendimento de WhatsApp, não um CID inteiro. Termo novo entra com um caso no teste.
 * As alternâncias carregam português E espanhol, com as variantes de acento.
 */
const DOENCAS =
  'micose|onicomicose|micosis|psor[ií]ase|psoriasis|dermatite|dermatitis|eczema|eccema|ros[aá]cea|' +
  'melasma|vit[ií]ligo|acn[eé]?|foliculite|foliculitis|imp[eé]tigo|herpes|z[oó]ster|sarna|escabiose|escabiosis|' +
  'urtic[aá]?ria|alergia|infec[cç][aã]o|infecci[oó]n|inflama[cç][aã]o|inflamaci[oó]n|fungo|hongos?|' +
  'bact[eé]ria|bacteria|v[ií]rus|virus|verruga|cisto|quiste|lipoma|queratose|ceratose|queratosis|' +
  'alopecia|calv[ií]?cie|hidradenit(?:e|is)|l[uú]pus|c[aâá]ncer|melanoma|carcinoma|tumor|' +
  'nevo at[ií]pico|les[aã]o maligna|lesi[oó]n maligna';

/** Tumores malignos: a afirmação mais grave, com regra própria. */
const ONCOLOGICO = 'c[aâá]ncer(?: de piel)?|melanoma|carcinoma|tumor maligno|cbc|cec';

/** Remédio ou forma farmacêutica — o objeto que transforma "use" em prescrição. */
const REMEDIOS =
  'rem[eé]?dio|medicamento|medica[cç][aã]o|medicaci[oó]n|antibi[oó]tico|antif[uú]ngico|antial[eé]rgico|' +
  'anti-?inflamat[oó]ri[oa]|corticoide|cortic[oó]ide|pomada|creme|crema|ung[uü]ento|comprimido|pastilla|' +
  'c[aá]psula|xarope|jarabe|gotas|loç[aã]o|loci[oó]n|champ[uú] antif[uú]ngico|shampoo antif[uú]ngico|' +
  'isotretino[ií]na|minoxidil|ivermectina|cetoconazol|terbinafina|dexametasona|prednisona|amoxicilina';

/**
 * Limites de palavra que entendem acento. O `\b` do JavaScript só conhece `[A-Za-z0-9_]`,
 * mesmo com a flag `u`: entre um espaço e "é" ele não vê fronteira, e "seu diagnóstico
 * é…" nunca casava — os três primeiros vermelhos deste arquivo foram exatamente isso.
 */
const INICIO = String.raw`(?<![\p{L}\p{N}_])`;
const FIM = String.raw`(?![\p{L}\p{N}_])`;
const palavra = (alternativas: string): string => `${INICIO}(?:${alternativas})${FIM}`;

const HIPOTESE = new RegExp(
  palavra(
    String.raw`se\s+for|se\s+[eé]|caso\s+seja|caso\s+for|pode\s+ser|poderia\s+ser|talvez\s+seja|` +
      String.raw`suspeita\s+de|em\s+caso\s+de|se\s+(?:a\s+les[aã]o\s+)?(?:for|tiver)|` +
      String.raw`si\s+es|si\s+fuera|si\s+fuese|caso\s+sea|puede\s+ser|podr[ií]a\s+ser|quiz[aá]s\s+sea|` +
      String.raw`tal\s+vez\s+sea|sospecha\s+de|en\s+caso\s+de|si\s+(?:la\s+lesi[oó]n\s+)?(?:es|fuera|fuese)`,
  ),
  'iu',
);

const ARTIGO = String.raw`(?:(?:um|uma|uns|umas|un|una|unos|unas)\s+)?`;

const VERBOS_DE_USO =
  String.raw`tome|tomar|pode\s+tomar|puede\s+tomar|use|usar|pode\s+usar|puede\s+usar|` +
  String.raw`aplique|aplicar|aplicarse|apl[ií]quese|puede\s+aplicar|puede\s+aplicarse|` +
  String.raw`p[oó]ngase|ponerse|puede\s+ponerse|passe|passar|pode\s+passar`;
/**
 * A negação que transforma prescrição em orientação. O `pode`/`puede` opcional é o que
 * cobre "não pode passar creme" e "no puede aplicar crema": a locução inteira nega o
 * verbo, e sem ele o lookbehind só enxergava o `não` colado no infinitivo.
 */
const NAO_NEGADO = String.raw`(?<!(?:n[aã]o|no|nem|ni|evite)\s+(?:(?:pode|puede)\s+)?)`;

const REGRAS: ReadonlyArray<{ categoria: CategoriaClinica; padrao: RegExp; hipoteseDesarma: boolean }> = [
  {
    categoria: 'diagnostico',
    padrao: new RegExp(
      [
        // "Se você tem alergia a…, avise" é pergunta condicional da recepção, não diagnóstico.
        // O lookbehind fica no SUJEITO, não em HIPOTESE: em HIPOTESE, um "se você tiver
        // dúvida" desarmaria a frase inteira e soltaria "Você tem uma micose, se você
        // tiver dúvida me chame." (casos de controle no teste).
        String.raw`(?<!${INICIO}se\s+)${palavra(String.raw`voc[eê]|vc`)}\s+` +
          String.raw`(?:tem|t[aá]\s+com|est[aá]\s+com|possui|deve\s+ter|provavelmente\s+tem|certamente\s+tem)\s+` +
          `${ARTIGO}${palavra(DOENCAS)}`,
        // Espanhol com sujeito explícito: "Si usted tiene…" / "Tú tienes…" — a MESMA
        // guarda condicional do "se": "Si tiene alergia, avise" é recepção, não diagnóstico.
        String.raw`(?<!${INICIO}si\s+)${palavra(String.raw`t[uú]|usted|ustedes|vos`)}\s+` +
          String.raw`(?:tiene|tienes|tienen|est[aá]s?\s+con|presenta|padece|debe\s+tener|probablemente\s+tiene|ciertamente\s+tiene)\s+` +
          `${ARTIGO}${palavra(DOENCAS)}`,
        // Espanhol sem sujeito explícito: "Tienes hongos", "Presenta una infección",
        // "Estás con una infección" — e "Si tiene alergia…" cai na mesma guarda condicional.
        // A guarda aceita até duas palavras entre "si"/"quien" e o verbo: sem sujeito escrito,
        // a regra também casa a terceira pessoa genérica ("Si usted tiene alergia, avísenos",
        // "Quien tiene acné puede…", "Si el paciente tiene herpes…"), que é serviço, não
        // diagnóstico. Vírgula quebra a janela: "Si tienes picazón, tienes hongos" segue barrada.
        String.raw`(?<!${INICIO}(?:si|quien|quienes)\s+(?:[\p{L}]+\s+){0,2})${palavra(String.raw`tiene|tienes|presenta|padece(?:\s+de)?|est[aá]s?\s+con|debe\s+tener|probablemente\s+tiene`)}\s+` +
          `${ARTIGO}${palavra(DOENCAS)}`,
        String.raw`${palavra(String.raw`seu\s+diagn[oó]stico\s+(?:[eé]|seria)|su\s+diagn[oó]stico\s+(?:es|ser[ií]a)`)}`,
        String.raw`${palavra(String.raw`isso|esto|eso|essa\s+(?:mancha|pinta|les[aã]o|ferida)|esa\s+(?:mancha|pinta|lesi[oó]n|herida)`)}\s+` +
          String.raw`(?:[eé]|es|ser[ií]a)\s+${ARTIGO}${palavra(DOENCAS)}`,
      ].join('|'),
      'iu',
    ),
    hipoteseDesarma: true,
  },
  {
    categoria: 'prescricao',
    padrao: new RegExp(
      [
        // Instrução negada ("não passe creme no dia do laser", "no puede aplicar crema")
        // é preparo de procedimento.
        String.raw`${NAO_NEGADO}${palavra(VERBOS_DE_USO)}\s+` +
          String.raw`(?:(?:o|a|um|uma|esse|essa|este|esta|el|la|los|las|un|una)\s+)?${palavra(REMEDIOS)}`,
        palavra(
          String.raw`receito|prescrevo|vou\s+(?:te\s+)?receitar|vou\s+(?:te\s+)?prescrever|` +
            String.raw`receto|prescribo|voy\s+a\s+(?:recetarte|prescribirte)`,
        ),
        // Dose isolada só em mg/mcg: "frasco de 200 ml" e "3 g de amostra" são produto.
        String.raw`${INICIO}\d+(?:[.,]\d+)?\s?(?:mg|mcg)${FIM}`,
        // Dose líquida só com o verbo: "tome 5 ml do xarope".
        String.raw`${NAO_NEGADO}${palavra(VERBOS_DE_USO)}\s+\d+(?:[.,]\d+)?\s?(?:ml|gotas)${FIM}`,
      ].join('|'),
      'iu',
    ),
    hipoteseDesarma: false,
  },
  {
    categoria: 'promessa_de_resultado',
    padrao: new RegExp(
      palavra(
        String.raw`cura\s+garantida|cura\s+garantizada|resultado\s+garantido|resultado\s+garantizado|` +
          String.raw`garant[ií]a\s+de\s+(?:resultado|cura)|[eé]xito\s+garantizado|sucesso\s+garantido|` +
          String.raw`100\s*%\s+de\s+(?:cura|sucesso|efic[aá]cia|[eé]xito|eficacia|mejora)|` +
          String.raw`garanto\s+(?:o\s+resultado|a\s+cura|que\s+(?:vai|ir[aá])\s+(?:curar|sarar|sumir|melhorar|resolver))|` +
          String.raw`garantizo\s+(?:el\s+resultado|la\s+cura|que\s+(?:va|va\s+a)\s+(?:curar|sanar|desaparecer|mejorar|resolverse?))|` +
          String.raw`(?:vai|ir[aá])\s+(?:curar|sumir)\s+com\s+certeza|(?:va|va\s+a)\s+(?:curar|desaparecer)\s+con\s+certeza`,
      ),
      'iu',
    ),
    hipoteseDesarma: false,
  },
  {
    categoria: 'afirmacao_oncologica',
    padrao: new RegExp(
      String.raw`${palavra(String.raw`[eé]|es|seja|ser[ií]a|parece(?:\s+ser)?|trata-se\s+de|se\s+trata\s+de|tem\s+cara\s+de|tiene\s+cara\s+de|tiene\s+pinta\s+de`)}\s+` +
        `${ARTIGO}${palavra(ONCOLOGICO)}`,
      'iu',
    ),
    hipoteseDesarma: true,
  },
];

/** Quebra em frases para que a `?` e a hipótese valham só para a frase em que estão. */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.!?\n])\s+/u)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

export function detectarAfirmacaoClinica(texto: string): AchadoClinico {
  const achadas = new Set<CategoriaClinica>();
  for (const frase of frases(texto)) {
    // Pergunta não é afirmação: "você tem psoríase há quanto tempo?" só repete o paciente.
    const pergunta = frase.endsWith('?');
    const hipotese = HIPOTESE.test(frase);
    for (const regra of REGRAS) {
      if (!regra.padrao.test(frase)) continue;
      if (regra.hipoteseDesarma && (pergunta || hipotese)) continue;
      // Prescrição e promessa valem mesmo em pergunta ("posso te receitar…?" é oferta).
      achadas.add(regra.categoria);
    }
  }
  const categorias = [...achadas];
  return { achou: categorias.length > 0, categorias };
}

const O_QUE_FAZER: Record<CategoriaClinica, string> = {
  diagnostico: 'não diga o que a pessoa tem — só o médico, em consulta, define',
  prescricao: 'não indique remédio, pomada nem dose',
  promessa_de_resultado: 'não garanta resultado nem cura',
  afirmacao_oncologica: 'não diga que uma lesão é câncer',
};

/**
 * O erro de ensino que volta ao modelo. Diz O QUE foi barrado e O QUE escrever no
 * lugar — veto que só diz "não" faz o modelo tentar a mesma frase com outra palavra.
 */
export function renderVetoDeAfirmacaoClinica(categorias: readonly CategoriaClinica[]): string {
  const regras = categorias.map((c) => O_QUE_FAZER[c]).join('; ');
  return (
    `A mensagem não foi enviada: ela faz uma afirmação clínica (${regras}). ` +
    'Reescreva sem diagnóstico, sem indicação de tratamento e sem promessa de resultado: ' +
    'diga que quem avalia é o médico, em consulta, e ofereça o agendamento. ' +
    'Se houver sinal de urgência, abra um caso para a equipe.'
  );
}
