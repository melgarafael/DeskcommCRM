---
impacto: nada_mudou
secao: corrigido
titulo: O módulo desligado para uma empresa passa a valer nos portões de CRM B2B, setores e avisos
---

O interruptor "Módulos por empresa" já gravava a escolha de cada empresa, mas três portões de biblioteca que decidem se a rota do módulo existe — o de empresas, pessoas e importação, o de setores de atendimento e o de avisos — perguntavam só pela instalação. Agora eles recebem a empresa e aplicam a mesma regra da tela: a linha da empresa vence, sem linha ela herda a instalação, a instalação desligada continua valendo para todas e a leitura que falha fecha a porta. O filtro por setor da lista de tarefas é o primeiro chamador a passar a empresa: com o setor desligado só para ela, o filtro responde 404 como as rotas de setor. Os demais chamadores perguntam antes de saber de que empresa é a requisição e continuam, por ora, com o comportamento de antes — sem mudança para quem nunca configurou módulo por empresa. Nada a fazer na VPS.
