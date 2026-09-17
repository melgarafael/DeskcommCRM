---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de mensagem nova diz quem escreveu
---

O aviso que aparece na esquina quando chega mensagem dizia sempre "Nova
mensagem", nunca o nome de quem escreveu: a leitura do contato saía sem sessão e
o banco respondia com zero linhas — sem erro, sem log, sem nada reprovando. O
aviso agora busca o contato pelo mesmo caminho autenticado que o avatar já
usava, mostra o nome (ou o telefone) de quem escreveu, e traz o botão "Abrir
conversa" para ir direto até ela. Nada a fazer na VPS além de atualizar.
