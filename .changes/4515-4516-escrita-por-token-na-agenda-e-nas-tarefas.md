---
impacto: capacidade_nova
secao: adicionado
titulo: Integração por token pode registrar comparecimento e cuidar das tarefas da equipe
---

Quem integra o CRM por token não conseguia escrever em duas áreas que a equipe
usa todo dia. Na agenda, marcar que a pessoa foi atendida (ou que faltou) só
funcionava pela tela — o token recebia recusa, e o CRM seguia avisando "não
compareceu" para atendimento que aconteceu. Nas tarefas, nem listar: as rotas
só aceitavam sessão de navegador.

Agora as duas portas existem, com escopo próprio, concedido por quem emite o
token na tela de Tokens de API: `agenda:attendance` para registrar
comparecimento, `tasks:read` e `tasks:write` para as tarefas. Os escopos são
separados do `mcp:write` de propósito — registrar falta devolve o horário para
outra pessoa, e apagar tarefa some da rotina da equipe; quem emite o token
decide se a integração tem esses poderes.

A regra é a mesma da tela, não uma segunda: a rota e a ferramenta do agente
chamam o mesmo código que os botões chamam. Isso mantém a guarda que já
existia — compromisso que ainda não começou não aceita desfecho, nem por token
— e mantém o isolamento por organização em toda consulta. A criação de tarefa
aceita chave de idempotência: repetir a chamada com a mesma chave devolve a
mesma tarefa em vez de criar outra. O log de auditoria passa a registrar qual
token agiu (#4515, #4516).
