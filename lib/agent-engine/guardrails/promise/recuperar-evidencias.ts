/** Busca complementar da política citada na candidata, antes da revisão.
 * Só leitura, sem embedding/LLM, e só no índice ativo de material que pode
 * provar uma oferta. O texto seleciona a consulta, nunca autoriza a resposta.
 */
import type { Queryable } from "../../queue/queue";
import type { Logger } from "../../obs/logger";

const PALAVRAS_VAZIAS = new Set([
  "para",
  "pela",
  "pelo",
  "como",
  "com",
  "uma",
  "umas",
  "uns",
  "isso",
  "essa",
  "esse",
  "esta",
  "este",
  "voce",
  "voces",
  "sua",
  "seu",
  "suas",
  "seus",
  "temos",
  "ter",
  "pode",
  "poder",
  "quer",
  "quero",
  "ola",
  "bom",
  "dia",
  "boa",
  "oi",
  "nao",
  "sim",
  "mais",
]);

export function consultaDaCandidata(candidata: string): string {
  const palavras =
    candidata
      .toLowerCase()
      // O mesmo stemmer português trata consulta e conteúdo. Tirar acento só
      // daqui muda os radicais e deixa de encontrar matrícula/demonstração.
      .normalize("NFC")
      .match(/\p{L}+/gu) ?? [];
  return [
    ...new Set(
      palavras.filter(
        (p) =>
          p.length >= 3 && !PALAVRAS_VAZIAS.has(p.normalize("NFD").replace(/[\u0300-\u036f]/g, "")),
      ),
    ),
  ]
    .slice(0, 48)
    .join(" OR ");
}

export function criarRecuperadorDeEvidencias(
  db: Queryable,
  args: {
    tenantId: string;
    fontes: readonly string[];
    registrar: (resultado: unknown) => void;
    log: Logger;
  },
): (candidata: string) => Promise<void> {
  const consultas = new Map<string, Promise<void>>();
  return async (candidata) => {
    const consulta = consultaDaCandidata(candidata);
    if (!consulta || args.fontes.length === 0) return;
    const existente = consultas.get(consulta);
    if (existente) return existente;
    // As reformulações não podem gerar consultas ilimitadas no mesmo turno.
    if (consultas.size >= 4) return;
    const pedida = (async () => {
      try {
        const { rows } = await db.query(
          `select c.id::text as chunk_id, c.knowledge_source_id::text,
                  s.name as source_name, c.content
           from ai_chunks c
           join ai_knowledge_sources s
             on s.id = c.knowledge_source_id and s.organization_id = c.organization_id
           where c.organization_id = $1 and s.id = any($2::uuid[])
             and s.is_active and s.status = 'ready'
             and c.kb_version_id = s.active_kb_version_id
             and to_tsvector('portuguese', c.content) @@ websearch_to_tsquery('portuguese', $3)
           order by ts_rank_cd(to_tsvector('portuguese', c.content),
                              websearch_to_tsquery('portuguese', $3)) desc, c.id
           limit 5`,
          [args.tenantId, args.fontes, consulta],
        );
        args.registrar({ ok: true, results: rows });
        args.log.info("evidências complementares consultadas para revisão de promessa", {
          event: "promise_evidence_lookup",
          hits: rows.length,
        });
      } catch {
        // Falhar a consulta não pode inventar autorização nem matar o turno.
        // Não registrar texto/erro SQL: pode conter informação do atendimento.
        args.log.warn("consulta complementar de evidências indisponível", {
          event: "promise_evidence_lookup_failed",
        });
      }
    })();
    consultas.set(consulta, pedida);
    return pedida;
  };
}
