---
impacto: capacidade_nova
secao: adicionado
titulo: A prospecção pode buscar lugares num engine de scraping self-hosted, sem Apify
---

Quem não quer depender da Apify agora pode apontar a prospecção para um engine de scraping que roda na própria infraestrutura (o gosom/google-maps-scraper). São dois passos: a instalação informa o endereço do engine em `PROSPECTING_LOCAL_HTTP_URL`, e a organização escolhe `local-http` em `organizations.settings.prospecting.provider`. Essa escolha ainda não tem tela: hoje ela é feita por SQL no banco. Com o `local-http` escolhido, a tela de prospecção deixa de pedir a chave da Apify e libera o botão **Buscar empresas**, porque o engine é da instalação e não há chave por organização para salvar.

Em produção o endereço precisa ser `https://` com certificado válido. Na prática, o engine fica atrás de um proxy com TLS; um engine que só responde em http na rede do compose não é aceito. Se o nome resolver para um IP de rede interna, esse IP também precisa estar liberado em **/admin/destinos-internos**.

Com `PROSPECTING_LOCAL_HTTP_URL` vazio, que é o padrão, nada muda. A Apify continua sendo o provedor de quem não escolheu outro. A tradução de campos, o teto de buscas e a tela de escolha do provedor ficam para depois (#2942).

Contribuição de @webtecnica (#3258, #2942).
