-- 0205 — UM AGENTE PODE INDEXAR MAIS DE UM MATERIAL
--
-- ═══ O defeito, medido em produção ══════════════════════════════════════════
--
-- Subir o segundo material de um agente deixava o material com `status='ready'`
-- na tela e `chunks_count = 0` para sempre. O evento `knowledge_source.updated`
-- ficava em retentativa com:
--
--     rag-indexer.v1: createKnowledgeVersion: insert failed
--       — duplicate key value violates unique constraint "ai_kbv_version_unique"
--
-- Medido numa instalação real: cinco materiais subidos para o mesmo agente, um
-- indexou (14 trechos), quatro pararam em `pending` com `attempts=2`. A tela
-- dizia "pronto" nos cinco.
--
-- ═══ A causa é DIVERGÊNCIA, não corrida ═════════════════════════════════════
--
-- A migration 0181 mudou a semântica do número da versão: ele passou a ser
-- "a quantas indexações DESTE material", contado por `knowledge_source_id` —
-- está escrito no comentário de `lib/ai/rag/version.ts` e é o que o código faz.
--
-- O índice único não acompanhou: ele continuou em `(agent_id, version_number)`.
-- Toda fonte nova nasce com `version_number = 1`, então a segunda fonte do
-- mesmo agente colide com a primeira. **Não é uma corrida** — é determinístico:
-- um agente só consegue ter UM material indexado, para sempre, e a segunda
-- tentativa falha em silêncio do lado de quem olha a tela.
--
-- ═══ Por que DOIS índices parciais, e não um só ═════════════════════════════
--
-- As versões anteriores à 0181 têm `knowledge_source_id` NULL e continuam
-- válidas (o comentário da coluna diz isso). Trocar o índice por
-- `(knowledge_source_id, version_number)` puro deixaria essas linhas SEM
-- restrição nenhuma — em Postgres, NULL não colide com NULL —, afrouxando um
-- invariante que hoje vale. Então cada regime guarda o seu:
--
--   • fonte preenchida  → único por (knowledge_source_id, version_number);
--   • fonte NULL (legado) → único por (agent_id, version_number), como antes.

-- Dedup ANTES da constraint: se algum clone já tem duplicata do regime novo,
-- criar o índice falharia e o `update.sh` dele quebraria no meio.
delete from public.ai_knowledge_versions v
 where v.knowledge_source_id is not null
   and exists (
     select 1 from public.ai_knowledge_versions o
      where o.knowledge_source_id = v.knowledge_source_id
        and o.version_number = v.version_number
        and o.id < v.id
   );

alter table public.ai_knowledge_versions
  drop constraint if exists ai_kbv_version_unique;

drop index if exists public.ai_kbv_version_unique;

create unique index if not exists ai_kbv_version_por_fonte
  on public.ai_knowledge_versions (knowledge_source_id, version_number)
  where knowledge_source_id is not null;

create unique index if not exists ai_kbv_version_por_agente_legado
  on public.ai_knowledge_versions (agent_id, version_number)
  where knowledge_source_id is null;

comment on index public.ai_kbv_version_por_fonte is
  'O número da versão conta POR MATERIAL (semântica da 0181). O índice antigo era por agente e impedia o segundo material do mesmo agente de indexar — migration 0205.';
comment on index public.ai_kbv_version_por_agente_legado is
  'Versões anteriores à 0181 (knowledge_source_id NULL) guardam o invariante antigo, por agente. Sem ele, elas ficariam sem restrição nenhuma — NULL não colide com NULL.';
