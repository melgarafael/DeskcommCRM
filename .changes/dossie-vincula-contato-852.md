---
impacto: capacidade_nova
secao: adicionado
titulo: O dossiê do negócio passa a vincular e desvincular o contato principal
---

Negócio que nasce pelo funil sem contato não tinha conserto depois: a seção «Contato» do dossiê só sabia mostrar o vínculo ou um aviso de que ele não existia. Quem descobria mais tarde que tinha criado o card sem a pessoa certa não tinha nenhum caminho pela tela — nem para ligar o contato, nem para desfazer um vínculo errado.

Agora, no negócio sem contato, o aviso vem acompanhado do botão **Vincular contato**, que abre a busca por nome ou telefone — a mesma lista da tela de contatos, com as variações de telefone que ela já entende — e grava o vínculo na hora. Escolhida a pessoa, o dossiê passa a mostrar a ficha dela (telefone, e-mail e links) sem recarregar a página, e o bloco de pessoas relacionadas relê junto. Se o servidor recusar, o motivo que ele mandou aparece embaixo do seletor, que continua aberto para outra tentativa — sem falhar em silêncio.

Com contato vinculado, o mesmo bloco ganhou **Desvincular contato**, para desfazer o vínculo errado. Nada muda no que já funcionava: o vínculo continua sendo o mesmo `contact_id` do negócio, a edição do card não mudou, e nenhuma migração é necessária.

Contribuição de @webtecnica (#852).
