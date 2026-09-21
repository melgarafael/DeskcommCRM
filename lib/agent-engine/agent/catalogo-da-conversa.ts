/**
 * Catálogo APRESENTADO na conversa, com memória ENTRE turnos (2026-09-21).
 *
 * ─── O defeito, medido ao vivo ──────────────────────────────────────────────
 *
 * O agente mostrou "CB 300" (duas opções, uma foto cada). O cliente respondeu
 * **"A 2025"** — a escolha. No turno seguinte o motor não tinha mais o catálogo
 * (ele vivia só no turno em que `crm_query_external_data` foi chamado), então não
 * mandou as fotos da moto escolhida e o modelo ainda conduziu o assunto para
 * outra pergunta. A escolha do cliente ficava "solta": sem foto, sem foco.
 *
 * ─── A decisão ──────────────────────────────────────────────────────────────
 *
 * O catálogo apresentado é DADO da conversa — não semântica do modelo. O motor o
 * persiste em `conversations.metadata.agent_catalogo` (jsonb, por conversa, sem
 * migration) e, no turno seguinte, casa a ESCOLHA do cliente (nome/ano/cor) com
 * uma moto já apresentada e manda as fotos DELA — sem depender de o modelo
 * consultar o catálogo de novo.
 *
 * Por que `metadata` e não uma tabela nova: já existe, é por conversa, e nenhum
 * caminho do runtime sobrescreve o objeto inteiro (os updates de metadata são de
 * outras chaves). Um campo dedicado evitaria o custo de migration/baseline/RLS
 * para um estado efêmero de apresentação.
 *
 * ─── O casamento ────────────────────────────────────────────────────────────
 *
 * 1. Se o TEXTO do modelo (o que ele escreveu ao responder) cita UMA moto
 *    apresentada, é ela — o modelo acabou de dizer qual. Nomes "aninhados"
 *    ("CB 300" ⊂ "CB 300 F Twister") são resolvidos pelo mais específico.
 * 2. Senão, casa pela mensagem DO CLIENTE: nome, ano (19xx/20xx) ou cor — só
 *    quando o critério aponta para UMA única moto (ambiguidade não decide).
 * 3. Moto já enviada em detalhe não repete (evita spammar as mesmas fotos).
 */

import type pg from 'pg';

import { normalizarNomeDeMoto, type MotoDoCatalogo } from './fotos-do-catalogo';

/** Estado persistido por conversa. */
export interface CatalogoDaConversa {
  /** Motos apresentadas (nome + fotos + campos de legenda), mais recentes primeiro. */
  motos: MotoDoCatalogo[];
  /** Nomes (normalizados) das motos já enviadas em detalhe — não repetir. */
  detalhadas: string[];
  /**
   * TRAVA DE DECISÃO: a moto que o cliente ESCOLHEU. Uma vez escolhida, o agente
   * NÃO oferece outra — conduz ao fechamento. Só destrava (volta a `null`) quando
   * uma NOVA apresentação acontece (o cliente pediu para ver outras).
   */
  escolhida: MotoDoCatalogo | null;
}

const VAZIO: CatalogoDaConversa = { motos: [], detalhadas: [], escolhida: null };

/** Teto de motos guardadas por conversa — estado efêmero, não acervo. */
export const MAX_MOTOS_GUARDADAS = 40;

function ehMoto(valor: unknown): valor is MotoDoCatalogo {
  if (typeof valor !== 'object' || valor === null) return false;
  const m = valor as { nome?: unknown; fotos?: unknown };
  return (
    typeof m.nome === 'string' &&
    m.nome.trim() !== '' &&
    Array.isArray(m.fotos) &&
    m.fotos.length > 0 &&
    m.fotos.every((f) => typeof f === 'string')
  );
}

