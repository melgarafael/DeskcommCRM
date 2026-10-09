/**
 * Evidências já consultadas pelo servidor NESTE turno. Não são uma lista de
 * exceções: o classificador continua lendo a candidata inteira e suas condições.
 * Não recebe histórico, notas do contato, prompt do agente ou argumentos de tool.
 */
export interface EvidenciaComercial {
  origem: "catalogo" | "conhecimento";
  referencia: string;
  titulo: string;
  conteudo: string;
}

import { canonizarTipoDeFonte, type TipoDeFonteId } from "@/lib/ai/rag/tipos-de-fonte";
import type { Queryable } from "../../queue/queue";

/**
 * Lista de PERMISSÃO, não de bloqueio: "Conversas anteriores" guarda o que o
 * CLIENTE escreveu, e um cliente não autoriza oferta. Tipo legado é canonizado
 * antes (`conversations` vira `conversas`), e tipo desconhecido fica de fora.
 */
const TIPOS_QUE_PROVAM_OFERTA: ReadonlySet<TipoDeFonteId> = new Set(["faq", "documento", "catalogo"]);

export function fontesQueProvamOferta(
  fontes: readonly { id: string; source_type: string }[],
): string[] {
  return fontes
    .filter((f) => {
      const tipo = canonizarTipoDeFonte(f.source_type);
      return tipo !== null && TIPOS_QUE_PROVAM_OFERTA.has(tipo);
    })
    .map((f) => f.id);
}

/** Fontes do agente que podem provar oferta. Org da linha do job, nunca do modelo. */
export async function carregarFontesQueProvamOferta(
  db: Queryable,
  tenantId: string,
  fontesDoAgente: readonly string[],
): Promise<string[]> {
  if (fontesDoAgente.length === 0) return [];
  const { rows } = await db.query<{ id: string; source_type: string }>(
    "select id::text as id, source_type from ai_knowledge_sources where organization_id = $1 and id = any($2::uuid[])",
    [tenantId, fontesDoAgente],
  );
  return fontesQueProvamOferta(rows);
}

const MAX_EVIDENCIAS = 20;
const MAX_CARACTERES = 16_000;
const MAX_POR_EVIDENCIA = 4_000;

function objeto(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function criarEvidenciasComerciaisDoTurno(fontesHabilitadas: readonly string[]) {
  const fontes = new Set(fontesHabilitadas);
  const evidencias = new Map<string, EvidenciaComercial>();

  function guardar(evidencia: EvidenciaComercial) {
    const chave = `${evidencia.origem}:${evidencia.referencia}`;
    evidencias.delete(chave);
    // Nunca cortar uma frase: a ressalva no fim pode mudar toda a autorização.
    if (JSON.stringify(evidencia).length > MAX_POR_EVIDENCIA) return;
    evidencias.set(chave, evidencia);
    while (
      evidencias.size > MAX_EVIDENCIAS ||
      JSON.stringify([...evidencias.values()]).length > MAX_CARACTERES
    ) {
      const primeira = evidencias.keys().next().value;
      if (primeira === undefined) break;
      evidencias.delete(primeira);
    }
  }

  function registrarConhecimento(resultado: unknown) {
    const r = objeto(resultado);
    if (!r || r.error || r.erro || r.ok === false) return;
    const trechos = r.results ?? r.trechos;
    if (!Array.isArray(trechos)) return;
    for (const item of trechos) {
      const t = objeto(item);
      if (!t) continue;
      const fonte = texto(t.knowledge_source_id);
      const id = texto(t.chunk_id);
      const conteudo = texto(t.content);
      // Nem outro agente, nem o índice legado sem fonte identificável autorizam
      // uma oferta aqui. A consulta original continua disponível ao Conversador.
      if (!fonte || !fontes.has(fonte) || !id || !conteudo) continue;
      guardar({
        origem: "conhecimento",
        referencia: `${fonte}:${id}`,
        titulo: texto(t.source_name) ?? "Material habilitado para o agente",
        conteudo,
      });
    }
  }

  /** Apenas retornos bem-sucedidos da busca de produtos ativos da organização. */
  function registrarCatalogo(resultado: unknown) {
    const r = objeto(resultado);
    if (!r || r.error || r.erro || r.ok === false || !Array.isArray(r.produtos)) return;
    for (const item of r.produtos) {
      const p = objeto(item);
      if (!p) continue;
      const codigo = texto(p.codigo);
      const nome = texto(p.nome);
      const descricao = texto(p.descricao);
      const preco = texto(p.preco);
      if (!codigo || !nome || !descricao || !preco || p.disponivel !== true) continue;
      guardar({
        origem: "catalogo",
        referencia: codigo,
        titulo: nome,
        conteudo: JSON.stringify({ nome, preco, descricao }),
      });
    }
  }

  return {
    registrarConhecimento,
    registrarCatalogo,
    // Cópia: consumidor não muda o estado compartilhado pelas consultas do turno.
    ler: (): EvidenciaComercial[] => [...evidencias.values()].map((e) => ({ ...e })),
  };
}
