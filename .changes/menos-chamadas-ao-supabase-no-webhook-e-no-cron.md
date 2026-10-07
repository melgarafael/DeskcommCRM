---
impacto: nada_mudou
secao: alterado
titulo: Cada mensagem do WhatsApp faz menos chamadas ao banco, e a conferência de mensagens presas roda a cada 5 minutos
---

Cada evento que o WhatsApp entrega ao CRM (mensagem, confirmação de leitura, mudança de estado da conexão) fazia duas consultas ao banco antes de qualquer trabalho: buscar a conexão e decifrar o segredo da assinatura. Agora o CRM guarda esse par por 30 segundos na memória, e só volta a consultar o banco depois disso. Numa instalação em produção, a busca da conexão era a chamada que mais aparecia no registro do Supabase, e o plano grátis tem um teto de registros por mês. A conexão recém-criada, a falha de consulta e o segredo trocado continuam sendo lidos do banco na hora.

A conferência de mensagens que ficaram presas em "enviando" passou de uma vez por minuto para uma vez a cada 5 minutos. Ela só marca como falha a mensagem presa há mais de 5 minutos, então rodar a cada minuto não adiantava a correção; o efeito é que uma mensagem presa pode levar até 10 minutos (antes, até 6) para aparecer como falha e gerar o aviso na Central.

Não há nada a configurar na atualização.

Contribuição de @automatikpg-ux (#2469).