/** Lê o catálogo da conversa. Nunca lança: ausência/erro ⇒ vazio. */
export async function carregarCatalogoDaConversa(
  db: pg.Pool,
  organizationId: string,
  conversationId: string,
): Promise<CatalogoDaConversa> {
  try {
    const { rows } = await db.query<{ agent_catalogo: unknown }>(
      `select metadata -> 'agent_catalogo' as agent_catalogo
         from conversations
        where organization_id = $1 and id = $2`,
      [organizationId, conversationId],
    );
    const raw = rows[0]?.agent_catalogo;
    if (typeof raw !== 'object' || raw === null) return VAZIO;
    const obj = raw as { motos?: unknown; detalhadas?: unknown; escolhida?: unknown };
    return {
      motos: Array.isArray(obj.motos) ? obj.motos.filter(ehMoto) : [],
      detalhadas: Array.isArray(obj.detalhadas)
        ? obj.detalhadas.filter((d): d is string => typeof d === 'string')
        : [],
      escolhida: ehMoto(obj.escolhida) ? obj.escolhida : null,
    };
  } catch {
    return VAZIO;
  }
}

/**
 * Grava o catálogo da conversa (merge com o atual): acrescenta as motos novas
 * (dedup por nome, mais recentes primeiro, teto) e marca a moto detalhada.
 * Nunca lança para fora — estado de apresentação não derruba o turno.
 *
 * TRAVA DE DECISÃO (`escolhida`): quando o cliente escolhe uma moto, ela é
 * gravada e passa a valer até o fim da conversa. `escolhida` aceita três estados:
 *   - `MotoDoCatalogo` → grava a escolha;
 *   - `null`           → DESTRAVA (o cliente pediu para ver outras);
 *   - `undefined`      → não mexe (preserva a trava atual).
 * O motor decide qual dos três mandar; a função não infere "pediu outra" sozinha.
 */
export async function salvarCatalogoDaConversa(
  db: pg.Pool,
  organizationId: string,
  conversationId: string,
  atual: CatalogoDaConversa,
  motosNovas: readonly MotoDoCatalogo[],
  detalhada: string | null,
  escolhida: MotoDoCatalogo | null | undefined = undefined,
): Promise<void> {
  try {
    const vistas = new Set<string>();
    const motos: MotoDoCatalogo[] = [];
    for (const moto of [...motosNovas, ...atual.motos]) {
      const chave = normalizarNomeDeMoto(moto.nome);
      if (chave === '' || vistas.has(chave)) continue;
      vistas.add(chave);
      motos.push(moto);
      if (motos.length >= MAX_MOTOS_GUARDADAS) break;
    }
    const detalhadas = [...new Set(atual.detalhadas)];
    if (detalhada !== null) {
      const chave = normalizarNomeDeMoto(detalhada);
      if (chave !== '' && !detalhadas.includes(chave)) detalhadas.push(chave);
    }
    const escolhidaFinal: MotoDoCatalogo | null =
      escolhida === undefined ? atual.escolhida : escolhida;
    await db.query(
      `update conversations
          set metadata = jsonb_set(
                coalesce(metadata, '{}'::jsonb),
                '{agent_catalogo}',
                $3::jsonb,
                true
              )
        where organization_id = $1 and id = $2`,
      [organizationId, conversationId, JSON.stringify({ motos, detalhadas, escolhida: escolhidaFinal })],
    );
  } catch {
    // silencioso de propósito: memória de apresentação é best-effort.
  }
}

/** O texto contém o NOME da moto? (tolerante a acento/caixa/espaço; piso de 3). */
function textoContemNome(texto: string, nome: string): boolean {
  const alvo = normalizarNomeDeMoto(texto);
  const alvoSemEspaco = alvo.replace(/\s+/g, '');
  const n = normalizarNomeDeMoto(nome);
  if (n.replace(/\s+/g, '').length < 3) return false;
  return alvo.includes(n) || alvoSemEspaco.includes(n.replace(/\s+/g, ''));
}

