---
impacto: nada_mudou
secao: corrigido
titulo: A caixa de entrada para de pesar por conversa: listar e contar ficam imediatos
---

Cada consulta da lista de conversas perguntava, conversa por conversa, qual era o papel de quem estava olhando e qual o escopo de visibilidade da organização. Numa instalação com poucas centenas de conversas isso custava quase um segundo só para contar a fila, e crescia com o número de conversas — nas horas de pico chegava ao limite de tempo do banco, e a tela ficava sem resposta. Agora a pergunta é feita uma única vez por consulta: contamos 142 conversas em 5 a 7 ms, contra 210 a 230 ms antes (medido em Postgres 15 e 17, no mesmo banco instalado). Quem vê o quê não mudou: o mesmo teste que fixa dono, membro, observador e fila sem responsável fica no PR, e a visibilidade foi conferida pessoa por pessoa contra a regra antiga. Nada a fazer na atualização. Crédito: @webtecnica; relato e medição de @juniorpagedown (#3090)
