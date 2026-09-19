/**
 * Fotos do catálogo sem depender do modelo (2026-09-19).
 *
 * ─── O defeito, medido ao vivo ──────────────────────────────────────────────
 *
 * O roteiro de fotos mora no PROMPT (skill `catalogo-apresentacao`): "filtro com
 * várias motos = 1 foto de cada; use media_urls". Medido com `gpt-4o-mini`,
 * `gemini-2.5-flash-lite` e `gemini-3.1-flash-lite`: os três listaram as motos
 * em texto e NENHUM chamou `send_message` com `media_urls`. O cliente recebeu a
 * apresentação sem foto — o produto promete foto ao ofertar a moto (leva 8 da
 * skill), e a promessa é do PRODUTO, não da boa vontade do modelo.
 *
 * ─── A decisão ──────────────────────────────────────────────────────────────
 *
 * A foto NÃO é semântica: se o modelo citou uma moto do catálogo no texto, a
 * foto daquela moto existe e é a mesma que ele mandaria. Então o MOTOR a anexa:
 * captura as linhas que `crm_query_external_data` devolveu no turno, e quando o
 * `send_message` sai SEM mídia mas o corpo menciona o nome de uma moto conhecida,
 * envia UMA FOTO POR MOTO, cada uma com a LEGENDA DAQUELA MOTO (nome/ano/cor/km/
 * preço). É o formato que o dono pediu (2026-09-19): mensagem inicial em texto +
 * foto de cada moto identificada pela própria legenda + chamada final em texto.
 *
 * É o mesmo princípio do resto do harness: o modelo decide o CONTEÚDO, o motor
 * garante o que é determinístico. Se o modelo JÁ mandou fotos, a decisão dele
 * vence e nada é acrescentado.
 *
 * ─── Por que casar por NOME e não por id ────────────────────────────────────
 *
 * O modelo cita "CB 300 F Twister" no texto; não devolve ids no `body`. O casar
 * é por substring normalizada (minúsculas, sem acento, sem espaços), com piso de
 * tamanho para não casar "CB" sozinho em qualquer frase.
 */

/** Uma moto conhecida do catálogo, com os campos usados na legenda. */
export interface MotoDoCatalogo {
  /** nome como veio do banco externo (para exibição/legenda). */
  nome: string;
  /** URLs de imagem válidas (http/https), na ordem original, sem vazias. */
  fotos: string[];
  ano?: string;
  cor?: string;
  quilometragem?: string;
  preco?: string;
}

/** normaliza para casar nome: minúsculas, sem acento, espaços colapsados. */
export function normalizarNomeDeMoto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chave sem espaços (mesmo critério do `contem` do banco: "cb300f" casa "CB 300 F"). */
function chaveSemEspaco(texto: string): string {
  return normalizarNomeDeMoto(texto).replace(/\s+/g, '');
}

function textoDe(registro: Record<string, unknown>, chaves: readonly string[]): string | undefined {
  for (const chave of chaves) {
    const valor = registro[chave];
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
    if (typeof valor === 'number') return String(valor);
  }
  return undefined;
}

/**
 * Extrai as motos (nome + fotos + campos de legenda) de um resultado de
 * `crm_query_external_data`. Só entende o shape conhecido (`{ linhas: [...] }`);
 * qualquer outra coisa devolve `[]` — nunca lança, nunca inventa campo. A coluna
 * de nome é descoberta por candidatos usuais, a de imagem idem.
 */
