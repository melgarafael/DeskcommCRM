# Türkçe terim sözlüğü ve üslup kuralları

Bu dosya, `lib/i18n/traducoes/tr.json` kataloğunu çevirenlerin tek başvuru kaynağıdır. Kataloğun anahtarı Portekizce ekran metnidir. Değeri o metnin Türkçesidir. Çeviri bağlamı için her anahtarın İspanyolcası ve İngilizcesi de verilir.

Çeviri süreci:

1. `pnpm tsx scripts/i18n/lotes-para-traduzir.ts --idioma tr --tamanho 400 --saida <klasör>` komutu, eksik metinleri `lote-NNN.json` paketlerine böler.
2. Her paket çevrilir ve sonuç aynı klasöre `lote-NNN.tr.json` olarak yazılır. Biçim düzdür: `"anahtar": "Türkçesi"`.
3. `pnpm tsx scripts/i18n/juntar-lotes.ts --idioma tr --entrada <klasör>` komutu paketleri doğrular ve kataloğa birleştirir.

## Bozulmaz kurallar

Bunlar ekranı bozar. Birleştirme aracı ve testler bu tür hataları reddeder.

1. **Anahtar birebir korunur.** Tırnak, boşluk, nokta, büyük/küçük harf ve özel karakter (`›`, `—`, `×`, `…`, `“ ”`) dahil hiçbir şey değişmez. Anahtarı "düzeltmek" yeni bir anahtar yaratır. Gerçek ekran metni ise Portekizce kalır.
2. **Yer tutucular birebir korunur.** `{nome}` ve `{{nome}}` olduğu gibi kalır. Tek parantez ile çift parantez birbirine dönüşmez, içindeki ad çevrilmez. Türkçede sırası değişebilir, sayısı değişemez.
3. **Baştaki ve sondaki boşluk korunur.** `" (personalizada)"` gibi anahtarlar, ekranın başka bir kelimenin arkasına eklediği parçalardır. Anahtar boşlukla başlıyorsa Türkçesi de boşlukla başlar. Boşlukla bitiyorsa Türkçesi de boşlukla biter.
4. **Değer boş bırakılmaz.** Çevrilecek bir şey yoksa (örneğin yalnızca sembol, sayı veya marka adıysa) değer anahtarla aynı yazılır.
5. **HTML etiketleri, Markdown işaretleri, adresler ve e-posta adresleri** olduğu gibi kalır.

## Üslup

- **Düğmeler emir kipindedir:** "Kaydet", "Ara", "Sil", "Yeni kişi ekle".
- **Kullanıcıya "siz" ile hitap edilir:** "Bir plan seçin", "Bağlantınızı kontrol edin". "Sen" kullanılmaz.
- **Kısa ve sade yazılır.** Ekran metnidir. Portekizcedeki uzun cümle Türkçede daha kısa söylenebiliyorsa kısa olan seçilir.
- **Büyük harf kullanımı Portekizceyi izler.** Cümle başı büyük harfle başlar. Başlıkta her kelime büyük yazılmaz.
- **Sayıdan sonra çoğul eki gelmez:** "3 mesaj" yazılır, "3 mesajlar" yazılmaz. Ekran sayıyı ayrı bir parçanın önüne koyuyorsa (`incidentes`, `solicitações`, `conexões`), o parça tekil çevrilir: "olay", "talep", "bağlantı".
- **Arama kutusu "Ara" ile başlar:** "Ara: ad, telefon, son mesaj…". Dar kutu metni keser. "Ada göre ara…" kesilince "Ada" (ada, yani deniz adası) kalır.
- **Brezilya'ya özgü yasa, belge ve para birimi Türkçe ekranda geçmez.** Okuyan, Belçika'da veya Türkiye'de çalışan bir şirkettir. Karşılıklar aşağıdaki terim tablosundadır.
- **Yer tutucuya hal eki bağlanmaz.** `{nome}'e` gibi bir yazım, ekin ünlü uyumu ada göre değiştiği için çoğu zaman yanlış çıkar. Cümle yeniden kurulur: "{nome} adlı kişiye", "Kişi: {nome}".
- **Cümle parçaları parça olarak çevrilir.** Bazı anahtarlar ekranda bir sayının veya başka bir metnin önüne ya da arkasına eklenir ("no máximo 1× a cada", "(publicada como v"). Anlam korunur. Gerekirse daha nötr bir kalıp seçilir.
- **"IA" her zaman "AI" olur.** "Agente de IA" "AI asistanı" olarak çevrilir.

## Çevrilmeyecek adlar

Bu adlar olduğu gibi yazılır:

WhatsApp, Instagram, Meta, API, CSV, PIX, Stripe, Asaas, OpenAI, Anthropic, Claude, Supabase, Google, Gmail, GDPR, SMTP, JSON, PDF, URL, Webhook

Ürün adı (marka) da çevrilmez.

## Tarih kalıpları

Tarih kalıpları date-fns `tr` yerel ayarıyla biçimlenir. Portekizcedeki `'de'` ve `'às'` gibi sabit sözcükler kalmaz. Sıralama Türkçeye göre değişir. Kalıp içindeki harfler (`d`, `M`, `y`, `E`, `H`, `m`) birer alan kodudur. Kalıba Türkçe bir sözcük eklenmesi gerekiyorsa sözcük tek tırnak içine yazılır (`'saat'`), yoksa date-fns onu alan kodu sanar.

