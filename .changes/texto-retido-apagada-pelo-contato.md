---
impacto: capacidade_nova
secao: adicionado
titulo: O texto de uma mensagem que o contato apagou pode ser revelado com permissão por perfil e auditoria
---

Quando a empresa autoriza algum perfil em **Configurações → Organização → Permissões**, abaixo de "Esta mensagem foi apagada pelo contato" aparece o botão **Ver texto retido**. Ao clicar, o servidor confere organização, acesso à conversa e perfil autorizado: com permissão, o texto entra no lugar do botão e o aviso de exclusão continua acima; sem permissão, a conversa mostra "Você não tem permissão para ver este texto" e a resposta não traz o conteúdo; se o texto não existe mais, "Texto não disponível". O botão vale para mensagens de texto; áudio transcrito apagado pelo contato não ganha o botão.

Nessa mesma tela, o administrador marca um ou vários perfis autorizados (Somente leitura, Atendente, Gerente, Administrador). A lista **começa vazia** e é independente por organização — com ela vazia, o botão não aparece e ninguém perde acesso por esta entrega. Cada clique vira uma linha de auditoria (usuário, data e hora, organização, conversa, mensagem e resultado — revelado, negado ou indisponível), sem copiar o conteúdo; as mudanças na lista de perfis também são auditadas.

O corpo de uma mensagem apagada pelo contato deixou de vir no carregamento da conversa e na prévia da lista; na tela, revelar passa a ser este botão, com cada clique auditado.

Crédito: @webtecnica.