export function extrairMotosDoResultado(resultado: unknown): MotoDoCatalogo[] {
  if (typeof resultado !== 'object' || resultado === null) return [];
  const linhas = (resultado as { linhas?: unknown }).linhas;
  if (!Array.isArray(linhas)) return [];

  const motos: MotoDoCatalogo[] = [];
  for (const linha of linhas) {
    if (typeof linha !== 'object' || linha === null) continue;
    const registro = linha as Record<string, unknown>;

    const nomeBruto = textoDe(registro, ['nome', 'modelo', 'titulo', 'descricao']);
    const imagemBruta = textoDe(registro, ['imagem_url', 'imagem', 'foto', 'fotos']);
    if (nomeBruto === undefined || imagemBruta === undefined) continue;

    const fotos = imagemBruta
      .split('|')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    if (fotos.length === 0) continue;

    motos.push({
      nome: nomeBruto,
      fotos,
      ...(textoDe(registro, ['ano']) !== undefined ? { ano: textoDe(registro, ['ano']) } : {}),
      ...(textoDe(registro, ['cor']) !== undefined ? { cor: textoDe(registro, ['cor']) } : {}),
      ...(textoDe(registro, ['quilometragem', 'km']) !== undefined
        ? { quilometragem: textoDe(registro, ['quilometragem', 'km']) }
        : {}),
      ...(textoDe(registro, ['preco', 'preço', 'valor']) !== undefined
        ? { preco: textoDe(registro, ['preco', 'preço', 'valor']) }
        : {}),
    });
  }
  return motos;
}

/** Tamanho mínimo do nome para ser casável — evita "CB" casar em qualquer frase. */
const MIN_NOME_CASAVEL = 3;
/** Teto de fotos que o motor acrescenta por turno. */
export const MAX_FOTOS_AUTO = 10;

/**
 * As motos cujo nome aparece no TEXTO da mensagem — na ordem em que aparecem no
 * catálogo, para a 1ª foto ser a 1ª moto citada quando o modelo listou na ordem
 * do resultado.
 */
export function motosCitadasNoTexto(texto: string, catalogo: readonly MotoDoCatalogo[]): MotoDoCatalogo[] {
  const alvo = normalizarNomeDeMoto(texto);
  const alvoSemEspaco = chaveSemEspaco(texto);
  const citadas: MotoDoCatalogo[] = [];
  for (const moto of catalogo) {
    const nome = normalizarNomeDeMoto(moto.nome);
    if (nome.replace(/\s+/g, '').length < MIN_NOME_CASAVEL) continue;
    if (alvo.includes(nome) || alvoSemEspaco.includes(chaveSemEspaco(moto.nome))) {
      citadas.push(moto);
    }
  }
  return citadas;
}

