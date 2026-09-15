---
impacto: nada_mudou
secao: corrigido
titulo: Arrastar o mesmo card duas vezes seguidas no funil deixa de dar "modificado por outro usuário"
---
No funil, o primeiro arrastar de um card funcionava, mas arrastar o mesmo card de novo logo em seguida mostrava "Lead foi modificado por outro usuário. Recarregue e tente novamente.", sem ninguém mais usando, e só voltava a funcionar recarregando a página. O próprio movimento registra a mudança de etapa no histórico, e esse registro atualizava o card de novo depois que a tela já tinha guardado a versão anterior. Agora o servidor devolve a versão final do card e a tela a guarda na hora, então dá para mover o mesmo card várias vezes seguidas. Crédito: @rafaelbatistazz.
