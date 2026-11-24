# SMC PRO V2

BingX USDT-M Futures için bağımsız Scalp ve Swing price-action motorları. Ana çalışma ortamı, mevcut ve korunacak Cloudflare Worker `smcprov2`'dir.

## Üretim ortamı güvenliği
- Mevcut `smcprov2` Worker sürüm 1889 ana üretim ortamıdır; yeni `smc-pro-v2` Worker üretim hedefi değildir.
- Üretim Worker kaynak snapshot'ı ve altyapı denetimi `infra/archive-smcprov2-v1889` dalında `legacy/` altında arşivlenmiştir.
- Üretim KV alanı ve Durable Object verisi korunur; mevcut 847 KV kaydı ve tek Durable Object nesnesi üzerinde sıfırlama/taşıma yapılmaz.
- Canlı işlem kapalı kalır. Paper/VST yürütme, bakiye ve mevcut ledger semantiği doğrulanmadan açılmaz.
- Yeni tarayıcı iskeleti, eski Worker'ın yerine doğrudan dağıtılamaz: mevcut üretim kodu `PAPER_STATE` ve `ENGINE_STATE` kullanır ve BingX VST emir/pozisyon yaşam döngüsünü içerir.
- Bilinçli olarak Wrangler dağıtım dosyası tutulmuyor. Eski Worker ile uyumlu Durable Object/KV adapter ve secret-preserving deployment planı test edilmeden deploy yapılandırması eklenmeyecek.

## Motor gereksinimleri
- Scalp: 1H yön, 15M likidite/bölge, 5M setup ve giriş.
- Swing: 1D yön, 4H yapı/bölge, 1H teyit, 15M giriş.
- 1M ve 3M yasak.
- Market Structure: HH/HL/LH/LL, BOS, CHoCH, displacement ve MSB/MSS.
- SMC bölgeleri: OB, FVG, Breaker, Mitigation, Supply/Demand, Range Deviation, OTE ve CRT.
- İki motor bağımsız sinyal/istatistik üretir; portföy riski ortaktır.
- Skor ve confidence ayrıdır; yetersiz örneklemde confidence `INSUFFICIENT_DATA` olur.
- Eksik hacim delta, aggressor veya dominance verisi tahmin edilmez; `UNAVAILABLE` olarak kalır.

## Mevcut kod aşaması
- `src/market-structure.js`: sağ pencere kapanmadan pivotu kullanmayan, onaylı pivot ve yapı kırılımı tespiti.
- `src/zones.js`: FVG yaşam döngüsü, likidite havuzları/süpürmeleri, OB, mitigation/breaker, Supply/Demand, range deviation, OTE ve CRT.
- `test/price-action.test.js`: gelecek veri sızıntısı ve temel bölge davranış testleri.
- Scalp/Swing setup değerlendirmesi, gerçek backtest, VST paper yaşam döngüsü ve üretim dashboard entegrasyonu henüz tamamlanmış değildir.

## Test
```bash
npm test
node --check worker/index.js
```

Bu dal araştırma/engine geliştirmesidir; üretim Worker'a deploy edilmez.