/** Formata preço "28990.00" → "R$ 28.990,00". Sem valor reconhecível, devolve cru. */
export function formatarPreco(preco: string | undefined): string | undefined {
  if (preco === undefined) return undefined;
  const numero = Number(preco.replace(/[^0-9.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  if (!Number.isFinite(numero)) return preco;
  return `R$ ${numero.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A legenda da foto de UMA moto — nome/ano em cima, cor/km/preço nas linhas
 * seguintes. É o que prende a imagem à moto específica (pedido direto do dono,
 * 2026-09-19): sem isto, a foto solta não diz QUAL moto é. Campos ausentes são
 * omitidos; nome sozinho ainda identifica.
 */
export function legendaDaMoto(moto: MotoDoCatalogo): string {
  const titulo = [moto.nome, moto.ano].filter((v) => v !== undefined && v !== '').join(' ');
  const linhas = [titulo];
  if (moto.cor) linhas.push(`Cor: ${moto.cor}`);
  if (moto.quilometragem) linhas.push(`Quilometragem: ${moto.quilometragem} km`);
  const preco = formatarPreco(moto.preco);
  if (preco) linhas.push(`Preço: ${preco}`);
  return linhas.join('\n');
}

/** Plano de envio determinístico: a moto e a legenda própria de cada foto. */
export interface FotoComLegenda {
  url: string;
  legenda: string;
}

/**
 * As fotos a enviar (1ª de cada moto citada) JÁ com a legenda da própria moto,
 * até `MAX_FOTOS_AUTO`. Texto sem moto conhecida ⇒ [] (o motor não inventa foto
 * de conversa genérica).
 */
export function fotosComLegenda(
  texto: string,
  catalogo: readonly MotoDoCatalogo[],
  limite = MAX_FOTOS_AUTO,
): FotoComLegenda[] {
  const plano: FotoComLegenda[] = [];
  const urlsVistas = new Set<string>();
  for (const moto of motosCitadasNoTexto(texto, catalogo)) {
    const foto = moto.fotos[0];
    if (foto === undefined || urlsVistas.has(foto)) continue;
    urlsVistas.add(foto);
    plano.push({ url: foto, legenda: legendaDaMoto(moto) });
    if (plano.length >= limite) break;
  }
  return plano;
}

/** Um parágrafo é "bloco de moto" (vai para a legenda, não para o texto)? */
function ehBlocoDeMoto(paragrafo: string, catalogo: readonly MotoDoCatalogo[]): boolean {
  const linhas = paragrafo.split('\n').map((l) => l.trim()).filter(Boolean);
  if (linhas.length === 0) return false;

  // Linha de DADO da moto — com ou sem dois-pontos (o modelo escreve das duas
  // formas: "Cor: Vermelho" e "Cor Vermelho"; idem "82.300 km", "R$ 17.990,00").
  const ehLinhaDeDado = (l: string): boolean =>
    /^(cor|quilometragem|km|pre[çc]o|valor|ano)\b/i.test(l) ||
    /^r\$\s*[\d.]+,?\d*$/i.test(l) ||
    /^[\d.]+\s*km$/i.test(l);
  if (linhas.some(ehLinhaDeDado)) return true;

  // A linha cita uma moto conhecida do catálogo?
  const citaMoto = (l: string): boolean => {
    const semEspaco = chaveSemEspaco(l);
    return catalogo.some((m) => {
      const nome = chaveSemEspaco(m.nome);
      return nome.length >= MIN_NOME_CASAVEL && semEspaco.includes(nome);
    });
  };

  // LISTA (uma moto por linha: "Nome Ano - R$ preço") ou bloco de UMA moto:
  // se TODAS as linhas citam moto conhecida, o parágrafo é dado, não conversa.
  if (linhas.length >= 1 && linhas.every(citaMoto)) return true;

  // Parágrafo curto que é apenas o nome de uma moto (com/sem ano).
  if (linhas.length <= 2) {
    const semEspaco = chaveSemEspaco(paragrafo);
    if (semEspaco === '') return false;
    return catalogo.some((m) => {
      const nome = chaveSemEspaco(m.nome);
      return (
        nome.length >= MIN_NOME_CASAVEL &&
        (semEspaco === nome || semEspaco === chaveSemEspaco(`${m.nome} ${m.ano ?? ''}`))
      );
    });
  }
  return false;
}

export interface TextoDeApresentacao {
  /** Introdução: vai ANTES das fotos ("não temos a X, mas tenho estas..."). */
  introducao: string;
  /** Pergunta(s) finais: vão DEPOIS das fotos e das legendas. */
  final: string;
}

/**
 * Separa o texto do modelo no formato do dono (2026-09-19): a lista de motos
 * SAI do texto (ela já vive na legenda de cada foto), a introdução fica antes
 * das fotos e a pergunta final fica depois. Sem esta separação, a mesma lista
 * aparece duas vezes e a pergunta chega antes das imagens.
 *
 * Regras: parágrafos que são bloco de moto saem; o ÚLTIMO parágrafo restante,
 * se contiver "?", vira `final` (é ali que o agente fecha com a pergunta de
 * avanço); o resto vira `introducao`. Assim uma saudação com "?" no meio
 * ("Tudo bem?") NÃO é arrancada da introdução. Sem pergunta no fim ⇒ `final`
 * vazio (o motor não inventa pergunta).
 */
export function separarTextoApresentacao(
  texto: string,
  catalogo: readonly MotoDoCatalogo[],
): TextoDeApresentacao {
  const paragrafos = texto
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && !ehBlocoDeMoto(p, catalogo));

  if (paragrafos.length === 0) return { introducao: '', final: '' };

  const ultimo = paragrafos[paragrafos.length - 1]!;
  if (/\?/.test(ultimo)) {
    return {
      introducao: paragrafos.slice(0, -1).join('\n\n'),
      final: ultimo,
    };
  }
  return { introducao: paragrafos.join('\n\n'), final: '' };
}