/**
 * Das motos citadas, mantém só as MAXIMAIS: descarta a que é prefixo/substring de
 * outra citada mais longa ("CB 300" some quando "CB 300 F Twister" também casa).
 * É o que faz a escolha da Twister não ser confundida com a CB 300.
 */
function citadasMaximais(
  texto: string,
  candidatas: readonly MotoDoCatalogo[],
): MotoDoCatalogo[] {
  const citadas = candidatas.filter((m) => textoContemNome(texto, m.nome));
  return citadas.filter(
    (m) =>
      !citadas.some(
        (outra) =>
          outra !== m &&
          normalizarNomeDeMoto(outra.nome).includes(normalizarNomeDeMoto(m.nome)) &&
          normalizarNomeDeMoto(outra.nome).length > normalizarNomeDeMoto(m.nome).length,
      ),
  );
}

/** Anos (19xx/20xx) citados no texto. */
function anosCitados(texto: string): string[] {
  return [...texto.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => m[0]);
}

/**
 * A cor da moto aparece como PALAVRA no texto? Tolerante à flexão de gênero
 * ("vermelha" casa "Vermelho", "preta" casa "Preto"): compara o prefixo comum às
 * palavras, exigindo que falte no máximo 1 letra. Ignora cor curta/vazia.
 */
function textoContemCor(texto: string, cor: string | undefined): boolean {
  if (cor === undefined) return false;
  const c = normalizarNomeDeMoto(cor);
  if (c.length < 3) return false;
  const palavras = normalizarNomeDeMoto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  return palavras.some((p) => {
    let i = 0;
    while (i < p.length && i < c.length && p[i] === c[i]) i += 1;
    return i >= Math.min(p.length, c.length) - 1 && i >= 3;
  });
}

/**
 * A moto que o cliente ESCOLHEU, se houver exatamente uma.
 *
 * `textoDoModelo` = o que o agente escreveu no turno (diz qual moto, quando ele
 * entendeu a escolha); `textoDoCliente` = a mensagem inbound do turno. Devolve
 * `undefined` quando não há escolha clara (nenhuma, ou ambígua) — nunca chuta.
 */
export function motoEscolhidaPeloCliente(
  textoDoModelo: string,
  textoDoCliente: string,
  catalogo: readonly MotoDoCatalogo[],
  jaDetalhadas: readonly string[],
): MotoDoCatalogo | undefined {
  if (catalogo.length === 0) return undefined;
  const detalhadas = new Set(jaDetalhadas.map(normalizarNomeDeMoto));

  // (1) O modelo citou UMA moto (nome maximal) → é ela; se já foi detalhada, nada
  // a fazer (o nome aninhado "CB 300" NÃO pode reaparecer por causa disso).
  const citadasModelo = citadasMaximais(textoDoModelo, catalogo);
  if (citadasModelo.length === 1) {
    return detalhadas.has(normalizarNomeDeMoto(citadasModelo[0]!.nome))
      ? undefined
      : citadasModelo[0];
  }
  if (citadasModelo.length > 1) return undefined;

  // (2) A mensagem do CLIENTE (só entre as ainda não detalhadas): nome maximal,
  // senão ano único, senão cor única.
  const candidatas = catalogo.filter((m) => !detalhadas.has(normalizarNomeDeMoto(m.nome)));
  if (candidatas.length === 0) return undefined;
  const citadasCliente = citadasMaximais(textoDoCliente, candidatas);
  if (citadasCliente.length === 1) return citadasCliente[0];
  if (citadasCliente.length > 1) return undefined;

  const anos = anosCitados(textoDoCliente);
  if (anos.length > 0) {
    const porAno = candidatas.filter((m) => m.ano !== undefined && anos.includes(m.ano.trim()));
    if (porAno.length === 1) return porAno[0];
    if (porAno.length > 1) return undefined;
  }

  const porCor = candidatas.filter((m) => textoContemCor(textoDoCliente, m.cor));
  if (porCor.length === 1) return porCor[0];

  return undefined;
}
