---
impacto: capacidade_nova
secao: adicionado
titulo: O funil ganha a aba Lista, uma página de negócios por vez, que abre mesmo em funil muito grande
---

Ao lado de **Quadro** e **Calendário**, o funil tem agora a aba **Lista**: uma linha por negócio, com etapa, valor e última atividade, **50 por página**, com **Anterior** e **Próxima**. A página é lida do banco uma de cada vez, então a Lista abre mesmo num funil com milhares de negócios, onde o quadro demora ou não carrega. Clicar numa linha abre a mesma ficha do quadro, e o **Novo Lead** funciona com a Lista aberta: o negócio criado, ou editado pela ficha, aparece na Lista sem recarregar.

A aba tem endereço próprio (`?visao=lista`): dá para colar o link, salvar nos favoritos e recarregar a página sem voltar ao quadro. A tela mostra **página X**, sem o total, porque contar o funil inteiro custaria a mesma leitura pesada que a Lista existe para evitar.

A barra de filtros ainda não alcança a aba Lista: a Lista mostra o funil inteiro, na ordem do quadro. Os filtros e a ordenação por coluna vêm numa próxima etapa. A atualização cria sozinha um índice novo em `crm_leads`, e não é preciso mexer em nada na VPS.

Contribuição de @webtecnica (#3252).
