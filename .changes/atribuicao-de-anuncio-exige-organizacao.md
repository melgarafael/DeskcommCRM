---
impacto: nada_mudou
secao: corrigido
titulo: Estampar atribuição de anúncio passa a exigir a organização
---

`fn_estampar_atribuicao_de_anuncio` grava de qual anúncio (Meta Ads, Google Ads ou site) um contato veio. Ela roda como `security definer` e só `service_role` pode executá-la, mas o único limite era o id do contato que o chamador mandava: o `where` não olhava `organization_id`. Uma chamada com o contato de outra organização — id vazado, replay de webhook com id trocado, erro de resolução de contato no ingest — estampava o anúncio no contato alheio, por um caminho que a RLS não vê, porque roda como definer.

A organização agora é parâmetro obrigatório e o `where` casa `organization_id = p_org`: contato de outra organização casa zero linhas e nada é gravado, sem levantar erro — a função continua silenciosa no primeiro-toque, para não derrubar o atendimento por causa de atribuição. Os dois pontos de chamada do backend (Meta/Google/site e a origem da página) passam a organização que já têm em mãos. A assinatura antiga, de três argumentos, sai do catálogo na mesma migration: mantida, a chamada de três chaves resolveria nela e a organização nunca chegaria ao `where`.

Para quem opera nada muda: a migration sobe com o deploy e o comportamento visível do produto é o mesmo. Quem protegia a barba de fora — um bug que escrevia no contato de outra organização — deixa de escrever.

Crédito: @webtecnica.
