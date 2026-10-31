# §4 منقّحة — جدول النتائج (Findings) على الحالة الراهنة

**التاريخ:** 2026‑10‑31 (الدورة الأولى) · 2026‑11‑01 (دورة الـvault) · **القياس على:** `c5f817d` · **مصدر الجدول:** «مراجعة معمارية + خطة معالجة — real-browser-mcp» (تقرير جلسة خارجية، كُتب عند `532d895`)

> هذا الجدول هو **§4 من ذلك التقرير، مُعاد قياسها على الشجرة الحالية** — لا نقلٌ لكلام. كل خانة «الدليل» مُقيسة بأمر أو فحص على `bc0edeb`، والبنود التي تغيّرت أحكامها مبنيّة على الأدلة لا على التقدير.
>
> **الرموز:** `✅ مُصلَح` · `🟡 مُصلَح جزئيًا` · `🔵 يحتاج قرار المالك` · `⏭️ متجاوز/غير منطبق` · `❌ لم يُنفَّذ`

---

## 0. الخلاصة

| | العدد |
|---|---|
| بنود مُصلَحة | **19** |
| بنود مُصلَحة جزئيًا | **3** |
| بنود تحتاج قرار المالك | **9** |
| بنود متجاوزة/غير منطبقة | **4** |
| **مجموع** | **35** (F‑01…F‑26 من التقرير + F‑27…F‑33 من دورة سابقة + **F‑34…F‑38 من القياس الحيّ لأداة الـvault** + **F‑39…F‑40 من جولة الحساب الحقيقي**) |

**البند الأهمّ في هذه الدورة ليس في التقرير الأصلي:** الـmerge أدخل عقدين **متناقضين** في الشجرة، فأنتج فشلاً حتمياً على ويندوز. تفاصيله §2.

**دورة الـvault (F‑34…F‑40):** سبعة بنود جديدة من القياس الحيّ — ستّة مُنفَّذة ومُختبَرة، وواحد (F‑35) تبيّن بالقياس وبمواصفات `specs/006` أنه **تصميم موثّق لا عيب** ⇒ سُجّل `⏭️` بلا تعديل سلوكي.

---

## 1. جدول النتائج

