---
impacto: capacidade_nova
secao: adicionado
titulo: Seu módulo conectado agora busca o próprio acesso à API
---

Agora um módulo conectado pode pegar um token de acesso à API sem que você crie um token para ele. Em /admin/extensoes, quem administra a instalação gera o segredo do módulo, que aparece uma única vez, e o entrega ao módulo; com esse segredo, o módulo pede um token curto, que vale uma hora e aparece na sua tela de tokens como "Módulo <slug>". Desligar o módulo, removê-lo ou revogar esse token na tela de tokens encerra o acesso dele: revogar desativa o módulo naquela organização, e gerar um novo segredo derruba os tokens que já estavam em uso. Se a sua instalação não tem módulo conectado, nada disso aparece e a tela de tokens continua igual.
