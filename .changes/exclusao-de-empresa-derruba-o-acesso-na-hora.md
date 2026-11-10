---
impacto: nada_mudou
secao: corrigido
titulo: Excluir uma empresa derruba na hora o acesso de quem era membro dela
---

Quando a plataforma excluía uma empresa, quem era membro dela seguia com o vínculo guardado no
cache curto da autorização (`lib/auth/cache-curto.ts`) por até 30 segundos, e o login que a
exclusão apagava seguia autenticado pelo mesmo tempo. A exclusão era o único caminho de
revogação que não chamava a invalidação.

Agora a empresa é invalidada no cache logo depois que o banco confirma a exclusão, e a sessão de
cada login removido, logo depois de removê-lo. Quem manteve o login (por ter vínculo com outra
empresa) segue com a sessão dele. Você não precisa fazer nada.
