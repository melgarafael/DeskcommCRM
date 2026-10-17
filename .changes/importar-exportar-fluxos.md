---
impacto: capacidade_nova
secao: adicionado
titulo: Fluxos de follow-up podem ser exportados como arquivo e importados nesta ou em outra conta
---

Em Agente de IA › Follow-ups, cada fluxo ganhou o botão **Exportar**, que baixa um `.fluxo.json` com o desenho inteiro (caixas, ligações, gatilho e política de handoff), e a lista ganhou **Importar fluxo**. O fluxo importado nasce sempre como rascunho: não é publicado e não manda mensagem até passar pelo Publicar, com a mesma conferência de um fluxo desenhado à mão. O arquivo é validado pelas regras do editor, e o que estiver errado aparece com o caminho exato até o campo. Etapas, modelos de mensagem, responsáveis e próximos fluxos citados são conferidos contra a conta: o que existe fica, o que tem o mesmo nome aqui é ligado sozinho, e o resto é esvaziado e listado como pendência a resolver antes de publicar. Nada é adivinhado quando o nome é ambíguo. A importação registra `followup_flow.imported` na auditoria, com contagens e nunca o texto das mensagens. Rotas: `GET /api/v1/ai/followup-flows/:id/export` e `POST /api/v1/ai/followup-flows/import`. O formato e o catálogo completo das caixas, gatilhos e condições estão em `docs/features/importar-exportar-fluxos.md`. Nenhuma mudança de banco.
