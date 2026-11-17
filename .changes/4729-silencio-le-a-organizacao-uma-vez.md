---
impacto: nada_mudou
secao: alterado
titulo: A varredura de silêncio do follow-up lê a organização e o fluxo uma vez por minuto, e não uma vez por conversa e por ponteiro
---

A varredura de silêncio do follow-up roda a cada minuto. Depois do conserto anterior (#4330), ela já lia as conversas de cada organização uma vez por rodada, mas cada linha ainda trazia o `settings` inteiro da organização (cerca de 7,7 KB repetidos em cada conversa) e o desenho do fluxo era lido de novo para cada ponteiro de silêncio ativo. Agora o status e o `settings` da organização saem de uma leitura por organização por rodada, e o desenho do fluxo de uma leitura por versão por rodada. Numa instalação com 29 ponteiros e cerca de 110 conversas abertas, isso tira, pela estimativa do autor, por volta de 850 KB de cada rodada, o que pesa na cota de tráfego do banco no Supabase Cloud. Quem recebe o follow-up continua o mesmo: organização inativa ou ausente não atende, e as tags internas da organização continuam valendo para cada conversa. Contribuição de @webtecnica.
