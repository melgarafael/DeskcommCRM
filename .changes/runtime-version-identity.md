---
impacto: nada_mudou
secao: corrigido
titulo: A versão instalada corresponde às imagens em execução
---

O rodapé mantém a versão instalada visível mesmo quando há uma atualização
oficial disponível. Instalações personalizadas mostram separadamente a base
oficial e sua revisão, sem confundir o checkout do monitor com o CRM no ar.

A confirmação usa os serviços do compose, metadados imutáveis e proveniência
Git. Ausência, divergência ou confirmação vencida ficam explícitas. Uma falha de
atualização não desaparece apenas porque um processo declara a versão-alvo;
a reinstalação bem-sucedida continua reconhecida com confirmação posterior.
Alterações próprias precisam ser conciliadas antes de trocar imagens por uma
release pública. Heartbeats antigos permanecem compatíveis, sem alegar execução
completa. A atualização normal do kit entrega a correção, sem novo serviço ou
permissão de Docker no app.
