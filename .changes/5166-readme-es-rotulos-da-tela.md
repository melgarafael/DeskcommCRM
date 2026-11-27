---
impacto: nada_mudou
secao: corrigido
titulo: O README em espanhol cita os rótulos que a tela em espanhol mostra
---

A seção "Actualizar" do `README.es.md` citava os rótulos em português, e não o que o dono vê numa
instalação em espanhol: **"Nova versão"** virou **"Nueva versión"**, e
**"Atualização automática indisponível"** virou **"Actualización automática no disponible"**,
exatamente como o `lib/i18n/dicionario.ts` traduz.

A mesma seção passou a dizer o que o `healthcheck.sh` significa quando alguém o põe no cron: ele
sai **0 só** quando a app se declara saudável (status geral `healthy`) e sai 1 em qualquer outro
desfecho — `degraded`, `unhealthy`, app mudo, JSON ilegível. Antes o README em espanhol só dizia
"diagnóstico de todos los servicios", sem dizer o que o código de saída quer dizer.
