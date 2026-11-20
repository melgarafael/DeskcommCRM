---
impacto: nada_mudou
secao: corrigido
titulo: A lista de horários livres que o agente acabou de consultar deixa de ser vetada como promessa
---

Um agente de agendamento consultava a agenda, escrevia os horários livres que ela devolveu e a conferência de promessa barrava o envio como "promessa fora do playbook". Os horários barrados eram exatamente os que a consulta tinha devolvido. Depois de algumas recusas, o modelo desistia da lista e mandava uma frase vaga, sem data e sem horário, e a pessoa ficava sem saber quando podia marcar. O contorno era desligar a conferência de promessa, o que tirava a barreira contra promessa inventada em todas as outras mensagens.

A causa era a evidência não existir para esse caminho: o retorno das ferramentas de agenda do próprio sistema — a consulta de horários livres e a lista de tipos de atendimento com a duração de cada um — não era registrado como evidência do turno, embora o retorno do catálogo, do material de conhecimento e das leituras do servidor externo já fosse. Sem lastro, a conferência lia a lista copiada da ferramenta como "vaga confirmada sem comprovação".

Agora esse retorno entra na mesma evidência das outras leituras: os horários livres, o fuso da agenda, a duração do atendimento e as ressalvas que a própria consulta devolve (lista cortada, jornada não publicada, agenda externa nunca lida). A conferência não mudou de critério: a mesma frase sem a consulta continua vetada, e promessa de desconto, cortesia ou prazo sem ferramenta que a sustente continua vetada com o mesmo código. Consulta que falha não vira evidência de sucesso, e o preço cadastrado do tipo de atendimento fica de fora — a agenda relata data, horário e situação, não autoriza condição comercial.

Ajuste a partir da issue #4927.
