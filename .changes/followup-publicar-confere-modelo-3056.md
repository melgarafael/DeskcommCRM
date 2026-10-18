---
impacto: nada_mudou
secao: corrigido
titulo: Publicar um fluxo de follow-up confere se o modelo de mensagem existe nesta conta
---

Um fluxo cujo passo de mensagem apontava para um modelo que não existe nesta conta (importado de outra conta, ou com o modelo apagado depois) era publicado: o passo de modelo falhava a cada envio, e o plano B da mensagem por IA nunca saía. Agora o Publicar recusa, destacando o passo com «Escolha um modelo de mensagem: o que estava aqui não existe nesta conta.» — no passo de modelo, vale texto pronto ou modelo do canal; no plano B, só modelo aprovado do canal, que é o único que ele envia. No editor, esse passo mostra «Escolha um modelo» e um aviso, em vez de um seletor em branco. Fluxos que já estão ativos com um modelo assim continuam rodando como antes; a próxima publicação deles, mesmo para mudar outra coisa, pede que o modelo seja trocado. Achado na prova do #3056 de @salomaobatistamkt.
