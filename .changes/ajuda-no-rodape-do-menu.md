---
impacto: capacidade_nova
secao: adicionado
titulo: Ajuda dentro do produto, no rodapé do menu
---

Agora existe **Ajuda** no fim do rodapé do menu lateral — o que se procura quando o resto não respondeu. A tela abre um índice por jornada, com o caminho para cada tarefa e uma linha dizendo quando procurar aquilo: conversas, funil, contatos, canais, agente de IA e equipe. Quem instalou o servidor vê também "Para quem instala e mantém", com o atalho para a atualização da instalação — e só ele vê: o bloco depende de `is_platform_admin`, então atendente e gerente não recebem um link que terminaria em 403. Todo o texto passa pelo dicionário: espanhol completo, inglês já traduzido (o catálogo em inglês ainda não é servido, conforme `lib/i18n/registro.ts`) e qualquer outra língua cai no português, como o resto da interface. Nada muda na VPS e nenhuma migration foi necessária. Este é o índice da ajuda; os artigos longos, com capturas e versão, são a fatia seguinte da #3567. Crédito: @webtecnica (#3572).
