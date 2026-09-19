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
 * inclui a 1ª URL dela. A legenda (o texto do modelo) segue na 1ª foto.
 *
 * É o mesmo princípio do resto do harness: o modelo decide o CONTEÚDO, o motor
 * garante o que é determinístico. Se ele JÁ mandou fotos, nada é acrescentado —
 * a decisão dele vence.
 *
 * ─── Por que casar por NOME e não por id ────────────────────────────────────
 *
 * O modelo cita "CB 300 F Twister" no texto; não devolve ids no `body`. O casar
 * é por substring normalizada (minúsculas, sem acento, espaços colapsados), com
 * piso de tamanho para não casar "CB" sozinho em qualquer frase. O risco de
 * casar a moto errada é baixo (nome de moto é específico) e o custo é a foto
 * certa da moto que o modelo decidiu ofertar.
 */

/** Uma moto conhecida do catálogo, com as fotos na ordem em que vieram. */
export interface MotoDoCatalogo {
  /** nome como veio do banco externo (para exibição/diagnóstico). */
  nome: string;
  /** URLs de imagem válidas (http/https), na ordem original, sem vazias. */
  fotos: string[];
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

/**
 * Chave de casamento TOLERANTE A ESPAÇOS: remove todos os espaços. É o mesmo
 * critério do `contem` do banco externo (C-008), que junta "cb300f" e
 * "cb 300 f twister" — o modelo tanto escreve "CB 300 F Twister" quanto
 * "cb300f twister", e os dois precisam casar a MESMA moto.
 */
function chaveSemEspaco(texto: string): string {
  return normalizarNomeDeMoto(texto).replace(/\s+/g, '');
}

/**
 * Extrai as motos (nome + fotos) de um resultado de `crm_query_external_data`.
 *
 * Só entende o shape conhecido: `{ linhas: [{ <colunaNome>: string,
 * imagem_url: string }] }`. Qualquer outra coisa devolve `[]` — nunca lança, e
 * nunca inventa campo. A coluna de nome é descoberta por candidatos usuais
 * (`nome`, `modelo`, `titulo`) e a de imagem por (`imagem_url`, `imagem`, `foto`).
 */
export function extrairMotosDoResultado(resultado: unknown): MotoDoCatalogo[] {
  if (typeof resultado !== 'object' || resultado === null) return [];
  const linhas = (resultado as { linhas?: unknown }).linhas;
  if (!Array.isArray(linhas)) return [];

  const motos: MotoDoCatalogo[] = [];
  for (const linha of linhas) {
    if (typeof linha !== 'object' || linha === null) continue;
    const registro = linha as Record<string, unknown>;

    const nomeBruto = primeiroTexto(registro, ['nome', 'modelo', 'titulo', 'descricao']);
    const imagemBruta = primeiroTexto(registro, ['imagem_url', 'imagem', 'foto', 'fotos']);
    if (nomeBruto === null || imagemBruta === null) continue;

    const fotos = imagemBruta
      .split('|')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    if (fotos.length === 0) continue;

    motos.push({ nome: nomeBruto, fotos });
  }
  return motos;
}

function primeiroTexto(registro: Record<string, unknown>, chaves: readonly string[]): string | null {
  for (const chave of chaves) {
    const valor = registro[chave];
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
  }
  return null;
}

/** Tamanho mínimo do nome para ser casável — evita "CB" casar em qualquer frase. */
const MIN_NOME_CASAVEL = 3;
/** Teto de fotos que o motor acrescenta por turno (schemas típicos mandam ≤10). */
export const MAX_FOTOS_AUTO = 10;

/**
 * As motos cujo nome aparece no TEXTO da mensagem — na ordem em que aparecem no
 * catálogo, para a 1ª foto (a que leva legenda) ser a 1ª moto citada quando o
 * modelo listou na ordem do resultado.
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

/**
 * As URLs a anexar quando o modelo não mandou mídia: a 1ª foto de cada moto
 * citada no texto, até `MAX_FOTOS_AUTO`. Texto sem moto conhecida ⇒ [] (o motor
 * não inventa foto de conversa genérica).
 */
export function fotosParaAnexar(
  texto: string,
  catalogo: readonly MotoDoCatalogo[],
  limite = MAX_FOTOS_AUTO,
): string[] {
  const urls: string[] = [];
  const vistas = new Set<string>();
  for (const moto of motosCitadasNoTexto(texto, catalogo)) {
    const foto = moto.fotos[0];
    if (foto === undefined || vistas.has(foto)) continue;
    vistas.add(foto);
    urls.push(foto);
    if (urls.length >= limite) break;
  }
  return urls;
}
