---
impacto: nada_mudou
secao: corrigido
titulo: Dois stacks locais no mesmo host deixam de semear o banco um do outro
---

Quem mantém mais de um checkout do CRM rodando ao mesmo tempo na mesma máquina — cada stack com o próprio `project_id` e a própria faixa de portas — deixa de ver os dados de teste de uma sessão aparecerem no banco da outra. O arquivo `.env.e2e`, que os scripts de seed usam para abrir conexão direta com o banco, passa a receber a porta do Postgres do stack que está de pé, e não mais um endereço fixo da porta padrão: antes, com dois stacks no ar, a segunda sessão semeava o banco da primeira — conexão válida, schema idêntico, suíte verde e o estrago invisível, que é o que fazia o problema sobreviver sem queixa.

Quando o stack não devolve a URL de conexão, o gerador do `.env.e2e` agora recusa a gerar o arquivo e diz o que faltou, em vez de gravar a porta padrão em silêncio na esperança de acertar. Os scripts de verificação passam a cobrir isso: um teste de shell sobe um stack falso fora da porta padrão e exige que o arquivo gerado acompanhe a porta daquele stack, para que a volta do endereço fixo reprove em vez de passar despercebida.

Na sua instalação na VPS, nada muda: é o ambiente de desenvolvimento e de testes que fica correto.
