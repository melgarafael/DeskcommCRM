-- Migration 0310: CSV como material de conhecimento (acervo de IA)
--
-- O bucket `ai-policy` (migration 0014) nasceu com `allowed_mime_types`
-- limitado a PDF/Markdown/texto puro. O pipeline de RAG passou a aceitar CSV
-- (lib/ai/rag/extractors/csv.ts, reusando o parser já usado em
-- lib/contacts/csv.ts — sem carregar SheetJS/exceljs pra um formato que todo
-- Excel já exporta) como um quarto formato de "documento". Sem este UPDATE,
-- o Storage do Supabase recusa o upload com `content-type: text/csv` ANTES
-- de qualquer código da aplicação rodar — o erro chegaria como falha de
-- upload genérica, sem relação nenhuma com "extensão não suportada".
--
-- `on conflict (id) do nothing` na 0014 significa que um clone que já tem o
-- bucket nunca mais recebe mudança de MIME daquele arquivo — este UPDATE é o
-- follow-up idempotente (re-aplicável sem efeito colateral) que alcança quem
-- já instalou.
update storage.buckets
set allowed_mime_types = array['application/pdf', 'text/markdown', 'text/x-markdown', 'text/plain', 'text/csv']
where id = 'ai-policy';