| ID | العنوان (كما في التقرير الأصلي) | الخطورة | الحالة الآن | الدليل (مقيس 2026-10-31) | المتبقّي |
|---|---|:--:|:--:|---|---|
| **F‑01** | شوكة `memory/` ↔ `map-*`: تطبيقان متوازيان، وخطر صيانة مَسارين | S1 | ✅ | `core/bounded-queue.ts` (446) + `core/json-store.ts` مشتركة: `memory/queue.ts` (366) و`memory/map-queue.ts` (390) **يستوردان المحرّك نفسه** لا ينسخانه؛ `memory/store.ts` (359) و`memory/map-store.ts` (495) كذلك ⇒ صفر تكرار خوارزمي | التكرار الحرفي المقيس كان ≈4.5% فقط (لا «نظام مكتوب مرتين») ⇒ الخطر المتبقي انجراف المواصفة لا ازدواج الشيفرة |
| **F‑02** | `main` غير محمي + auto-merge يتجاوز CI | S1 | 🔵 | **مُثبَت من الـAPI العام**: `GET /repos/compnew2006/browser-controller/branches/main` ⇒ `"protected": false` · `protection.enabled: false` · `required_status_checks.enforcement_level: "off"` · و`.github/workflows/dependabot-auto-merge.yml` موجود | إعدادات GitHub خارج المستودع — Q‑1/Q‑2 |
| **F‑03** | بوابة التغطية تقيس 0.58% من الإنتاج | S2 | ✅ | `vitest.config.ts`: `include: ['mcp-server/src/**/*.ts', 'extension/**/*.js']` = **167 ملف إنتاج** (كان 4) + `reportOnFailure: true` ⇒ العتبات تُفحص فعلاً | — |
| **F‑04** | اسم npm محجوز من طرف ثالث | S1 | 🔵 | `npm view browser-controller version` ⇒ **0.0.6** (طرف ثالث) · `npm view browser-controller@3.1.1` ⇒ **E404** | اختيار معرّف بديل — Q‑5 |
| **F‑05** | سجل التدقيق متأخر 79 كوميتًا | S2 | ✅ | `docs/audit/04-duplication-register.md` خط الأساس الآن **`0c0c2ce`** (كان `c2b37f6`) | — |
| **F‑06** | انجراف جرد الأدوات: 17 مقابل 22 | S2 | ✅ | `llms.txt` = **22 أداة بالضبط** (مقيس) + اختبار انجراف في `tests/protocol-tool-names.test.ts` | — |
| **F‑07** | رموز الخطأ stringly-typed بلا سجل مركزي | S2 | ✅ | `core/error-codes.ts` = **81 رمزاً** · `CODED_MESSAGE` = **0** بقية · و`4936f3e` سدَّد آخر بقاياه («unknown error codes → INTERNAL_ERROR») | — |
| **F‑08** | لا مخطط إطارات سلكي قابل للتحقق | S2 | 🟡 | `mcp-server/src/protocol/frames.ts` (4,009 بايت) + **21 اختبار إطارات ذهبية** في `tests/protocol-contracts/` ⇒ العقد **مُختبر**؛ لكن `specs/contracts/` ما زال `README.md` وحده ⇒ **لا مخطط JSON** | قرار المالك في «2.1» (مخطط JSON) — انظر F‑29 لتفصيلPointer قديم |
| **F‑09** | اتجاه الاعتماد عبر حدّ السلك + حارس مشترك منقسم | S3 | ✅ | `mcp-server/src/protocol/` **لا يستورد طبقة الأدوات** (0 استيراد) · `memory/guards.ts` محذوف · `core/guards.ts` (23 سطراً) النسخة الوحيدة | — |
| **F‑10** | ثلاث مخازن JSON مستقلة | S2 | ✅ | `core/json-store.ts` = محرّك واحد للكتابة الذرّية والصلاحيات والحجر والتنظيف، تستعمله المخازن الثلاثة | — |
| **F‑11** | ADR متشظٍّ ومتصادم | S2 | 🟡 | `docs/adr/README.md` (10,789 بايت) فهرس يحسم التصادم **بلا حذف**؛ لكن عنوان «ADR‑01 — One source of truth for the wire protocol» **ما زال موجوداً** في `docs/audit/05-architecture-analysis.md` (مُحقَّق) | إعادة الترقيم — قرار المالك («1.9») |
| **F‑12** | لا correlation ID ولا سجل منظَّم | S2 | 🟡 | `core/logger.ts` (113) سجل منظَّم + معرّف ارتباط في `AsyncLocalStorage` · `register-tools.ts:134` معرّف لكل استدعاء MCP · `bridge.ts:479` ينقله وإعادة المحاولة تشترك فيه؛ **لكن الامتداد لا يراه** (0 ذكر في `extension/`) ⇒ لم يعبر السلك WS | نقله عبر السلك («1.8») |
| **F‑13** | غياب commitlint/husky/CODEOWNERS/PR template | S3 | 🔵 | **الكل غائب** (مُحقَّق): لا `.husky` · لا `commitlint.config.js` · لا `.commitlintrc.json` · لا `.pre-commit-config.yaml` · لا `CODEOWNERS` · لا `pull_request_template.md` | تثبيت حزم وسير عمل |
| **F‑14** | `context:measure` موجود وغير مفروض | S3 | ✅ | **داخل `ci.yml`** (مُحقَّق) ⇒ صار مُفرضاً | رقم السقف قرار منفصل |
| **F‑15** | أربعة أسطح تعليمات وكلاء متعارضة | S3 | 🔵 | `agent-config/AGENTS.md` موجود و**فرقه 64 سطراً** عن `AGENTS.md` ⇒ الانجراف قائم | تحديد مصدر حقيقة واحد — قرار حوكمة |
| **F‑16** | مخططات الـfeatures لا تُحدَّث | S3 | 🔵 | **9 من 10** ملفات `specs/features/*.md` ختموها بـ`version: vX.Y.Z`؛ ملف واحد لا | ختم الملف العاشر + فحص آلي |
| **F‑17** | `.changes/` قديم على القرص | S4 | ⏭️ | **المجلد غير موجود** في هذه الشجرة (وهو في `.gitignore`) ⇒ غير منطبق | — |
| **F‑18** | عمق المواصفات متناقص (005/006) | S4 | ⏭️ | `specs/005-direct-site-routing` = **4 ملفات** · `specs/006-vault-site-approval` = **4 ملفات** — ينقصهما الأربعة نفسها؛ و`007` = 11 ملفاً | خارج قائمة ما Allows صراحةً |
| **F‑19** | لا SBOM / provenance / SLSA | S3 | 🔵 | لا أتمتة attest/SBOM في أي workflow (مُحقَّق) | حسابات npm + Chrome Web Store |
| **F‑20** | smoke tests خارج CI | S3 | 🔵 | `ci.yml` **لا يذكر smoke** (مُحقَّق) | `smoke:vault-isolated` و`smoke:vault-card` بلا بروفايل ⇒ الأقرب للتشغيل في CI |
| **F‑21** | الحارس في موضع لا يملكه | S4 | ✅ | `core/guards.ts` · `memory/guards.ts` محذوف · **صفر** استيراد vault→memory | — |
| **F‑22** | صياغة النتائج ومخططات الأدوات مبنية يدويًا | S3 | ⏭️ | `core/result.ts` **غير موجود** — لم يُنشأ | قرار منفصل |
| **F‑23** | لا `.editorconfig` ولا مُنسّق | S4 | ✅ | `.editorconfig` موجود (بلا Prettier) | — |
| **F‑24** | «الأدوات 22» لا يُشتقّ من الكود | S3 | ✅ | `protocol/tool-names.ts` **مولَّد** (يُعيد بناءه `npm run build`) + اختبار انجراف سلبي | — |
| **F‑25** | بنية الإطار بلا اختبارات تعاقدية | S2 | ✅ | `tests/protocol-contracts/` = **21 حالة** (إطارات ذهبية + اختبار سالب) | — |
| **F‑26** | تذبذب CI: منافذ الاختبارات من نافذة 50 منفذاً | S2 | ✅ | `tests/helpers/free-port.ts` (منفذ من النظام) + **14 ملف** يستوردها · **صفر** نافذة منفذ ثابتة باقية (`19410 +` · `30_000 +` = 0) · الفشل المتكرر اختفى | — |
| **F‑27** 🆕 | **الـmerge أدخل عقدين متناقضين ⇒ فشل حتمي على ويندوز** | S1 | ✅ (أُصلح) | `isVanished` صار «ENOENT فقط» ⇒ القراءة المُتسابقة مع الحذف **ترفض** بـ`MemoryStoreError` بدل «لا سجل» ⇒ `tests/memory-review-fixes.test.ts` يفشل **3/3** (ليس تذبذباً) | أُصلح بقاعدة تستشير نظام الملفات — §2 |
| **F‑28** 🆕 | **الـmerge حذف `tests/helpers/net.ts`** | S3 | ✅ | حُسم صحيحاً: المستودع صار على `tests/helpers/free-port.ts` (نسخة الجلسة الأخرى) و**كل الـ14 مستورد يشير إليه** ⇒ لا استيراد يتيم، وtypecheck = 0 | — |
| **F‑29** 🆕 | **`extension/lib/protocol.js:1` يشير إلى ملف محذوف** | S3 | ❌ | السطر: «Keep in sync with EXTENSION_PROTOCOL_VERSION in **mcp-server/src/protocol.ts**» — و`mcp-server/src/protocol.ts` **محذوف** (نُقل إلى `mcp-server/src/protocol/capabilities.ts`) ⇒ المؤشّر يشير إلى لا شيء | **سطر تعليق واحد** — لم أُعدّله (تغيير في الامتداد) |
| **F‑30** 🆕 | **تنبيه dependabot #9** | S2 | ✅ | `npm audit` (الشجرة كاملة) ⇒ **0 ثغرات** · `@hono/node-server` 2.1.1→**2.1.5** (GHSA‑rmxm‑3fg6‑px4f) · `minimatch` 10.2.6→**11.0.3** بـ`overrides` (GHSA‑g3hv‑75wg‑m249) بلا تراجع كاسر لـ`@eslint/js` | — |
| **F‑31** 🆕 | **أسقف التغطية على حافة الانهيار** | S3 | 🔵 | الهامش في `extension/**` lines = **+0.03 نقطة** (77.03 مقابل سقف 77) وفي `mcp-server/src/**` lines = **+0.14** (86.14 مقابل 86) ⇒ سطر واحد غير مغطٍّ يُسقط البوابة | **قرار المالك**: خفض 77→76 و86→85 (قاعدته: الأسقف تنخفض ولا ترتفع) |
| **F‑32** 🆕 | **قياس حي مستحيل على المسار الموثَّق للـfixture** | S2 | ✅ | `shapePath` يبقي المسار فقط إذا كان **كل مقطع** في القائمة المراجَعة؛ و`/account/login/form-shape.html` آخر مقطع فيه `form-shape.html` **خارجها** ⇒ الشكل يُقاس ثم يُسقَط عند التخزين ⇒ القياس الحي على ذلك المسار **لا يمكن أن ينجح** | أُصلح: الـharness يقدّم الـfixture على `/account/signin` (مسار قابل للتخزين) + التوثيق |
| **F‑33** 🆕 | **الـvault كان يرفض كل ملف على ويندوز** | S1 | ✅ | `assertOwnerMode` قارن بتّات POSIX على منصة لا تملكها ⇒ `VAULT_STORAGE_INVALID` لكل ملف ⇒ 61 اختباراً فاشلاً | أُصلح: القاعدة حيث توجد البتّات فقط، وفحص الرمز الرمزي/الملف العادي في كل منصة |
| **F‑34** 🆕 | **قراءة أثناء بطاقة موافقة معلّقة ⇒ `TIMEOUT` بلا كود** | S3 | ✅ | على تبويب Smacc Login (1229892562) وبطاقة معلّقة: `browser_text` و`browser_screenshot` **كلٌّ منهما 3×15s = 45s** برمز `TIMEOUT` عام؛ و`daemon.log`: `Timeout on browser_screenshot, retry 1/2` + `browser_text` ⇒ الامتداد لم يجب. **نفس الأداتان نجحتا فوراً** على تبويب PaperCut (1229888111) بنفس الحالة بالضبط ⇒ anomaly مخصّص بالتبويب لا سلوك عام | **أُصلح التشخيص**: `VaultService.approvalCardHint()` + `vault/daemon-routing.ts` يُلحقان بالـtimeout جملة «An approval card is open on this tab: the owner has not decided yet, so the page may not answer.» ⇒ الوكيل يعرف ما ينتظره. **سبب تعطّل القراءة نفسه لم يُحسم** [تخمين] |
| **F‑35** 🆕 | **كل إعادة `list` تُنشئ قيداً جديداً بلا dedupe** | S4 | ⏭️ | `requests.ts:44-69`: `begin()` يصنع `requestId` جديداً دائماً؛ البطاقة نفسها تُشارَك بـ`cardOf` (`:71-76`) ⇒ القياس (7 سجلّات طلب لـ 3 قرارات مالك) **هو التصميم الموثّق** لا عيب: كل نداء = طلب مستقل، والطلبات تتشارك **بطاقة واحدة** تُحسم مرّة (specs/006 FR‑004/FR‑007) | **لا إجراء**: محاولة «إصلاحه» بدمج الطلبات كسرت قسماً من مواصفات 006 ⇒ رُدّت؛ السلوك مختبَر (`tests/vault-service.test.ts` يطلب طلبين متstanding على بطاقة واحدة) |
| **F‑36** 🆕 | **`fill` بـhandle خاطئ ⇒ نفس الرمز العام للحالة غير الممنوحة** | S3 | ✅ | `fill.ts:75-77`: `store.get(handle)` ⇒ `null` ⇒ `VAULT_PERMISSION_DENIED` — نفس رمز «لا منح» ⇒ الوكيل **لا يميّز** «الحساب غير موجود» عن «الموقع غير مُعتمد»؛ والرسالة «This browser, site, account, or session does not have a current user grant» | **أُصلح**: رمز جديد `VAULT_HANDLE_NOT_FOUND` + رسالة «No saved account matches that handle in this vault. List the accounts of this site again.» (`core/error-codes.ts` · `vault/service-common.ts` · `vault/fill.ts`) |
| **F‑37** 🆕 | **سجلّ الـdaemon لا يسجّل أي حدث vault** | S3 | ✅ | `daemon.log` كاملاً (3,132 بايت): **0** سطر لـ`vault`/`grant`/`card`/`prompt`/`approval` ⇒ 29 سطر daemon + 12 سطر bridge فقط. أثر القرارات (قبول/رفض/ملء) **غير مرئي للمشغّل**؛ التدقيق داخل المتجر المشفّر وحده | **أُصلح**: سطر لكل نداء vault (`vault/daemon-routing.ts` → `logVaultOutcome`) ولكل قرار المالك في الصفحة الخاصة (`vault/bridge-transport.ts`) — العملية والنتيجة والموقع ومعرّف الطلب، بلا handle ولا اسم حساب ولا كلمة مرور |
| **F‑38** 🆕 | **سباق عند الحدّ: مهلة البطاقة = مهلة الأداة** | S3 | ✅ | `service-common.ts:12` `VAULT_CARD_WAIT_MS = 40_000` = `tools/vault.ts:31` `timeoutMs: 40_000` ⇒ لو تأخّر ردّ الـdaemon بقليل صار `TIMEOUT` بدل `VAULT_USER_ACTION_REQUIRED`. **قيس 6 مرات، فاز الـdaemon في كل مرة** (وصل `user_action_required` لا `TIMEOUT`) | **أُصلح**: `timeoutMs` = **80s** ⇒ يغطي انتظار البطاقة (40s) + ميزانية التعبئة (30s) + هامش |
| **F‑39** 🆕 | **فشل حفظ/ملء في الـvault يُبلَّغ بلا سبب** | S3 | ✅ | محاولة `save_login` على BioTime انتهت `status:"failed"` — **لا رمز خطأ ولا رسالة** تصل للوكيل، ولا سطر في سجلّ الـdaemon (F‑37)، ولا صفحة تدقيق في واجهة الـvault (`grep audit` في `extension/vault/` ⇒ صفر). النتيجة الوحيدة المتاحة: إعادة قراءة حالة الطلب ⇒ `'failed'` ⇒ وسبب الفشل **غير قابل للتشخيص** لا من جهة المالك ولا من جهة الوكيل | **أُصلح**: `failureReasonOf()` (رسائل الـvault الثابتة فقط — لا مسار ملف ولا قيمة) + `requests.fail()` + حقل `reason` في `requestState` وفي `browser_vault {action:'status'}` ⇒ السبب يصل للوكيل |
| **F‑40** 🆕 | **ثلاثة أذونات "السماح" متقاربة لا تُميّز في الثبات** | S3 | ✅ | (1) مربع نموذج الحفظ: "Allow agents to use sign-ins on this site **until the vault locks**" ⇒ منح **في الذاكرة فقط** (`service-private.ts:233-237` · `via:'page'` · يُمحى عند القفل) · (2) مربع البطاقة: "**Always** allow this site" ⇒ `store.allowlistAdd` **دائم** (`service-private.ts:423-427` · `via:'allowlist'`) · (3) نموذج "Always allow" في صفحة الـvault ⇒ دائم. التسمية (1) توحي بالدوام بينما هي العكس | **أُصلح**: ملاحظة صريحة تحت مربع نموذج الحفظ («Ends when the vault locks. "Always allow" in Site access keeps the site approved across locks.») وتوسيع تلميح البطاقة («Kept in the encrypted vault, so it survives a lock.») + توثيق الثلاثة في README |

