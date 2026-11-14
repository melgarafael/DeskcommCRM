---
impacto: capacidade_nova
secao: adicionado
titulo: O artigo de ajuda diz a que versão pertence e marca a instalação que ainda não chegou lá
---

Até aqui o hub de ajuda não dizia a que versão cada artigo pertencia: quem estava na v1.90 lia um texto escrito para a v1.97 e seguia um caminho que não existia na tela dele.

Agora cada artigo carrega a versão em que passou a valer, e a tela mostra "vale a partir da versão" em todo item. Quando a instalação é anterior à do artigo, o item aparece marcado com as duas versões — a do artigo e a da instalação — em vez de ensinar em silêncio um caminho que ainda não está ali. Instalação na mesma versão ou mais nova: sem aviso.

A comparação é a mesma régua da tela de atualização, sem dependência nova: aceita a tag com `v`, a versão incompleta (`1.90` é `1.90.0`) e o sufixo de pré-release. O que não é versão — um SHA de instalação fora de release, por exemplo — não marca artigo nenhum: ausência de versão é ausência de prova, e marcar por isso ensinaria a ignorar a marca. Sem migração: é leitura da versão que a rota do sistema já entrega. Contribuição de @webtecnica (#3863).
