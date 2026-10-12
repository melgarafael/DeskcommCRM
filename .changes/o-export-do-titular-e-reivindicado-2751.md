---
impacto: nada_mudou
secao: corrigido
titulo: Um pedido de dados do titular gera uma exportação, não duas
---

Um pedido de dados LGPD podia exportar duas vezes: o webhook da Nuvemshop e a aprovação manual disparam o mesmo trabalho, e as duas execuções podiam rodar ao mesmo tempo — o arquivo era montado em dobro, dois e-mails saíam e a trilha de auditoria registrava duas entregas para um pedido só. Agora a exportação é reivindicada de forma atômica pelo worker: quem chega segundo não exporta, e o pedido fica com uma tentativa e uma entrega. Retry depois de falha e retomada de execução interrompida continuam funcionando, sem espera extra.

Contribuição de @Tong-bit-art (#2752), a partir da issue #2751.
