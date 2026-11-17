---
impacto: nada_mudou
secao: corrigido
titulo: Com uma única conexão de banco externo ativa, a consulta de receitas já escolhe essa conexão
---

A ferramenta `crm_consultar_receita` recusava toda chamada sem `connection_id` com `conexao_ambigua`, mesmo quando a empresa tinha uma única conexão de banco externo ativa. O modelo precisava de uma chamada extra de descoberta para descobrir o identificador e só então repetia a consulta — duas chamadas a mais por turno.

Agora a ferramenta conta as conexões ativas da empresa e usa a única possível. A ambiguidade só aparece quando existem duas ou mais conexões ativas de verdade, e a mensagem diz quantas são para a escolha ser feita de uma vez. Conexão desligada não entra na conta: se a única conexão cadastrada estiver desativada, a recusa tem motivo próprio e a mensagem pede que um administrador a ative. Com `connection_id` explícito nada muda. Nenhuma ação é necessária na atualização.

Contribuição de @webtecnica (#4763).
