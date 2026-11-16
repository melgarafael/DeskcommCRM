---
impacto: capacidade_nova
secao: adicionado
titulo: Leitura e análise aceitam o token de integração
---
Rotas de anúncios, auditoria, importações, métricas, relatórios, canais
(sessões), voz, mensagens e módulos passam a aceitar o Bearer `dsk_...` de
integração, além da sessão de navegador. A organização sai da linha do token,
nunca do corpo, da query ou do caminho enviado pelo cliente. A sessão segue
como era. Contribuição de @paulolimajr77 (Spec 33, fatia 1 de 9).

O token precisa de `mcp:read` para ler e de `mcp:write` nas três escritas que
entram aqui: importar planilha (`POST /api/v1/imports`), ocultar ou restaurar
mensagem (`POST`/`DELETE /api/v1/messages/[id]/hide`) e mudar a régua de
abandono (`PATCH /api/v1/metrics/atrito`). O papel exigido do token é o da
sessão, exceto onde a sessão de um atendente vê só o que é dele: métricas por
atendente, série de ganhos, atrito, canais, funil, metas e relatório de
atividades pedem token de papel `manager`, porque o token lê a organização
inteira. Cada chamada pelo token conta no teto por token e por organização.
