---
impacto: capacidade_nova
secao: adicionado
titulo: Token de API administra fluxos de follow-up, agentes, prospecção e tipos de agendamento
---

Quem automatiza a configuração da instalação (configuração como código) agora pode usar o token de API (`dsk_`, com escopos `mcp:read`/`mcp:write` e papel `admin`) nas rotas de configuração de IA, follow-up e agenda, em vez de precisar da sessão por cookie ou de escrever direto no banco (que pulava a validação do grafo, a auditoria e o controle de versões):

- **Fluxos de follow-up** — `GET/POST /api/v1/ai/followup-flows` e `POST /api/v1/ai/followup-flows/from-model` (instalar um modelo do catálogo como rascunho).
- **Agentes de IA** — `GET/POST /api/v1/ai/agents` e `GET/POST /api/v1/ai/agents/:id/versions` (criar agente e versão como rascunho).
- **Prospecção** — `GET/POST /api/v1/prospecting` (configurar, pesquisar e pausar campanhas). Iniciar e retomar campanha continuam exigindo a tela, porque enviam mensagem, e qualquer ação nova da prospecção só passa por token quando for liberada de propósito.
- **Tipos de agendamento** — `GET/POST/PATCH/DELETE /api/v1/agenda/tipos` (`calendar_event_types`).

Nos quatro blocos vale a mesma regra de sessão, agora duplicada pelo token: a organização sai da linha do token (nunca do corpo/query), o papel mínimo exigido é o mesmo da sessão (viewer para leitura; manager/admin para escrita), a escrita vai para o rascunho (publicar, reverter, iniciar e retomar campanha continuam exigindo a tela) e o rate limit por token é o mesmo das demais portas que aceitam Bearer. Toda mutação segue auditada com o id do token na trilha.

Não é preciso fazer nada na instalação para receber a capacidade; quem já automatiza por banco pode substituir a escrita direta pelas rotas e ganhar as validações de volta.

Contribuição de @webtecnica (#2028), fechando a #1875.
