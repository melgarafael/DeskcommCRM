---
impacto: capacidade_nova
secao: adicionado
titulo: A prospecção encontra sites e revisa contatos públicos
---

O administrador pode escolher Apify ou a instância SearXNG da instalação. A busca web encontra sites e contatos publicados em resultados públicos; a auditoria do site também pode identificar e-mails e telefones que a própria empresa publicou. Os dados precisam de conferência e não comprovam consentimento para marketing. A URL HTTPS usa a política de saída do CRM. Para uma instalação na mesma máquina, também é possível usar a rede Docker privada dedicada: ela fixa o alias e confere o IPv4 configurado do SearXNG antes da chamada; não aceita outros destinos HTTP nem publica a porta do serviço. O endpoint deve liberar JSON. Os resultados entram como rascunho de campanha para revisão; ativar o envio continua sendo uma decisão humana. Para sites públicos que retornam um shell JavaScript vazio, pode-se habilitar um fallback Firecrawl com chave da instalação: envia somente a URL para renderização, limita o HTML usado como evidência e deixa o fallback desligado sem opt-in explícito.
