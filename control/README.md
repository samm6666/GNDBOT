# GND Control

برنامج ويندوز تتحكم منه بالبوتات الثلاث (الموسيقى، والألعاب، والسيستم) وبـ Lavalink اللي على السيرفر.

```
برنامج ويندوز  ⇄ HTTPS ⇄  Coolify (Traefik)  ⇄  gnd-control (Agent)  ⇄  pm2  ⇄  البوتات
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

1. **شغّل الـ Agent بنفس المستخدم اللي يشغّل البوتات (`gnd`):**
   ```bash
   sudo -iu gnd
   cd ~/botm
   bash control/agent/setup.sh
   ```
   السكربت يثبّت المكتبات، ويسوي مفتاح API جديد ويطبعه، ويشغّل `gnd-control` في pm2 حق `gnd` (نفس pm2 اللي فيه البوتات). **انسخ المفتاح**، بتحتاجه في البرنامج.

2. **أسماء pm2:** الـ Agent يتوقع نفس الأسماء اللي على السيرفر: `bot` (الموسيقى) و `games` و `system` و `lavalink` و `web` (الموقع). إذا غيّرتها، انسخ `control/agent/bots.example.json` إلى `control/agent/bots.json` وعدّل الأسماء، وبعدها `pm2 restart gnd-control`.

3. **افتحه على HTTPS عن طريق Coolify:** بروكسي Coolify (Traefik) هو اللي ماسك البورت 80 و 443، ويوصّل `gndbot.site` للموقع على `host.docker.internal:3000`. نضيف له مسار `/gnd-control` يروح للـ Agent، فما تحتاج دومين جديد:
   ```bash
   # كـ root
   ip -4 -o addr show docker0 | awk '{print $4}'      # غالباً 172.17.0.1/16
   ```
   - حط الـ IP (بدون `/16`) في `/home/gnd/botm/control/agent/.env`، كذا: `CONTROL_HOST=172.17.0.1`. بهالطريقة يوصل للـ Agent بروكسي Coolify بس، ومحد يوصله مباشرة من الإنترنت. بعدها `sudo -iu gnd pm2 restart gnd-control`.
   - انسخ ملف المسار:
     ```bash
     cp /home/gnd/botm/control/deploy/coolify-gnd-control.yaml /data/coolify/proxy/dynamic/gnd-control.yaml
     ```
     Traefik يقرأه لحاله خلال ثواني.
   - للتأكد: افتح `https://gndbot.site/gnd-control/healthz`، والمفروض تطلع لك كلمة `ok`.
   - رابط السيرفر اللي تحطه في البرنامج: `https://gndbot.site/gnd-control`

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

أول ما يفتح البرنامج، حط رابط السيرفر (`https://gndbot.site/gnd-control`) والمفتاح، واضغط **اتصال**.

## الأمان
- الـ Agent يسمع على عنوان داخلي بس (`127.0.0.1`، أو `172.17.0.1` مع Coolify)، والوصول له من برّا يكون عن طريق بروكسي HTTPS.
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
