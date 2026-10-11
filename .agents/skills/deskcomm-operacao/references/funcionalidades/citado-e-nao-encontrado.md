# Funcionalidades — Citado e não encontrado

AVISO: estes itens foram CITADOS no CHANGELOG e não foram achados no menu nem no código; podem ter sido renomeados, movidos ou removidos; não afirme que existem.

O que há aqui: o que o CHANGELOG cita e não foi achado.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

| Funcionalidade | Desde | O que se sabe | Evidência |
|---|---|---|---|
| Tema em extensão | 1.70.0 | Extensão declarativa pode contribuir um tema. (Organização → Extensões) | busquei theme, tema, gancho e hook em lib, app/app/extensions e docs e não achei gancho de tema |
| Legenda da bolinha do avatar | 1.70.0 | A bolinha colorida no avatar da lista diz o que significa. | busquei 2075, bolinha e legenda em app, components e lib e não achei a legenda |
| Painel de mensagens | 1.41.0 | Botão Mensagens acompanha a navegação com busca, canais e atendimento compacto. | busquei painel flutuante, compacto e docked em components e app e não achei o painel |
| Motivos extras removidos | 1.35.1 | Campo morto sai da aba Organização; motivo se cadastra em Etapas do funil. (CRM → Etapas do funil (saiu de Organização)) | app/app/settings/tenant/pipelines/_client.tsx:Motivos de perda (separados por vírgula) |
| Relógio externo no cron | 1.8.0 | Serviço de cron chama a cada minutos para follow-up andar sem agendador. (Relógio externo (runbook)) | runbook docs/runbooks/cron-externo.md removido; relogio-http.md cobre só o agendador interno |
