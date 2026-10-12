# GND Control

برنامج ويندوز تتحكم منه بالبوتات الثلاث (الموسيقى، والألعاب، والسيستم) وبـ Lavalink اللي على السيرفر.

```
برنامج ويندوز  ⇄ HTTPS ⇄  Caddy  ⇄  gnd-control (Agent)  ⇄  pm2  ⇄  البوتات
                                          └─→ GitHub Issues (تقارير لـ Claude)
```

| المجلد | وش فيه |
|---|---|
| `control/agent` | خدمة صغيرة تشتغل على السيرفر جنب البوتات تحت pm2، وتتحكم فيها |
| `control/bot-link` | سطر واحد تضيفه لكل بوت عشان يرسل حالته ويستقبل الأوامر |
| `control/desktop` | برنامج ويندوز (Electron) |

## وش يسوي البرنامج
- **الرئيسية**: حالة كل بوت (شغال أو طافي، ومدة التشغيل، والرام، والمعالج، والسيرفرات، والأعضاء، والبنق)، مع أزرار تشغيل وإيقاف وريستارت، وزر ريستارت الكل.
- **السجلات**: بث مباشر لكل بوت، مع بحث وفلتر للأخطاء. التوكنات تنشال تلقائياً.
- **إعدادات البوتات**: تغيير الحالة (Status) والاسم والصورة، وتعديل ملف `.env` بدون ما تشوف القيم السرية.
- **السيرفر**: المعالج والرام والقرص وLavalink، وزر "تحديث من GitHub" (`git pull` ثم تثبيت المكتبات ثم ريستارت).
- **تقرير لـ Claude**: يجمع حالة البوتات وآخر الأخطاء في تقرير، ويرسله كـ Issue في GitHub. بعدها تقول لـ Claude "شف آخر تقرير". وإذا طاح بوت 3 مرات خلال 10 دقايق، يفتح تقرير تلقائياً.
- إشعارات ويندوز إذا طاح بوت، وأيقونة جنب الساعة.

## التركيب على السيرفر (مرة وحدة)

1. **شغّل الـ Agent:**
   ```bash
   cd /path/to/botm
   bash control/agent/setup.sh
   ```
   السكربت يثبّت المكتبات، ويسوي مفتاح API جديد ويطبعه، ويشغّل `gnd-control` في pm2. **انسخ المفتاح**، بتحتاجه في البرنامج.

2. **طابق أسماء pm2:** شغّل `pm2 list` وشوف أسماء البوتات. إذا كانت غير `gnd-music` و `gnd-games` و `gnd-system` و `lavalink`، انسخ `control/agent/bots.example.json` إلى `control/agent/bots.json` وعدّل الأسماء، وبعدها `pm2 restart gnd-control`.

3. **افتحه على HTTPS عن طريق Caddy:** أضف هذا لـ `deploy/Caddyfile` (غيّر الدومين لدومينك، وخلّ سجل DNS حقه يأشر على السيرفر):
   ```
   control.your-domain.com {
       reverse_proxy 127.0.0.1:7420
   }
   ```
   بعدها `sudo systemctl reload caddy`.

4. **اربط البوتات:** أضف هذا السطر في كل بوت بعد ما يتسوى الـ `client` (المسار نسبي من ملف البوت):
   ```js
   require('../control/bot-link').attach(client);            // src/index.js
   require('../../control/bot-link').attach(client);         // games/src/index.js و system/src/index.js
   ```
   تقدر تضيف معلومات زيادة تطلع في البرنامج، مثلاً عدد المشغلات في بوت الموسيقى:
   ```js
   require('../control/bot-link').attach(client, { extra: () => ({ players: manager.players.size }) });
   ```
   بدون هالسطر يشتغل التحكم (تشغيل وإيقاف وسجلات) عادي، بس ما تطلع السيرفرات والبنق، ولا يشتغل تغيير الحالة والاسم والصورة.

5. **تقارير Claude (اختياري بس أنصح فيه):** سوّ توكن GitHub من نوع fine-grained:
   GitHub ← Settings ← Developer settings ← Fine-grained tokens ← Generate new token
   - **Repository access**: Only select repositories، واختر مستودع البوت بس
   - **Permissions**: Issues = Read and write
   
   حطه في `control/agent/.env` كذا: `GITHUB_TOKEN=...`، وتأكد إن `GITHUB_REPO` اسم مستودعك، وبعدها `pm2 restart gnd-control`.

## تنزيل البرنامج على ويندوز
- **من GitHub**: افتح تبويب **Actions** في المستودع، واختر آخر تشغيل لـ **GND Control**، ونزّل `GND-Control-Setup` من أسفل الصفحة. فك الضغط وشغّل الـ `.exe`.
- **إصدار رسمي**: سوّ tag باسم `control-v1.0.0` وارفعه، والملف ينضاف تلقائياً في صفحة Releases.
- **من جهازك**: `cd control/desktop` ثم `npm install` ثم `npm run dist`، والملف يطلع في `control/desktop/dist`.

ويندوز ممكن يطلع لك تحذير SmartScreen لأن البرنامج غير موقّع: اضغط **More info** ← **Run anyway**.

أول ما يفتح البرنامج، حط رابط السيرفر (`https://control.your-domain.com`) والمفتاح، واضغط **اتصال**.

## الأمان
- الـ Agent يسمع على `127.0.0.1` بس، والوصول له من برّا يكون عن طريق Caddy (HTTPS).
- كل طلب يحتاج مفتاح API، وبعد 10 محاولات غلط يتقفل الـ IP لمدة 15 دقيقة.
- قيم `.env` ما تطلع من السيرفر أبداً، والتوكنات (ديسكورد وGitHub والـ webhooks وأي قيمة سرية من `.env` أو pm2) تنشال من السجلات والتقارير.
- البرنامج يحفظ المفتاح مشفّر بحساب ويندوز (DPAPI)، وواجهة البرنامج نفسها ما تشوف المفتاح.
- لتغيير المفتاح: `cd control/agent && npm run keygen -- --force && pm2 restart gnd-control`.

## للمطورين
```bash
cd control/agent && npm test                    # 20 اختبار، منها اختبار حقيقي مع pm2 وبوتات وهمية
cd control/desktop && npm run preview -- out    # لقطات شاشة للواجهة (يحتاج playwright)
cd control/desktop && xvfb-run -a npm run e2e   # يشغّل برنامج Electron الحقيقي ضد Agent حقيقي
```
ألوان الثيم كلها في `control/desktop/src/renderer/theme.css`.
