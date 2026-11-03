/**
 * A MOLDURA DA MÍDIA — o texto que embrulha a transcrição/descrição de uma mídia
 * do cliente antes de ela ir ao modelo, e o caminho de volta.
 *
 * O embrulho existe para o MODELO: sem ele, o agente via a transcrição e ainda
 * respondia "não consigo ouvir áudio" por reflexo (Onda 3). Só que o mesmo corpo
 * composto também chega a quem LÊ — a lista de falas pendentes do turno vira
 * "Últimas palavras do cliente" no cartão da passagem — e lá a instrução ao
 * modelo ("NUNCA responda que não consegue ver/ouvir mídia…") aparecia como se o
 * cliente a tivesse dito. Quem assume a conversa lia o prompt do sistema entre
 * aspas, no lugar da fala.
 *
 * Por isso o formato e a sua leitura moram no MESMO arquivo: quem mudar a
 * moldura muda o desembrulho junto, e o teste de ida e volta
 * (`tests/unit/moldura-de-midia.test.ts`) reprova se um dos dois ficar para trás.
 *
 * Módulo puro, sem import: é lido tanto pelo motor (`get-lead-context.ts`)
 * quanto pela montagem do briefing (`lib/escalacao/briefing-da-passagem.ts`).
 */

/** Substantivo pt-br por tipo de mídia (p/ o enquadramento do derivado). */
const MEDIA_NOUN: Record<string, string> = {
  image: 'uma imagem',
  video: 'um vídeo',
  audio: 'um áudio',
  document: 'um documento (PDF)',
  sticker: 'uma figurinha',
};

/** O rótulo curto que a PESSOA lê no lugar da moldura, por tipo de mídia. */
const ROTULO_PARA_QUEM_LE: Record<string, string> = {
  image: '[imagem]',
  video: '[vídeo]',
  audio: '[áudio]',
  document: '[documento]',
  sticker: '[figurinha]',
};

/** Como toda mídia enquadrada começa — `textoDoClienteNaUltimaMensagem` a reconhece por ela. */
export const INICIO_DA_MOLDURA_DE_MIDIA = '[Mídia do cliente:';

const PREFIXO_DA_LEGENDA = 'Legenda do cliente: ';
const PREFIXO_DO_CONTEUDO = 'Conteúdo: ';

/**
 * Enquadra o derivado de mídia como PERCEPÇÃO do agente (Onda 3, ajuste pós-prova).
 * Sem isto, o modelo via a transcrição/descrição mas respondia "não consigo ver
 * mídia" por reflexo. O enquadramento diz explicitamente: o conteúdo já foi
 * processado; trate como se tivesse visto/ouvido; nunca negue a mídia. Legenda do
 * cliente (se houver) e conteúdo derivado coexistem. @internal exposto p/ teste.
 */
export function frameMediaBody(type: string, caption: string | null, derived: string): string {
  const noun = MEDIA_NOUN[type] ?? 'uma mídia';
  const parts = [
    `${INICIO_DA_MOLDURA_DE_MIDIA} ele enviou ${noun} e o sistema já processou o conteúdo pra você. ` +
      `Trate o texto abaixo como se você mesma tivesse visto/ouvido — NUNCA responda que não ` +
      `consegue ver/ouvir mídia. Comente ou use o conteúdo naturalmente.]`,
  ];
  if (caption && caption.trim() !== '') parts.push(`${PREFIXO_DA_LEGENDA}${caption.trim()}`);
  parts.push(`${PREFIXO_DO_CONTEUDO}${derived}`);
  return parts.join('\n');
}

/** O tipo de mídia que a primeira linha da moldura declara, ou `null`. */
function tipoDaMoldura(primeiraLinha: string): string | null {
  for (const [tipo, noun] of Object.entries(MEDIA_NOUN)) {
    if (primeiraLinha.includes(` ele enviou ${noun} `)) return tipo;
  }
  return null;
}

/**
 * O que a PESSOA deve ler de uma fala do cliente: a mesma string quando ela não
 * é mídia enquadrada; sem a instrução ao modelo quando é.
 *
 * O que sobra depende de quem produziu o texto, porque o cartão promete "palavras
 * dele" e as cita entre aspas:
 *   · áudio — a transcrição É a fala do cliente: `[áudio] <transcrição>`;
 *   · imagem, vídeo, documento, figurinha — o "conteúdo" é uma DESCRIÇÃO feita
 *     pela IA, não algo que o cliente disse; fica só a legenda que ele escreveu,
 *     se houver: `[imagem] <legenda>` ou só `[imagem]`.
 *
 * Moldura cortada (o orçamento de contexto corta corpos longos ao meio) ou de
 * tipo desconhecido degrada para o rótulo, nunca devolve a instrução.
 */
export function falaDoClienteSemMoldura(texto: string): string {
  if (!texto.startsWith(INICIO_DA_MOLDURA_DE_MIDIA)) return texto;

  const fimDaPrimeiraLinha = texto.indexOf('\n');
  const primeiraLinha = fimDaPrimeiraLinha === -1 ? texto : texto.slice(0, fimDaPrimeiraLinha);
  const resto = fimDaPrimeiraLinha === -1 ? '' : texto.slice(fimDaPrimeiraLinha + 1);
  const tipo = tipoDaMoldura(primeiraLinha);
  const rotulo = (tipo !== null ? ROTULO_PARA_QUEM_LE[tipo] : undefined) ?? '[mídia]';

  // O conteúdo é sempre o ÚLTIMO bloco que a moldura escreve, e a legenda (se
  // houver) vem antes dele. Procurar o primeiro `\nConteúdo: ` depois da linha
  // da instrução separa os dois mesmo com legenda de várias linhas.
  const comQuebra = `\n${resto}`;
  const posConteudo = comQuebra.indexOf(`\n${PREFIXO_DO_CONTEUDO}`);
  const antesDoConteudo = posConteudo === -1 ? comQuebra : comQuebra.slice(0, posConteudo);
  const conteudo = posConteudo === -1 ? '' : comQuebra.slice(posConteudo + 1 + PREFIXO_DO_CONTEUDO.length);

  const posLegenda = antesDoConteudo.indexOf(`\n${PREFIXO_DA_LEGENDA}`);
  const legenda = posLegenda === -1 ? '' : antesDoConteudo.slice(posLegenda + 1 + PREFIXO_DA_LEGENDA.length);

  const fala = (tipo === 'audio' ? conteudo : legenda).trim();
  return fala === '' ? rotulo : `${rotulo} ${fala}`;
}
