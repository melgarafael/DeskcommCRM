---
impacto: nada_mudou
secao: corrigido
titulo: Metadados da página em espanhol e chave de tema renomeada para canti-theme
---

A auditoria visual pós-rebrand encontrou restos de português no HTML servido: as meta tags (título/descrição) ainda saíam em PT e a chave do tema no navegador ainda se chamava `deskcomm-theme`. Agora os metadados padrão saem em espanhol e a preferência de tema é lida e gravada como `canti-theme`. Quem já tinha um tema escolhido não perde nada: na primeira leitura, o valor antigo em `deskcomm-theme` é aproveitado como fallback. Não há ação para quem opera a VPS: a correção chega na próxima atualização.
