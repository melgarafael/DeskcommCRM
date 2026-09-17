---
impacto: nada_mudou
secao: corrigido
titulo: Ensaio do agente não fica preso em execução
---

O botão Executar teste gravava o ensaio como em andamento e, se o
playbook de plataforma ainda não existisse, a atualização falhava e a
aba Execuções deixava a tentativa aberta para sempre. O ensaio agora
prepara o playbook sozinho (sem precisar do worker) e, se algo der
errado, fecha a tentativa com falha e um aviso curto — sem pedir para
conferir modelo ou materiais quando não foram a causa.
