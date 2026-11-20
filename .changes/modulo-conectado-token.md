---
impacto: capacidade_nova
secao: adicionado
titulo: Seu módulo conectado já recebe o próprio token, que só abre as áreas que você autorizar
---

Agora um módulo conectado pode pegar o próprio token sem que você crie um token para ele. Esse token só alcança as áreas do CRM que a sua organização autorizar para o módulo, por enquanto só para ler, e o MCP o recusa sempre. Em /app/extensions, no bloco da instalação, quem administra a instalação gera o segredo do módulo, que aparece uma única vez, e o entrega ao módulo; com esse segredo, o módulo pede um token curto, que vale uma hora e aparece na sua tela de tokens como "Módulo <slug>". Desligar o módulo, removê-lo ou revogar esse token na tela de tokens encerra o acesso dele: revogar desativa o módulo naquela organização, e gerar um novo segredo derruba os tokens que já estavam em uso. Se a sua instalação não tem módulo conectado, nada disso aparece e a tela de tokens continua igual.

Crédito: @paulolimajr77.
