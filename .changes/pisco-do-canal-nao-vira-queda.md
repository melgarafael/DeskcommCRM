---
impacto: nada_mudou
secao: corrigido
titulo: Uma falha isolada da verificação não derruba mais o número, e a mensagem que esperou a conexão voltar não fica parada em silêncio
---

A verificação de saúde das conexões, que roda de 5 em 5 minutos, marcava o
número como fora do ar na primeira pergunta que falhava — e uma oscilação de
rede de um minuto bastava para isso. Nesse intervalo, o que o operador mandava
ficava "aguardando conexão" e, quando a conexão voltava, ninguém mandava de
novo. Agora a queda só vale depois de duas verificações ruins seguidas, e a
volta vale na primeira boa. E a mensagem que segue aguardando numa conexão que
já voltou abre um aviso na Central, com a conversa, para quem escreveu decidir o
que fazer: 15 minutos depois quando esperava a conexão, 50 quando ainda podia ter
nova tentativa agendada. Nada é reenviado sozinho, mensagem com mais de 24 horas
não entra, e o aviso resolvido só volta por mensagem nova. Crédito: @jmpo.
