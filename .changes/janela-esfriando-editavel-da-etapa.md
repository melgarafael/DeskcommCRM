---
impacto: capacidade_nova
secao: adicionado
titulo: A janela de esfriando de cada etapa vira um campo editável
---

Quem monta o funil já via a janela de esfriando ("X dias sem mexer") só no radar de risco, como leitura — nenhuma tela, rota ou comando do assistente deixava trocar o valor. Agora a etapa ganha um campo editável em configurações (`Janela de esfriando`, com entrada em dias e horas, convertida para horas) e a mesma janela passa a ser aceita e devolvida em toda a cadeia: `PATCH/POST/GET /api/v1/pipelines/.../stages`, `crm_update_stage` e `crm_list_stages` no MCP, e os tipos das telas.

Vazio no campo = `null` = o padrão de hoje: 24 h sem movimento põem o negócio em risco (esfriando) e 72 h o tornam crítico. Com uma janela configurada, o crítico chega em três vezes o valor (72 h configuradas = crítico em 216 h), porque quem lê é o `resolveStageWindow` que já existia. A validação é inteiro de 1 a 8760 horas (uma hora a um ano), no Zod da rota e em `validarJanelaDeEsfriamento`, ao lado de `validarNomeDeEtapa` — **sem migration**: a coluna `crm_stages.expected_duration_hours` já existia no banco e continua sem `CHECK`.

Atenção ao diminuir a janela de uma etapa cheia: na passada seguinte do radar, todo negócio que passar a ficar frio esfria de uma vez e ganha uma proposta de reativação (pendente e sem rascunho). A tela ainda não avisa isso ao salvar.

Esta é a parte 1 da #1532. Ficam de fora o aviso ao salvar, o `CHECK` no banco, o relógio que conta a mensagem da equipe, o radar mostrar janelas menores que 24 h e o selo do quadro por funil.

Contribuição de @webtecnica (#2161), construída sobre a proposta de @franceschini-lucas (#1532). Refs #1532.
