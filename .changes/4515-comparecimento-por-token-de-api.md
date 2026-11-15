---
impacto: capacidade_nova
secao: adicionado
titulo: Integração por token registra comparecimento na agenda, com escopo próprio
---

Marcar que a pessoa foi atendida, ou que faltou, sempre foi decisão de gente na
Agenda — e continua sendo o caminho padrão. Quem integra o CRM por token passa a
poder fazer o mesmo, e só com o escopo novo `agenda:attendance`, concedido por
quem emite o token na tela de Chaves de API. O `mcp:write` que as integrações já
têm não basta: dizer que alguém faltou devolve o horário para outra pessoa, e quem
emite o token decide se aquela integração tem esse poder.

A regra não foi afrouxada no código. O banco recusa `Realizado` e `Não compareceu`
sem pessoa logada, e a integração entra por service role — por isso a liberação é
uma porta só, um RPC que confere o token e chama a mesma função que a tela chama.
O carimbo do desfecho passa a guardar qual token registrou, então "quem marcou?"
tem resposta no banco e não só no log de auditoria. Na Agenda, o detalhe do
compromisso diz "Presença registrada por uma integração (token de API)" quando
foi o token que marcou, em vez de atribuir a marcação à equipe.

Para conceder, marque na mesma tela também "Agentes de IA podem AGIR no CRM
(MCP)" e "Tratar o token como gerente": a rota da agenda cobra os dois, e a
caixa do escopo novo agora avisa isso.

A recusa de quem não tem o escopo nomeia o escopo na resposta. O agente de IA
continua propondo a marcação em vez de registrar.
