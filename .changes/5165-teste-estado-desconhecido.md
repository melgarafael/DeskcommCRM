---
impacto: nada_mudou
secao: corrigido
titulo: A tela de atualização tem teste para o estado "não sei dizer como terminou"
---

O ramo em que o servidor parou de responder no meio da atualização não tinha teste nenhum: trocar o título, o comando manual ou a regra do botão passava sem reprovar nada. Agora o teste de componente da tela cobre o título do estado, o comando `bash hostgator-setup-kit/update.sh` e as duas pontas do botão — ele aparece com versão nova anunciada e não aparece sem ela. Nenhum arquivo de tela foi alterado.
