---
impacto: exige_acao
secao: corrigido
titulo: Atribuir a conversa não derruba mais o turno que atribuiu
---

Quando o agente passava a conversa para uma pessoa e, no mesmo turno, registrava
a passagem e movia o card de etapa, só a atribuição aparecia: o cartão "Por que
a IA passou para você" não nascia e a etapa não mudava. A atribuição feita pelo
próprio turno era lida pelo banco como "uma pessoa assumiu" e cancelava o turno
no meio, e todo efeito seguinte era recusado sem aviso.

Agora a ferramenta de atribuir informa ao banco qual turno pediu a mudança, e o
banco poupa exatamente esse turno — os outros turnos da conversa continuam sendo
cancelados. A ordem das ações no mesmo turno deixou de importar.

Uma pessoa assumindo pela tela continua interrompendo o agente na hora, como
antes: a proteção não foi afrouxada, e a atribuição de uma pessoa não tem como
se declarar "turno" — o banco recusa.

## Requer atenção

Se a sua instalação tem rotina própria que chama `fn_conversation_assign`
passando os argumentos por posição, confira a chamada depois de atualizar: a
função ganhou um sétimo argumento, `p_source_job_id`, com nulo por padrão. Quem
chama por nome do argumento — todas as telas do produto — não precisa fazer
nada.
