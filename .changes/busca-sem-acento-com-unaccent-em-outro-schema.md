---
impacto: nada_mudou
secao: corrigido
titulo: A busca sem acento do inbox funciona também quando o banco já tinha a extensão de acentos ligada em outro lugar
---

A busca do inbox que ignora acento (trazida pelo #3924, de @webtecnica) dependia de uma extensão do Postgres que a atualização criava. Em bancos onde essa extensão já tinha sido ligada antes — o painel do Supabase na nuvem liga extensões numa área própria —, a atualização não a encontrava onde esperava: conforme o caso, a busca do inbox dava erro, ou o cadastro de contatos novos falhava, inclusive os que chegam pelo WhatsApp.

Agora a atualização procura a extensão onde ela estiver e se ajusta a ela, sem movê-la. Quem já tinha recebido a versão anterior volta ao normal ao atualizar, sem nenhuma ação manual.
