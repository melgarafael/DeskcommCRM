---
impacto: nada_mudou
secao: corrigido
titulo: O teste dos papéis do agente parou de reprovar por acaso
---

O teste de tela que percorre a aba do papel Operador reprovava de vez em quando,
sempre no mesmo ponto e nunca duas vezes seguidas: ao abrir o agente, a página
aparecia duas vezes para o teste — a cópia que o servidor manda enquanto monta a
tela e a que fica na frente — e o clique no papel encontrava dois botões onde
deveria haver um.

A espera que já existia para as outras telas foi aplicada também a este teste:
ele passa a olhar a página **só depois de montada**, e não no meio da montagem.

Nada muda no produto: quem usa o sistema não vê diferença nenhuma. O que muda é
que uma reprovação desse teste volta a significar defeito, em vez de azar.