---

## 1.1 القياس الحيّ لأداة الـvault — 2026‑11‑01

**البيئة:** daemon `3.1.1` (pid 255740 · منفذ 7225) · Chrome Profile 2 (`41654896cc79`) · الامتداد `cjifmakgbpibolgnjnfbdphmnpdjkgln` · **14 استدعاءً حيّاً · 5 مسارات · 5 أخطاء مقيسة**.

| # | الاستدعاء | النتيجة المقيسة | ملاحظة |
|---|---|---|---|
| 1 | `status` | `status:"empty"` + `browserLabel` | لا مجلد `vault/` على القرص ⇒ الحالة صادقة |
| 2 | `fill` بلا handle | `INVALID_ARGUMENT: handle is required` | من **الـdaemon** (`service.ts:51`) لا من zod: `tools/call` يتجاوز تحقّق SDK عمداً (`register-tools.ts:128-131`) ⇒ الفيصل دائماً خادم |
| 3 | `list` على تبويب `chrome://` | `VAULT_ORIGIN_UNSUPPORTED` | فوري، بلا بطاقة |
| 4 | `list` على صفحة دخول | بطاقة **مرسومة فعلاً** (مثبتة بلقطة شاشة) ← `VAULT_USER_ACTION_REQUIRED` + `requestId` | انتظار 40s = `VAULT_CARD_WAIT_MS` |
| 5 | Allow من المالك | `{"success":true,"status":"ready","origin":"http://localhost","accounts":[]}` | المسار الكامل في نداء واحد |
| 6 | `status` بعد التجهيز | `ready` | `vault/<hash>/key` (32B) + `store.enc` (804B) |
| 7 | `list` ثانية | نفس النتيجة **فوراً** | المنح مخبّأ — بلا بطاقة |
| 8 | `fill` + handle وهمي | `VAULT_PERMISSION_DENIED` | **لا كتابة في الصفحة**: `fill.ts:75-77` يسبق أي write |
| 9 | `browser_click` أثناء بطاقة | `VAULT_APPROVAL_PENDING` | الصفحة لم تُلمس |
| 10 | قراءة + لقطة أثناء بطاقة (PaperCut) | نجحت **فوراً** | العقد سليم عموماً ⇒ يعزل F‑34 |
| 11 | قراءة + لقطة أثناء بطاقة (Smacc) | `TIMEOUT` 3×15s = **45s** | ⇒ F‑34 |
| 12 | TTL 5 دقائق | `status:"expired"` | ثم `list` ⇒ طلب وبطاقة جديدان |
| 13 | Deny من المالك | `VAULT_DECLINED` | فوري |
| 14 | `status` لطلب قديم | `VAULT_PERMISSION_DENIED` | السجل يُحذف بعد retention 15 دقيقة (`requests.ts:276`) |

