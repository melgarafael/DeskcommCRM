---
impacto: capacidade_nova
secao: adicionado
titulo: Automação nova « Mensagem para a equipe », e o e-mail da automação passa a poder ir para uma pessoa da equipe com o resumo do negócio
---
Nas automações, a ação nova « Mensagem para a equipe » manda para o WhatsApp
cadastrado em Avisos um resumo do negócio, pensado para a virada para ganho: o
nome da regra, o primeiro nome do cliente, o telefone, o valor, a pontuação e
um atalho para o negócio no CRM (o atalho aparece quando a instalação tem
endereço público). O título do negócio e o que foi conversado com o cliente não
vão na mensagem. A ação não pede número nem pessoa: o destino é sempre o de
Avisos.

Na ação « Enviar e-mail », o destinatário ganha a opção « E-mail de uma pessoa
da equipe ». O endereço vem do acesso da pessoa, e o vínculo com a empresa é
conferido na hora do envio: quem foi removido da organização não recebe, e a aba
Atividade diz por quê. O modelo do e-mail ganha a variável {{resumo}}, com o
mesmo resumo do negócio. O limite de envios por organização vale igual. Nada a
fazer na atualização.

Desenho e código de @webtecnica (#2642, PR #2834).
