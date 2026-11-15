---
impacto: capacidade_nova
secao: adicionado
titulo: O modelo da proposta lê os campos do negócio do card
---

Vale para quem ligou o módulo de Propostas. Quem vende por funil digitava de
novo no texto da proposta o que já estava no negócio — endereço do imóvel,
valor do aluguel, data de entrada. Agora o modelo aceita `{{lead.<chave>}}` para
cada campo do card (a mesma escrita curta das campanhas, por exemplo
`{{lead.endereco_do_imovel}}`), mais `{{lead.titulo}}`, `{{lead.etapa}}`,
`{{lead.responsavel_nome}}` e `{{lead.responsavel_telefone}}`. Se um campo do
funil tiver a chave de uma dessas quatro, vale a fixa.

O valor sai pelo tipo que o funil declara: moeda formatada na moeda do negócio,
data em dd/mm/aaaa, Sim/Não para o campo de sim ou não, e o rótulo da opção nos
campos de lista. Campo vazio continua virando "[a definir]" e entrando nas
pendências, então a trava de envio segue valendo. Proposta sem negócio
vinculado, ou com a leitura do card falhando, sai exatamente como saía antes.

O editor de modelos passa a listar os campos do funil com o nome que a empresa
deu a eles, para não ser preciso decorar chave. Nada muda no banco e não há
passo na atualização. Contribuição de @webtecnica (#4533).
