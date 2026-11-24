# SMC PRO V2

BingX USDT-M futures için bağımsız Scalp ve Swing price-action araştırma/tarama projesi.

## Güvenlik
- Yalnızca PAPER / RESEARCH modunda çalışır; canlı emir adaptörü yoktur.
- Gerçek BingX VST bakiye bağlantısı henüz kurulmadığı için paper pozisyon açma/kapatma devre dışıdır. Varsayılan veya tahmini bakiye kullanılmaz.
- Market verisi BingX public API üzerinden alınır; özel API anahtarı gerekmez.
- 1M ve 3M zaman dilimleri tarama motorlarına dahil değildir.
- Yeni Cloudflare Worker `smc-pro-v2` ve ayrı KV namespace kullanır. Önceden var olan `smcprov2` Worker'ı değiştirilmez.

## Uygulanan tarama
- 5 dakikalık cron; BingX USDT-M sözleşme ve ticker evreni.
- Hacim ve bid/ask spread filtresi; tur başına 5 sembol ve KV'de cursor.
- Scalp: 1H bias, 15M bölge, 5M giriş. Swing: 1D bias, 4H bölge, 15M giriş.
- Aynı tarama turunda aynı sembol/zaman dilimi için mum verisi cache edilir.
- Kapanmamış mumlar analiz dışında bırakılır.
- Pivot tabanlı yapı bias'ı, likidite süpürmesi, displacement ve FVG koşullarıyla aday üretimi.
- Adaylar Scalp/Swing etiketiyle ayrı listelenir; güven değeri örneklem oluşana kadar INSUFFICIENT_DATA'dır.

## API
- `GET /api/health`
- `GET /api/data`
- Tarama zamanlayıcısı: `*/5 * * * *`

## Henüz tamamlanmayan aşamalar
- VST kimlik doğrulaması ve bakiye okuma; bu nedenle paper execution kapalı.
- Gelişmiş OB, Breaker, Mitigation, Supply/Demand, Range Deviation, CRT, OTE ve setup-specific retest doğrulaması.
- Derinlik/order-book filtreleri, Durable Objects koordinasyonu, gerçek tarihsel arşiv ve 30/60/90 günlük maliyet dahil backtest.
- Ayrı Scalp/Swing performans istatistikleri ve örneklem tabanlı confidence.
