---
impacto: nada_mudou
secao: corrigido
titulo: Agenda › fecharOLaco não tenta reinserir vínculo já existente com crm_lead_links
---

Em Agenda, `fecharOLaco` realizava um `insert` simples em `crm_lead_links` a cada transição de compromisso com atividade, gerando violação da restrição de unicidade `uniq_crm_lead_links_lead_target_link` (erro 23505) a partir da segunda transição. A operação agora usa `upsert` com `ignoreDuplicates: true` (`on conflict do nothing`) e registra no log eventuais falhas de escrita sem derrubar a resposta principal. Conserto referente à issue #5373.