**الحالة المتبقية على جهاز المالك:** الـvault **جاهز ومفتوح** (متجر AES‑256‑GCM أُنشئ) · **منحان موقعان نشطان**: `http://localhost` و`http://localhost:9191` (يُسحَبان من *Site access → Revoke* أو بتقفل الـvault أو بإعادة تشغيل الـdaemon) · **لا حسابات محفوظة** · لا طلبات معلّقة (2 مقبولة · 1 مرفوضة · 3 منتهية).

**لم يُقَس (يحتاج مدخَل المالك):** `save_login` بحساب حقيقي · `fill` ناجح · `unlock` كإجراء · `VAULT_CONTEXT_PROTECTED` بعد ملء فعلي.

---

## 1.2 الجولة الثانية — حساب حقيقي + تفعيل `VAULT_CONTEXT_PROTECTED` (2026‑11‑01)

**البيئة:** نفس الـdaemon (pid 255740 · 3.1.1) · Chrome Profile 2 (`41654896cc79`) · **14 استدعاءً إضافياً** · حسابان حقيقيان: **Smacc** (`http://localhost`) و**BioTime** (`http://localhost:8800`).

| # | الاستدعاء | النتيجة المقيسة | الدلالة |
|---|---|---|---|
| 15 | `list` (Smacc) بعد الإدخال اليدوي | `accounts:[{handle:cred_a8d19504…, label:smacc, identifier:1000064442}]` | **الطريقة 1 نجحت** — لا كلمة مرور في الخرج |
| 16 | `fill` (Smacc) | `status:"filled", filled_fields:2, identifier_filled:true, password_filled:true` | **الطريقة 3 نجحت** |
| 17 | `browser_screenshot` على تبويب Smacc | `VAULT_CONTEXT_PROTECTED` | ⇒ الحماية مفعَّلة |
| 18 | `browser_evaluate` على تبويب Smacc | `VAULT_CONTEXT_PROTECTED` | ⇒ `evaluate` محجوب |
| 19 | `browser_screenshot` على تبويب **Meta AI (آخر)** | `VAULT_CONTEXT_PROTECTED` | ⇒ **الحجب على مستوى البروفايل كله** |
| 20 | `browser_logs` على تبويب آخر | `VAULT_CONTEXT_PROTECTED` | ⇒ `logs` محجوب |
| 21 | `browser_text` على تبويب آخر | **نجح** | ⇒ الحجب انتقائي (`service-common.ts:14-21`) |
| 22 | `browser_snapshot` على تبويب Smacc | `textbox "Login ID" value="1000064442"` · `textbox "Password" value="••••"` | ⇒ الاسم **كُتب فعلاً** والسرّ **مُقنَّع** |
| 23 | `save_login` على تبويب BioTime | طلب `purpose:"save"` + `VAULT_USER_ACTION_REQUIRED` | **لا بطاقة**: الطلب يذهب لصفحة الـvault (`:124-127`) |
| 24 | محاولة الحفظ الأولى | `status:"failed"` — **بلا سبب مرئي** | ⇒ **F‑39** |
| 25 | محاولة الحفظ الثانية ("Save account") | `cred_5fce465e…` · `biotimes` · `noiemany` | **الطريقة 2 نجحت** |
| 26 | `list` على BioTime بعد "Always allow this site" | الحساب يظهر **بلا بطاقة** | ⇒ المنح الدائم يعمل ⇒ **F‑40** |
| 27 | `fill` على BioTime | `filled_fields:2` — والـURL الفعلي للصفحة = `http://localhost:8800/login/?next=/` (انتهت الجلسة ⇒ صارت شاشة دخول) | ⇒ الملء وقع في **نموذج دخول حقيقي** |
| 28 | `browser_screenshot` على تبويب BioTime | `VAULT_CONTEXT_PROTECTED` | ⇒ الوثيقة الجديدة محمية أيضاً |

