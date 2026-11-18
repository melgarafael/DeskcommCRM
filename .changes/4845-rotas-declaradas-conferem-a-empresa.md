---
impacto: exige_acao
secao: corrigido
titulo: Abrir comanda e ver as parcelas de um contrato não atravessam mais a empresa ativa
---

Duas rotas do financeiro ainda aceitavam um identificador de outra empresa e o
usavam sem conferir de quem ele era. Ao abrir uma comanda, o atendimento e o
cliente informados no pedido iam direto para a gravação: quem participa de duas
empresas abria, na empresa ativa, uma comanda apontando para o atendimento e o
cliente da outra. Nada era conferido no caminho, e a comanda nascia na empresa
errada. Na leitura, o calendário de parcelas de um contrato era buscado só pelo
identificador do contrato, então o endereço de um contrato da outra empresa
mostrava as parcelas dela.

Agora o atendimento, o cliente e o contrato são procurados dentro da empresa
ativa antes de qualquer leitura ou gravação. Se o identificador for de outra
empresa, a resposta é a mesma de um identificador que não existe: página não
encontrada, sem confirmar que o registro existe em outro lugar. Quem participa
de uma empresa só não vê diferença nenhuma.

Contribuição de @webtecnica (#4845).

## Requer atenção

Integração que mande o atendimento, o cliente ou o contrato de outra empresa
passa a receber "não encontrado" em vez de criar ou ler o registro: confira os
identificadores que a sua integração envia e use os da empresa ativa. Nada a
instalar — a mudança é nas rotas.
