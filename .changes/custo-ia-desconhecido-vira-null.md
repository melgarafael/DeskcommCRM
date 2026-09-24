---
impacto: corrigido
secao: corrigido
titulo: Custo de IA desconhecido não aparece mais como R$ 0,00
---

Quando o CRM não sabia o preço de um modelo de IA (modelo novo sem linha no catálogo, catálogo sem preço, erro ao ler o catálogo), ele gravava custo **0** — como se a chamada tivesse sido de graça. A tela de Execuções mostrava R$ 0,00 enquanto o dinheiro saía, e o controle de orçamento deixava passar modelo sem preço como grátis.

Agora o desconhecido é registrado como **desconhecido** (as telas mostram "—" em vez de R$ 0,00), e o zero fica reservado para o que realmente não custou nada (quando nenhuma chamada ao provedor aconteceu). O controle de orçamento não bloqueia por custo desconhecido — calar a IA por um modelo novo sem preço seria pior que gastar sem saber quanto —, mas o gasto aparece como desconhecido no painel de Uso. Sem ação para quem opera: a mudança chega na próxima atualização.