**الدروس المقيسة:** الملء **لا يضغط Submit** (بقى الـURL على `/login/`) · كلمة المرور **لا تظهر في أي قراءة** (مقنَّعة) · `VAULT_CONTEXT_PROTECTED` **يعمل بروفايل-عريض** ويحجب `screenshot`/`logs`/`evaluate`/`mock` مع الإبقاء على `snapshot`/`text`/`wait`/`scroll`/`click`/`type`/`tabs`/`navigate`.

---

## 1.3 الجولة الثالثة — الدخول بكلمات السرّ المحفوظة (2026‑11‑01)

**الهدف:** هل تعمل كلمة المرور المخزّنة في الـvault فعلياً على شاشة الدخول؟ **النتيجة: نعم — دخولان حقيقيان بنجاح، بلا تدخل منك بعد الحفظ.**

| # | الخطوة | النتيجة المقيسة |
|---|---|---|
| 29 | `browser_navigate {url:'reload'}` على تبويبَي Smacc وBioTime | كلاهما `status:200` · `Smacc Login` · `Log in` |
| 30 | `browser_snapshot` (Smacc) قبل الملء | الحقلان **فارغان** ⇒ خط أساس نظيف (لا تلء تلقائي من Chrome) |
| 31 | `browser_snapshot` (BioTime) قبل الملء | `value="noiemany"` + `value="••••"` ⇒ **Chrome ملأهما** ("Remember Me" مفعّل) ⇒ خط أساس غير نظيف هناك |
| 32 | `fill` (Smacc, `cred_a8d19504…`) | `status:"filled", filled_fields:2, identifier_filled:true, password_filled:true` |
| 33 | `browser_snapshot` (Smacc) بعد الملء | `textbox "Login ID" value="1000064442"` · `textbox "Password" value="••••"` ⇒ **الـvault كتب القيمتين في نموذج فارغ** (إثبات نظيف) |
| 34 | `browser_click {role:'button', name:'Login'}` (Smacc) | `clicked` ⇒ **أُرسل النموذج** |
| 35 | قراءة التبويب بعد الإرسال | `localhost/Default.aspx` · العنوان **"SMACC"** · لوح بالعربية: الرئيسية · الأعدادات · المحاسبه الماليه · الأصول الثابته · المخزون · الموظفين · ادارة نقاط البيع · `2246` عميلاً · `10` بائعين · `4` محصّلين ⇒ **دخول حقيقي** |
| 36 | `fill` (BioTime, `cred_5fce465e…`) | `status:"filled", filled_fields:2` |
| 37 | `browser_click {role:'button', name:'Login'}` (BioTime) | `clicked` |
| 38 | قراءة التبويب بعد الإرسال | `localhost:8800` · العنوان **"BioTime 9.5"** · لوحة الحضور الحيّة (طويق · رحمة · طه · أبو سعيد) والمسجَّل **"قدرات"** ⇒ **دخول حقيقي** |
| 39 | `browser_screenshot` على تبويب **ثالث** بعد الدخولين | `VAULT_CONTEXT_PROTECTED` ⇒ الحماية ما زالت بروفايل-عريض |
| 40 | `browser_vault {action:'status'}` | `status:"ready"` |

