---
impacto: nada_mudou
secao: corrigido
titulo: Editar o funil e o material de um agente pela API agora grava
---

Quem editava um agente pela API (integrações e chamadas por token) mandando `pipeline_ids` ou `knowledge_source_ids` no `PATCH /api/v1/ai/agents/:id/versions/:vid` recebia 200 e nada era gravado: a versão seguia com o funil e o material antigos. Agora a edição grava, e antes confere que o funil e o material existem nesta organização: material arquivado ou de outra organização passa a ser recusado também aqui, como já era na criação. A tela do agente não era afetada, porque salva por outro caminho, que já gravava.

Contribuição de @ygorl.
