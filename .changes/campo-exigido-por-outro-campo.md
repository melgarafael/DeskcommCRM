---
impacto: capacidade_nova
secao: adicionado
titulo: Campo do funil pode ser exigido pelo valor de outro campo
---

No editor de campos do funil, cada campo ganhou **Exigir só quando:** — a
condição que diz "cobre este campo só quando outro tiver determinado valor"
(igual, contém, maior que, ou um conjunto de valores). É o caso do time
comercial com dois tipos de cliente: com **Tipo de cliente = Pessoa jurídica**
o campo de condição de pagamento passa a ser exigido; para pessoa física ele
não aparece e não é cobrado.

A condição de obrigatoriedade **compõe** com a obrigatoriedade por etapa, não a
substitui: campo exigido por uma etapa continua exigido. Se a condição de
exibição esconder um campo que a etapa exige, o formulário mostra o campo com
um aviso e o diálogo do arrasto diz por que está pedindo — em vez de travar sem
explicação. Nada do que já estava gravado é apagado ao trocar o valor do campo
de origem.

Contribuição de @webtecnica.