**سلوك مُفسَّر بالكود (fail-closed مقصود):** الحماية تُرفع بـ`removeProtectedTab` عند **إغلاق التبويب أو استبداله** فقط (`extension/events.js:55-60` · `vault-actions.js:209-219`)، **لا عند التنقّل داخله** ⇒ بعد الدخول تبقى `screenshot`/`logs`/`evaluate`/`mock` محجوبةً على **البروفايل كله** ما دام التبويب حيّاً. `browser_wait {until:'stable'}` أثناء التنقّل يُبلّغ `TIMEOUT: the page could not be read after 205 ms` (نفس عائلة F‑34).

---

## 2. F‑27/F‑28 — الـmerge الذي كسر عقدين

### 2.1 ما حدث

الـmerge `8d6e198` (فرع `fix/remaining-gaps-2026-10-31` + `fix/test-port-allocation-2026-10-31`) أدخل **مَستودعَين متعارضين في مسألة واحدة**:

| العقد | المصدر | ما يطلبه |
|---|---|---|
| «قراءة تُسابق حذفاً **لا ترمي أبداً**» | `tests/memory-review-fixes.test.ts:51` (اختبار races) | على ويندوز: خطأ المشاركة = الملف **راح** ⇒ «لا سجل» |
| «**يفشل مغلقاً** على أخطاء الوصول والمشاركة» | `tests/map-store.test.ts:132` (T009) | على ويندوز: الملف **موجود** ولا يُقرأ ⇒ خطأ |