| Portekizce kalıp | Türkçe kalıp | Örnek çıktı |
|---|---|---|
| `d 'de' MMM` | `d MMM` | 19 Eki |
| `d 'de' MMMM` | `d MMMM` | 19 Ekim |
| `d 'de' MMMM 'às' HH:mm` | `d MMMM HH:mm` | 19 Ekim 14:30 |
| `EEEE, d 'de' MMM` | `d MMM EEEE` | 19 Eki Pazartesi |
| `EEEE, d 'de' MMMM` | `d MMMM EEEE` | 19 Ekim Pazartesi |
| `EEEE, d 'de' MMMM 'às' HH:mm` | `d MMMM EEEE HH:mm` | 19 Ekim Pazartesi 14:30 |
| `MMMM 'de' yyyy` | `MMMM yyyy` | Ekim 2026 |

`'de'` içermeyen kalıplar (`dd/MM/yyyy`, `HH:mm` gibi) olduğu gibi kalır.

## Terimler

Emin olunmayan bir terimde bu tablo esas alınır. Aynı Portekizce terim her yerde aynı Türkçe karşılıkla çevrilir.

| Portekizce | Türkçe |
|---|---|
| lead | potansiyel müşteri |
| funil | satış hunisi |
| etapa | aşama |
| negócio / oportunidade | fırsat |
| contato | kişi |
| conversa | konuşma |
| atendimento | görüşme (isim). Fiil olarak "atender" bağlama göre "yanıt vermek" veya "ilgilenmek" olur: "o assistente vai atender" → "asistan yanıt verir". |
| atendente | temsilci (insan). İspanyolcası "Agente" ise kastedilen AI asistanıdır: "asistan". |
| RGPD | GDPR |
| LGPD | GDPR (karar: 2026-10-21) |
| CNPJ | vergi numarası |
| CPF ou CNPJ | kimlik veya vergi numarası |
| tenant | şirket ("Tenants" menüsü: "Şirketler") |
| cross-tenant | tüm şirketler |
| duplicado (kayıt) | mükerrer kayıt |
| Moeda (alan türü) | para tutarı |
| agente de IA | AI asistanı |
| follow-up | takip mesajı |
| etiqueta / tag | etiket |
| empresa / organização | şirket |
| equipe / time | ekip |
| painel | panel |
| plano | plan |
| cobrança | ödeme |
| assinatura | abonelik |
| conexão | bağlantı |
| canal | kanal |
| disparo | toplu gönderim |
| campanha | kampanya |
| roteador | yönlendirici |
| transferir para humano | bir çalışana aktar |
| caixa de entrada | gelen kutusu |
| mensagem | mesaj |
| modelo (de mensagem) / template | şablon |
| resposta rápida | hazır yanıt |
| agenda | takvim |
| agendamento / compromisso | randevu |
| tarefa | görev |
| configurações | ayarlar |
| usuário | kullanıcı |
| permissão | yetki |
| papel / função | rol |
| dono | sahip |
| administrador | yönetici |
| relatório | rapor |
| desempenho | performans |
| automação | otomasyon |
| gatilho | tetikleyici |
| regra | kural |
| fila | kuyruk |
| base de conhecimento | bilgi bankası |
| integração | entegrasyon |
| extensão | eklenti |
| módulo | modül |
| campo personalizado | özel alan |
| responsável | sorumlu |
| prospecção | müşteri adayı bulma |
| janela de envio | gönderim aralığı |
| fuso horário | saat dilimi |
| horário de atendimento | çalışma saatleri |
| instalação | kurulum |
| servidor | sunucu |
| Salvar | Kaydet |
| Cancelar | İptal |
| Excluir | Sil |
| Arquivar | Arşivle |
| Editar | Düzenle |
| Voltar | Geri |
| Continuar | Devam et |
| Tentar de novo | Tekrar dene |
| comanda | adisyon |
| caixa (o do dinheiro) | kasa |
| comissão | komisyon |
| fidelidade | sadakat |
| esfriando (durum adı) | soğuyor |
| Inbox | Gelen kutusu |
| Automático | Otomatik |
| acompanhar / acompanhamento (konuşmayı) | izle / izleme |
| abordar / abordagem (müşteri adayına) | iletişime geç / ilk temas |
| Central / Central de avisos | Bildirim merkezi |
| agente (tek başına) | asistan |
| cadastro | kayıt |
| chamado | talep |
| capacidade (yetenek anlamında) | yetenek |
| jornada (asistanın özelliği; İngilizcesi "journey") | yolculuk |
| jornada publicada / horário publicado (çalışma saatleri) | çalışma düzeni |
| skill | beceri |
| caso | vaka |
| acervo | arşiv |
| carteira (müşteri) | portföy |
| quadro (kanban) | pano |
| passagem (devir anlamında) | devir |
| Central de Conexões | Bağlantı Merkezi |
| estornar | iade et |

**CSV sütun adları çevrilmez.** `nome, telefone, email, cpf, nascimento, tags` gibi sütun adları içe aktarıcının tanıdığı başlıklardır (`lib/contacts/csv.ts`). Metinde olduğu gibi kalır.

**SSS işaretleri çevrilmez.** `## Pergunta:`, `## Resposta:`, `## P:` ve `## R:` işaretlerini SSS ayrıştırıcısı tanır (`lib/ai/rag/ingest/faq.ts`). Metinde olduğu gibi kalır.

**Durdurma kelimeleri çevrilmez.** Metin müşterinin yazacağı bir kelimeyi söylüyorsa (`responda PARAR`, `envie SAIR`, `BAJA`, `STOP`), Türkçede **STOP** yazılır: "müşteriden STOP yazmasını isteyin". Sistem yalnızca bu kelimeleri tanır. "DUR" veya "İPTAL" yazılırsa müşteri yazar ama engellenmez.

Tırnak içindeki örnek adlar (`etiqueta “cliente”` gibi) çevrilir: “müşteri”. Bunlar kayıtlı veri değil, açıklamadaki örneklerdir. İngilizce sürüm de onları çevirir.
