---
impacto: capacidade_nova
secao: adicionado
titulo: Automação "Atribuir a um atendente" pode mandar o negócio para o responsável dele ou para o dono da carteira do cliente
---

A ação de atribuir só sabia escolher entre uma pessoa fixa e um rodízio de nomes:
quem fazia pós-venda precisava de uma automação por vendedor, e quem usava rodízio
via todo negócio cair na mesma fila, mesmo quando o cliente já tinha dono.

O modo novo **Destino dinâmico** entrega o negócio a quem já está com ele: o
**responsável do negócio** e, se não houver, o **dono da carteira do cliente**.
Quem recebe depende do negócio que disparou a regra, não de um nome escrito nela.
Quem não pode receber (saiu da equipe ou só tem acesso de leitura) é pulado, e a
regra segue a lista.

Sem ninguém do negócio disponível, a atribuição cai no **fallback**, que é
obrigatório: uma pessoa fixa ou o rodízio de sempre. A Atividade passa a dizer
qual destino decidiu, em vez de deixar o negócio sem responsável em silêncio.

As opções de **passar também o contato (carteira)** e **as conversas abertas**
valem para os destinos novos do mesmo jeito que valem para a pessoa fixa.

Contribuição de @webtecnica (#3804).