وكلاهما يُلغى في `isVanished` واحدة. ⇒ على ويندوز: **فشل حتمي** (`MemoryStoreError: site file could not be read`)، 3 من 3 تشغيلات.

### 2.2 لماذا ليستا متناقضتين حقاً

الاختباران يحاكيان شيئين مختلفين: T009 **يحقن** فشل `readFile` على ملف **موجود**؛ وسباق الحذف **حذفٌ حقيقي**. على ويندوز كلاهما `EPERM/EACCES/EBUSY` — لكن **نظام الملفات يفرّق بينهما**: هل ما زال الملف موجوداً بعد الخطأ؟

### 2.3 الحل المطبَّق

قاعدة جديدة في `core/json-store.ts` — `isGoneAfterError(error, file, platform)`:

- `ENOENT` ⇒ راح (كل المنصّات).
- على ويندوز، `EPERM/EACCES/EBUSY` ⇒ **تسأل نظام الملفات**: `lstat` على المسار ⇒ `ENOENT` ⇒ راح (تُجيب «لا سجل») · الملف موجود ⇒ **تفشل مغلقاً**.
- على POSIX: `EACCES` = الملف موجود ولا يُقرأ ⇒ تفشل مغلقاً.

و`isVanished` بقيت **«ENOENT فقط»** لأن عقدها مثبَّت في `tests/json-store.test.ts:29-32` («fails closed on ambiguous access or sharing errors on every platform»).

