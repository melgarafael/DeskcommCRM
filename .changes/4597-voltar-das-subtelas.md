---
impacto: capacidade_nova
secao: adicionado
titulo: Caminho de volta ao índice em todas as telas de Configurações
---

Toda subtela de Configurações — Tags, Marca, Notificações, Funis, Agenda, Perfil, Segurança e as demais — abre agora com um link "← Voltar para Configurações" que leva ao índice (`/app/settings`). Antes, quem entrava numa subtela só saía reabrindo Configurações pelo menu.

O link e o título da tela vêm de um cabeçalho comum (`components/settings/CabecalhoDaSubTela.tsx`), com o rótulo no dicionário (português e espanhol). Nada mais da tela muda: o corpo de cada subtela continua como estava.

A regra vale para as próximas: `tests/unit/volta-das-subtelas-de-configuracoes.test.ts` percorre os `page.tsx` de `app/app/settings/` e reprova a subtela que não usar o cabeçalho. As três rotas antigas que só redirecionam (canal oficial, templates e WhatsApp) continuam sem cabeçalho, e o teste cobra que sigam sendo redirecionamento.
