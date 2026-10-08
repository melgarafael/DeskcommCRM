---
impacto: nada_mudou
secao: corrigido
titulo: Menção escolhida para a próxima nota não some quando a anterior termina de salvar
---

Na nota interna, quem já começava a escrever a próxima nota enquanto a anterior ainda salvava e escolhia um atendente na lista de menção perdia essa escolha quando o salvamento terminava: a próxima nota saía como texto, sem o aviso com o id de quem foi escolhido. Agora o fim de um salvamento remove da lista só as menções da nota que foi gravada, e a escolha da próxima fica.

Contribuição de @Tong-bit-art (#2586), a partir da issue #2463.
