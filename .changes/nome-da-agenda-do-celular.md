---
impacto: capacidade_nova
secao: adicionado
titulo: A caixa de entrada mostra o nome salvo na agenda do celular, só para a equipe
---

Contato que está salvo no WhatsApp do celular e não tem apelido no perfil chegava na caixa de entrada só com o telefone. Agora, a cada 10 minutos, o sistema pergunta ao canal o nome que está na agenda do aparelho (quando a conexão guarda o acervo do número) e o mostra na caixa de entrada, na lista de contatos e na ficha, no campo "Nome na agenda do celular".

Esse nome é só da equipe: ele nunca entra no `{{nome}}` das mensagens automáticas, das campanhas nem das respostas rápidas, porque é o apelido que alguém da empresa escreveu no celular e pode não ser para o cliente ver. Para usá-lo numa mensagem, copie-o para o nome do contato na ficha. Nome que você já digitou no CRM, ou que veio da planilha, continua o que está e continua sendo o que aparece primeiro.

Vale também para quem usa a conexão oficial junto com o app WhatsApp Business: o nome que a equipe dá ao contato no app passa a ir para esse mesmo campo, e não mais para o nome de exibição (que as campanhas usam). Nomes que já tinham chegado por esse caminho antes desta versão continuam onde estão: não há como separá-los do apelido do perfil.

LGPD: ao anonimizar um contato, o nome da agenda é apagado junto. Quando o titular pede acesso aos dados dele, o nome da agenda entra no arquivo de dados (`data.json`, campo `address_book_name`). Fora do Brasil o titular recebe esse arquivo, então recebe o nome. No Brasil o arquivo fica guardado com a cópia, mas não é enviado, e o PDF que o titular recebe não mostra o nome da agenda.

Contribuição de @felpzGondim (#2439), a primeira dele no projeto.
