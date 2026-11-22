---
impacto: exige_acao
secao: corrigido
titulo: Abrir comanda e ver as parcelas de um contrato não atravessam mais a empresa ativa
---

Duas rotas do financeiro ainda aceitavam um identificador de outra empresa e o
usavam sem conferir de quem ele era. Ao abrir uma comanda, o atendimento e o
cliente informados no pedido iam direto para a gravação: quem participa de duas
empresas abria, na empresa ativa, uma comanda apontando para o atendimento e o
cliente da outra. Nada era conferido no caminho, e a comanda nascia com o vínculo
da empresa errada. Na leitura, o calendário de parcelas de um contrato era
buscado só pelo identificador do contrato, então o endereço de um contrato da
outra empresa mostrava as parcelas dela.

Agora o atendimento, o cliente e o contrato são procurados dentro da empresa
ativa antes de qualquer leitura ou gravação. A comanda recusa o vínculo de fora
com **422** e os códigos do faturamento em lote
(`financeiro_contato_fora_da_empresa`, `financeiro_agendamento_fora_da_empresa`):
o corpo está bem formado, os ids só não são desta empresa. A leitura das parcelas
responde **404**, o mesmo de um contrato que não existe. Quem participa de uma
empresa só não vê diferença nenhuma.

## Requer atenção

Integração que mande o atendimento, o cliente ou o contrato de outra empresa
passa a receber recusa em vez de criar ou ler o registro: na abertura de comanda,
422 com o código do vínculo (`financeiro_agendamento_fora_da_empresa` ou
`financeiro_contato_fora_da_empresa`); nas parcelas, 404. Confira os
identificadores que a sua integração envia e use os da empresa ativa. Nada a
instalar — a mudança é nas rotas.
