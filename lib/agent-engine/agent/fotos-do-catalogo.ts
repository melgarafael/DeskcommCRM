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
  /** Cilindrada (coluna configurada); ausente = o motor extrai do nome. */
  cilindrada?: string;
  /** Tipo (street/trail/...), quando houver coluna. */
  tipo?: string;
  /** Estoque, quando houver coluna (usado só se o dono marcar "Mostrar"). */
  estoque?: string;
  /**
   * Valores CRUS das colunas marcadas para exibição (C-067), por nome de coluna.
   * Permite exibir coluna sem papel (ex.: `marca`, `potencia`).
   */
  valores?: Record<string, string>;
}

/** Um campo exibido na legenda: coluna real + papel (para rótulo), se houver. */
export interface CampoDaMoto {
  coluna: string;
  papel: string | null;
}

/** Rótulo bonito por papel; coluna sem papel usa o próprio nome. */
const ROTULO_POR_PAPEL: Record<string, string> = {
  cor: 'Cor',
  km: 'Quilometragem',
  preco: 'Preço',
  tipo: 'Tipo',
  cilindrada: 'Cilindrada',
  estoque: 'Estoque',
  versao: 'Versão',
  ano: 'Ano',
};

function humanizarColuna(coluna: string): string {
  const t = coluna.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
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

/** Colunas do catálogo configurado (migration 0244) — `nome` é obrigatória. */
export interface ColunasDoCatalogo {
  nome: string;
  /**
   * Colunas que COMPÕEM o nome da moto, na ordem: sempre o `nome` + as marcadas
   * como prioridade 1 (ex.: `nome` + `versao` = "Biz 125 Flex"). Ausente ⇒ só o
   * `nome` (comportamento antigo).
   */
  nomeComposto?: readonly string[];
  versao?: string;
  ano?: string;
  cor?: string;
  km?: string;
  preco?: string;
  imagem?: string;
  estoque?: string;
  cilindrada?: string;
  tipo?: string;
  /** Colunas marcadas para aparecer na legenda (C-067), por nome. */
  legendaColunas?: readonly string[];
}

/** Lê o campo pela coluna configurada; sem config, pelos nomes usuais. */
function valorDe(
  registro: Record<string, unknown>,
  colunas: ColunasDoCatalogo | undefined,
  papel: Exclude<keyof ColunasDoCatalogo, 'nomeComposto'>,
  candidatos: readonly string[],
): string | undefined {
  const col = colunas?.[papel];
  if (typeof col === 'string') return textoDe(registro, [col]);
  return textoDe(registro, candidatos);
}

/**
 * O NOME da moto a partir das colunas de prioridade 1 (ex.: `nome` + `versao` =
 * "Biz 125 Flex"), na ordem em que vieram no mapeamento. Sem composição
 * configurada, é o comportamento antigo: só a coluna de nome (ou os candidatos
 * usuais quando não há mapeamento).
 */
function nomeCompostoDe(
  registro: Record<string, unknown>,
  colunas: ColunasDoCatalogo | undefined,
): string | undefined {
  const cols = colunas?.nomeComposto;
  if (cols !== undefined && cols.length > 1) {
    // Junta as partes SEM REPETIR: se a versão já está contida no nome (dado
    // duplicado, ex.: nome e versao = "CB 300 F Twister"), ela é omitida — mas
    // quando ACRESCENTA (versao "FLEX"), entra normalmente.
    const partes: string[] = [];
    for (const col of cols) {
      const valor = textoDe(registro, [col]);
      if (valor === undefined) continue;
      const norm = normalizarNomeDeMoto(valor);
      const repetida =
        norm !== '' &&
        partes.some((p) => {
          const pn = normalizarNomeDeMoto(p);
          return pn === norm || pn.includes(norm) || norm.includes(pn);
        });
      if (!repetida) partes.push(valor);
    }
    if (partes.length > 0) return partes.join(' ').replace(/\s+/g, ' ').trim();
  }
  return valorDe(registro, colunas, 'nome', ['nome', 'modelo', 'titulo', 'descricao']);
}

/**
 * Extrai as motos (nome + fotos + campos de legenda) de um resultado de
 * `crm_query_external_data`. Só entende o shape conhecido (`{ linhas: [...] }`);
 * qualquer outra coisa devolve `[]` — nunca lança, nunca inventa campo.
 *
 * Com `colunas` (mapeamento configurado na tela), usa os nomes REAIS de cada
 * coluna; sem ele, descobre por candidatos usuais (retrocompatível com quem
 * ainda não configurou o catálogo).
 */
/**
 * Remove uma coluna do resultado da tool antes de ele chegar à IA. Usado para a
 * coluna de REFERÊNCIA de similares (`moto_similar`): o motor lê o valor por
 * dentro (via `extrairMotosDoResultado`), mas a IA NUNCA pode vê-lo — senão
 * ofereceria as referências como se fossem estoque.
 */
export function redigirColunaDoResultado(resultado: unknown, coluna: string | null): unknown {
  if (coluna === null || coluna === '' || resultado === null || typeof resultado !== 'object') {
    return resultado;
  }
  const r = resultado as { colunas?: unknown; linhas?: unknown };
  const saida: Record<string, unknown> = { ...(resultado as Record<string, unknown>) };
  if (Array.isArray(r.colunas)) {
    saida.colunas = r.colunas.filter((c) => c !== coluna);
  }
  if (Array.isArray(r.linhas)) {
    saida.linhas = r.linhas.map((linha) => {
      if (linha === null || typeof linha !== 'object') return linha;
      const copia: Record<string, unknown> = { ...(linha as Record<string, unknown>) };
      delete copia[coluna];
      return copia;
    });
  }
  return saida;
}

export function extrairMotosDoResultado(
  resultado: unknown,
  colunas?: ColunasDoCatalogo,
): MotoDoCatalogo[] {
  if (typeof resultado !== 'object' || resultado === null) return [];
  const linhas = (resultado as { linhas?: unknown }).linhas;
  if (!Array.isArray(linhas)) return [];

  const motos: MotoDoCatalogo[] = [];
  for (const linha of linhas) {
    if (typeof linha !== 'object' || linha === null) continue;
    const registro = linha as Record<string, unknown>;

    const nomeBruto = nomeCompostoDe(registro, colunas);
    const imagemBruta = valorDe(registro, colunas, 'imagem', ['imagem_url', 'imagem', 'foto', 'fotos']);
    if (nomeBruto === undefined || imagemBruta === undefined) continue;

    const fotos = imagemBruta
      .split('|')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    if (fotos.length === 0) continue;

    const ano = valorDe(registro, colunas, 'ano', ['ano']);
    const cor = valorDe(registro, colunas, 'cor', ['cor']);
    const km = valorDe(registro, colunas, 'km', ['quilometragem', 'km']);
    const preco = valorDe(registro, colunas, 'preco', ['preco', 'preço', 'valor']);
    const cilindrada = valorDe(registro, colunas, 'cilindrada', ['cilindrada', 'cc']);
    const tipo = valorDe(registro, colunas, 'tipo', ['tipo', 'categoria']);
    const estoque = valorDe(registro, colunas, 'estoque', ['estoque', 'quantidade', 'qtd']);

    // Valores crus de TODAS as colunas da linha. É a fonte da legenda (C-067) e
    // da comparação genérica por coluna (F1/F2) — inclusive colunas SEM papel
    // (ex.: `marca`, `categoria`) marcadas como "Mostrar"/"Comparar" na tela.
    const valores: Record<string, string> = {};
    for (const col of Object.keys(registro)) {
      const v = textoDe(registro, [col]);
      if (v !== undefined) valores[col] = v;
    }

    motos.push({
      nome: nomeBruto,
      fotos,
      ...(ano !== undefined ? { ano } : {}),
      ...(cor !== undefined ? { cor } : {}),
      ...(km !== undefined ? { quilometragem: km } : {}),
      ...(preco !== undefined ? { preco } : {}),
      ...(cilindrada !== undefined ? { cilindrada } : {}),
      ...(tipo !== undefined ? { tipo } : {}),
      ...(estoque !== undefined ? { estoque } : {}),
      ...(Object.keys(valores).length > 0 ? { valores } : {}),
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

/** Lê o valor de um campo: da coluna marcada (C-067) ou do campo tipado pelo papel. */
function valorDoCampo(moto: MotoDoCatalogo, campo: CampoDaMoto): string | undefined {
  if (campo.coluna !== '' && moto.valores?.[campo.coluna] !== undefined) {
    return moto.valores[campo.coluna];
  }
  switch (campo.papel) {
    case 'ano':
      return moto.ano;
    case 'cor':
      return moto.cor;
    case 'km':
      return moto.quilometragem;
    case 'preco':
      return moto.preco;
    case 'tipo':
      return moto.tipo;
    case 'cilindrada':
      return moto.cilindrada;
    case 'estoque':
      return moto.estoque;
    default:
      return campo.coluna !== '' ? moto.valores?.[campo.coluna] : undefined;
  }
}

function montarLegenda(moto: MotoDoCatalogo, campos: readonly CampoDaMoto[]): string {
  const anoCampo = campos.find((c) => c.papel === 'ano');
  const anoValor = anoCampo ? valorDoCampo(moto, anoCampo) : undefined;
  const titulo = [moto.nome, anoValor].filter((v) => v !== undefined && v !== '').join(' ');
  const linhas = [titulo];
  for (const campo of campos) {
    // `nome` já é o título; `ano` entra no título; `imagem` é a foto, não texto.
    if (campo.papel === 'nome' || campo.papel === 'imagem' || campo.papel === 'ano') continue;
    const valor = valorDoCampo(moto, campo);
    if (valor === undefined || valor === '') continue;
    if (campo.papel === 'preco') {
      const preco = formatarPreco(valor);
      if (preco) linhas.push(`Preço: ${preco}`);
      continue;
    }
    const rotulo = ROTULO_POR_PAPEL[campo.papel ?? ''] ?? humanizarColuna(campo.coluna);
    const sufixo = campo.papel === 'km' ? ' km' : '';
    linhas.push(`${rotulo}: ${valor}${sufixo}`);
  }
  return linhas.join('\n');
}

/**
 * A legenda da foto de UMA moto — nome/ano em cima e, abaixo, os campos
 * marcados. É o que prende a imagem à moto específica.
 *
 * `campos` = o que o dono marcou para exibir (migration 0250/0251), por nome de
 * coluna + papel (para o rótulo). Ausente = comportamento antigo (ano, cor, km,
 * preço). O NOME sempre aparece (é a identidade); a FOTO é a imagem.
 */
export function legendaDaMoto(moto: MotoDoCatalogo, campos?: readonly CampoDaMoto[]): string {
  if (campos === undefined) {
    return montarLegenda(moto, [
      { coluna: '', papel: 'ano' },
      { coluna: '', papel: 'cor' },
      { coluna: '', papel: 'km' },
      { coluna: '', papel: 'preco' },
    ]);
  }
  return montarLegenda(moto, campos);
}

/** Plano de envio determinístico: a moto e a legenda própria de cada foto. */
export interface FotoComLegenda {
  url: string;
  legenda: string;
}

/**
 * Plano a partir dos NOMES que o modelo informou no campo interno `motos` do
 * `send_message` (o pedido do dono, 2026-09-19: a abertura NÃO cita as motos —
 * os nomes viajam nesse campo e o sistema manda a foto/legenda de cada uma).
 * Casa tolerante (acento/caixa/espaço) e mantém a ORDEM pedida; nome sem foto
 * no catálogo é ignorado (não inventa). Sem nome reconhecido ⇒ [] (o motor cai
 * no matching por texto do `body`, comportamento anterior).
 */
/**
 * Plano de fotos a partir das motos já escolhidas (motor ou texto):
 *  - UMA só moto → até `maxPorMoto` fotos DELA (a 1ª leva a legenda; as demais
 *    sem) — o cliente pediu aquele modelo e quer VER a moto.
 *  - VÁRIAS motos → 1 foto de cada, com a legenda da própria moto.
 * Antes, o motor mandava sempre 1 foto por moto, e uma moto específica aparecia
 * com uma foto só (medido ao vivo).
 */
export function planoDeFotosDasMotos(
  motos: readonly MotoDoCatalogo[],
  maxPorMoto = 5,
  campos?: readonly CampoDaMoto[],
): FotoComLegenda[] {
  const plano: FotoComLegenda[] = [];
  const urlsVistas = new Set<string>();
  if (motos.length === 1) {
    const moto = motos[0]!;
    for (let i = 0; i < moto.fotos.length && i < maxPorMoto; i += 1) {
      const url = moto.fotos[i]!;
      if (urlsVistas.has(url)) continue;
      urlsVistas.add(url);
      plano.push({ url, legenda: i === 0 ? legendaDaMoto(moto, campos) : '' });
    }
    return plano;
  }
  for (const moto of motos) {
    const url = moto.fotos[0];
    if (url === undefined || urlsVistas.has(url)) continue;
    urlsVistas.add(url);
    plano.push({ url, legenda: legendaDaMoto(moto, campos) });
  }
  return plano;
}

/**
 * Escolhe o plano de fotos do turno: nomes explícitos do campo `motos` primeiro
 * (a abertura não cita as motos); se o modelo não informou nomes OU nenhum casou
 * no catálogo, cai no matching por texto do `body` (compatibilidade). Nunca os
 * dois (evita foto repetida) e nunca inventa: sem catálogo ⇒ [].
 */
export function planoDeFotos(
  nomes: readonly string[] | undefined,
  texto: string,
  catalogo: readonly MotoDoCatalogo[],
  campos?: readonly CampoDaMoto[],
): FotoComLegenda[] {
  if (nomes !== undefined && nomes.length > 0) {
    const motos = motosDeNomes(nomes, catalogo);
    if (motos.length > 0) return planoDeFotosDasMotos(motos, undefined, campos);
  }
  return planoDeFotosDasMotos(motosCitadasNoTexto(texto, catalogo), undefined, campos);
}

/** As motos do catálogo cujos nomes foram pedidos (ordem pedida, dedup, tolerante). */
export function motosDeNomes(
  nomes: readonly string[],
  catalogo: readonly MotoDoCatalogo[],
): MotoDoCatalogo[] {
  const motos: MotoDoCatalogo[] = [];
  const vistas = new Set<string>();
  for (const nomePedido of nomes) {
    const alvo = chaveSemEspaco(nomePedido);
    if (alvo.length < MIN_NOME_CASAVEL) continue;
    const moto =
      catalogo.find((m) => chaveSemEspaco(m.nome) === alvo) ??
      catalogo.find(
        (m) => chaveSemEspaco(m.nome).includes(alvo) || alvo.includes(chaveSemEspaco(m.nome)),
      );
    if (moto === undefined || vistas.has(moto.nome)) continue;
    vistas.add(moto.nome);
    motos.push(moto);
  }
  return motos;
}

export function fotosComLegendaDeNomes(
  nomes: readonly string[],
  catalogo: readonly MotoDoCatalogo[],
  limite = MAX_FOTOS_AUTO,
  campos?: readonly CampoDaMoto[],
): FotoComLegenda[] {
  const plano: FotoComLegenda[] = [];
  const urlsVistas = new Set<string>();
  for (const nomePedido of nomes) {
    const alvo = chaveSemEspaco(nomePedido);
    if (alvo.length < MIN_NOME_CASAVEL) continue;
    // Prefere igualdade; senão, o catálogo que CONTÉM o nome pedido.
    const moto =
      catalogo.find((m) => chaveSemEspaco(m.nome) === alvo) ??
      catalogo.find((m) => chaveSemEspaco(m.nome).includes(alvo) || alvo.includes(chaveSemEspaco(m.nome)));
    if (moto === undefined) continue;
    const foto = moto.fotos[0];
    if (foto === undefined || urlsVistas.has(foto)) continue;
    urlsVistas.add(foto);
    plano.push({ url: foto, legenda: legendaDaMoto(moto, campos) });
    if (plano.length >= limite) break;
  }
  return plano;
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
  campos?: readonly CampoDaMoto[],
): FotoComLegenda[] {
  const plano: FotoComLegenda[] = [];
  const urlsVistas = new Set<string>();
  for (const moto of motosCitadasNoTexto(texto, catalogo)) {
    const foto = moto.fotos[0];
    if (foto === undefined || urlsVistas.has(foto)) continue;
    urlsVistas.add(foto);
    plano.push({ url: foto, legenda: legendaDaMoto(moto, campos) });
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

  // LISTA (uma moto por linha: "Nome Ano - R$ preço"): só com 2+ linhas e TODAS
  // citando moto. Uma FRASE de abertura que menciona motos ("Tenho a X e a Y:")
  // é UMA linha e NÃO pode ser confundida com lista — era isso que apagava a
  // mensagem de abertura (medido 2026-09-19).
  if (linhas.length >= 2 && linhas.every(citaMoto)) return true;

  // Parágrafo que é APENAS o nome de uma moto (com/sem ano), sem frase em volta.
  const semEspaco = chaveSemEspaco(paragrafo);
  if (semEspaco !== '' && linhas.length <= 2) {
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
  if (!/\?/.test(ultimo)) {
    return { introducao: paragrafos.join('\n\n'), final: '' };
  }

  // O modelo muitas vezes escreve abertura E pergunta no MESMO parágrafo
  // ("...opções que tenho aqui. Qual delas te interessou?"). Separar só por
  // parágrafo jogaria o texto inteiro para DEPOIS das fotos (ordem invertida,
  // medido ao vivo). Aqui a cauda de frases interrogativas do último parágrafo
  // vira o `final`; o resto do parágrafo fica na introdução.
  const sentencas = ultimo
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const finalPartes: string[] = [];
  let i = sentencas.length - 1;
  while (i >= 0 && sentencas[i]!.includes('?')) {
    finalPartes.unshift(sentencas[i]!);
    i -= 1;
  }
  if (finalPartes.length === 0) {
    // Tinha "?" no meio, mas não como fecho — não arrisca: tudo na introdução.
    return { introducao: paragrafos.join('\n\n'), final: '' };
  }
  const introDoUltimo = sentencas.slice(0, i + 1).join(' ');
  const introPartes = [
    ...paragrafos.slice(0, -1),
    ...(introDoUltimo.trim() !== '' ? [introDoUltimo] : []),
  ];
  return { introducao: introPartes.join('\n\n'), final: finalPartes.join(' ') };
}
