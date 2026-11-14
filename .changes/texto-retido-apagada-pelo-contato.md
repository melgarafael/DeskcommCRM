---
impacto: capacidade_nova
secao: adicionado
titulo: O texto de uma mensagem que o contato apagou pode ser revelado com permissão por perfil e auditoria
---

Abaixo de "Esta mensagem foi apagada pelo contato" apareceu o botão **Ver texto retido**. Ao clicar, o servidor confere organização, acesso à conversa e perfil autorizado: com permissão, o texto entra no lugar do botão e o aviso de exclusão continua acima; sem permissão, a conversa mostra "Você não tem permissão para ver este texto" e **nada do conteúdo é enviado ao navegador**; se o texto não existe mais, "Texto não disponível".

Em **Configurações → Organização → Permissões**, o administrador marca um ou vários perfis autorizados (Somente leitura, Atendente, Gerente, Administrador). A lista **começa vazia** e é independente por organização — ninguém perde acesso por esta entrega. Cada clique vira uma linha de auditoria (usuário, data e hora, organização, conversa, mensagem e resultado — revelado, negado ou indisponível), sem copiar o conteúdo; as mudanças na lista de perfis também são auditadas.

O corpo de uma mensagem apagada pelo contato deixou de viajar no carregamento da conversa, na prévia da lista e na busca: revelar passou a ser a única porta, e ela é auditada.

Crédito: @webtecnica.