**النتيجة:** الاختباران يمرّان معاً — `memory-review-fixes` ✓ · `map-store` (T009) ✓ · `json-store` ✓ · و`memory-store` بقي فشله البيئي POSIXي وحده.

> **لماذا كان سبب الجلسة الأخرى غير حاسم هنا:** `putSite` **لا يقرأ السجل السابق إطلاقاً** — الكتابة استبدال ذرّي كامل (temp → rename) مع إعادة محاولة الـrename على ويندوز. فلا وجود لـread-modify-write يعتمد على `isVanished` في هذا المسار: الحجة التي كُتبت لأجلها القاعدة غير موجودة في الشيفرة التي تحكمها.

---

## 3. البوابة على الشجرة الحالية

| الفحص | النتيجة |
|---|---|
| `npm run lint` | **0** |
| `npm run typecheck` | **0** |
| `npm run build` | **0** (ويعيد توليد `protocol/tool-names.ts`) |
| `npm run arch:check` | **8/8** |
| `npm run context:lint` | **100/100** |
| `npm run security:audit` | **0** · و`npm audit` الكامل **0** |
| الاختبارات | **2,568** · 2,468 ناجح · 62 فاشل |
| المقارنة بالاسم مقابل خط الأساس | **NEW = 0 · GONE = 0** |
| التغطية | statements 78.34% · branches 75.68% · functions 81.76% · lines 81.83% — **كل العتبات تُجتاز** |

الفشل الـ62 كلها بيئية على ويندوز (الأنبوب الثابت `\\.\pipe\browser-controller` يمنع daemon معزولاً) — لم يتغيّر عددها ولا أسماؤها.

---

## 4. ما لم يُنفَّذ (ومَن يبقيه)

| # | البند | السبب | إجراء المالك |
|---|---|---|---|
| 1 | F‑02 · `main` غير محمي + auto-merge يتجاوز CI | إعدادات GitHub خارج المستودع | `settings/branches` + `settings/actions` |
| 2 | F‑04 · اسم npm محجوز | قرار ملكية | معرّف بديل `@<owner>/browser-controller` |
| 3 | F‑13 · بوابات المراجعة (commitlint/husky/CODEOWNERS/PR template) | تحتاج تثبيت حزم | تثبيت + سير عمل |
| 4 | F‑15 · أربعة أسطح تعليمات متعارضة | قرار حوكمة | مصدر حقيقة واحد |
| 5 | F‑16 · ختم نسخة مخططات الـfeatures | ملف واحد + فحص آلي | ختم + CI |
| 6 | F‑19 · SBOM/provenance/SLSA | حسابات | `npm publish --provenance` + attestation |
| 7 | F‑20 · smoke خارج CI | `smoke:vault-isolated`/`smoke:vault-card` بلا بروفايل ⇒ الأقرب | workflow منفصل باليد |
| 8 | F‑31 · أسقف التغطية على حافة الانهيار | **قرار المالك**: القاعدة «الأسقف تنخفض ولا ترتفع» | خفض 77→76 و86→85 إن أراد هامشاً |
| 9 | F‑29 · `extension/lib/protocol.js:1` يشير إلى ملف محذوف | **لم أعدّله**: تغيير في امتداد يعمل في Chrome المالك | تصحيح سطر واحد |

**أُغلقت البنود F‑34…F‑40 في هذه الجولة** — ستّة مُنفَّذة ومُختبَرة (F‑34 · F‑36 · F‑37 · F‑38 · F‑39 · F‑40) وواحد تجاوزٌ موثّق (F‑35). الدليل والحالة في §1.

---

## 5. المصدر

- التقرير الأصلي: «مراجعة معمارية + خطة معالجة — real-browser-mcp (browser-controller)» — §4 (خارج المستودع)، كُتب عند `532d895`.
- تقرير الحملة: `docs/audit/14-remediation-report.md` (§3 جدول النتائج، §8 المتابعة الأولى، §9 المتابعة الثانية).
- صيانة git والتبعيات: `docs/audit/15-git-hygiene-and-dependency-audit.md`.
- قياس 007 الحيّ: `specs/007-form-shape-facts/tasks.md` (T022).
- القياس الحيّ لأداة الـvault (2026‑11‑01): 14 استدعاءً على Chrome Profile 2 — §1.1؛ مصدر F‑34…F‑38.
- الجولة الثانية (2026‑11‑01): حسابان حقيقيان (Smacc + BioTime) + تفعيل `VAULT_CONTEXT_PROTECTED` — §1.2؛ مصدر F‑39…F‑40.
- الجولة الثالثة (2026‑11‑01): الدخول الفعلي بكلمات السرّ المحفوظة — §1.3.
- المتابعة الثالثة في تقرير المعالجة: `docs/audit/14-remediation-report.md` §10.
