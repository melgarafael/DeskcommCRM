---
impacto: nada_mudou
secao: corrigido
titulo: A trava de imutabilidade da versão publicada do agente cobre proposal_ai_draft_enabled e inbound_debounce_ms
---
A trava que impede mudar o conteúdo de uma versão de agente já publicada (`fn_ai_agent_version_content_immutable`) cobria só parte das colunas: `proposal_ai_draft_enabled` (a flag que decide se o agente rascunha proposta sozinho) e `inbound_debounce_ms` (a janela de rajada da configuração do agente) ficavam de fora. A tela já devolvia erro 409, mas essa era a única camada de defesa; com a service key a versão publicada podia ser reescrita em silêncio. Agora a trava cobre essas duas também, contra todas as colunas de conteúdo da tabela — sem mudança de comportamento para quem não mexer.

Contribuição de @webtecnica (#2013), fechando a #2003.