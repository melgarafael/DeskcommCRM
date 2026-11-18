---
impacto: capacidade_nova
secao: adicionado
titulo: Integração por token pode criar, editar, concluir e excluir tarefas da equipe
---

Quem integra o CRM por token não conseguia mexer nas tarefas: as rotas só
aceitavam sessão de navegador, e o token recebia 401 antes de qualquer regra de
negócio rodar. Na prática, uma integração que abria uma pendência a partir de
uma ligação tinha de pedir para alguém abrir a tela e digitar.

Agora a porta existe, com escopo próprio concedido por quem emite o token na
tela de Tokens de API: `tasks:read` para listar e `tasks:write` para criar,
editar, concluir e excluir. Os escopos são separados do `mcp:write` de
propósito — apagar tarefa some da rotina de alguém; quem emite o token decide se
a integração tem esse poder.

A regra é a mesma da tela, não uma segunda: a rota e a ferramenta do agente
chamam a mesma função do handler. Isso mantém o isolamento por organização em
toda consulta e faz a criação aceitar chave de idempotência — repetir a chamada
com a mesma chave devolve a mesma tarefa em vez de criar outra. Tarefa criada
por token não tem autor humano (`created_by` fica nulo), e o log de auditoria
passa a registrar qual token agiu (#4516).
