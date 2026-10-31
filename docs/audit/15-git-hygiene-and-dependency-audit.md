# صيانة Git وتدقيق التبعيات — استرجاع stashdrops ومعالجة تنبيه dependabot

**التاريخ:** 2026‑10‑31 · **الفرع:** `main` @ `b4b604b` · **المستودع:** `browser-controller` 3.1.1

هذا التقرير يوثّق تنفيذ بنود تقرير مراجعة جلسة صيانة Git: الاسترجاع الداخلي للـstashdrops الثلاثة المُسقطة، ومعالجة تنبيه dependabot #9، وحسم بند الـworktree. كل بيان هنا مُقيس بأمر مُنفَّذ، لا بالقراءة.

---

## 0. الملخص التنفيذي

| البند | الحالة | الأثر |
|---|---|---|
| 1 — stashdrops الثلاثة `c466658` / `794b282` / `cb9ac85` | **مُسترجَع** | عادوا إلى `refs/stash` بنسخ مُسمّاة + إثبات مكتوب (§1) |
| 2 — تنبيه dependabot #9 (`@hono/node-server`) | **مُصلَح** | `npm audit --omit=dev` ⇒ **0 ثغرات** (§2) |
| 2b — سلسلة ESLint (تنبيه `minimatch`) | **مُسحّة** | `overrides` على minimatch 11 ⇒ `npm audit` الكامل **0 ثغرات** (§2.5) |
| 3 — الـworktree غير المُدار `mewing-feather` | **لا يوجد** | لم يعد موجوداً قبل هذه الجلسة؛ لا إجراء (§3) |
| 4 — `pr_body_fix.json` | **متتبَّع** | البند مسحوب من المراجعة أصلاً؛ لا إجراء (§4) |
| 5 — حذف فرع dependabot | **مُثبت آمن** | الشجرة مطابقة بايت‑ببايت لسلف `main` (§5) |

**ما لم يتغيّر:** لا ملف مصدري. التغيير في الشجرة: `package.json` (حقل `overrides`) و`package-lock.json`. البوابة: lint/typecheck/build = 0، والاختبارات بلا فشل جديد بالاسم (§7).

---

## 1. البند 1 — استرجاع الـstashdrops الثلاثة

### 1.1 المشكلة

`git stash drop` يعيد كتابة سجل مراجع `refs/stash`، فلا يبقى داخل المستودع أي أثر لما كان في الـstashdrops. الثلاثة أصبحوا unreachable، ويصبحون مرشّحين للـgarbage collection.

### 1.2 الإثبات المُلتقط قبل أي تعديل

الأمر `git show --stat` على الثلاثة (الأصل: `git cat-file -t` ⇒ `commit` للثلاثة، أي أن الكائنات ما زالت موجودة):

```
===== c466658 =====
commit c466658affd88621d09013f8bf18a5ad64e7edd3
Merge: c1f2141 07a48e2
Author: compnew2006 <noiemany@gmail.com>
Date:   Tue Oct 27 04:40:47 2026 +0300

    On main: codebase-memory index rewritten locally before 3.0.8 pull

 .codebase-memory/artifact.json |  17 +++++++++--------
 .codebase-memory/graph.db.zst  |  Bin 4234963 -> 3829083 bytes
 2 files changed, 9 insertions(+), 8 deletions(-)

===== 794b282 =====
commit 794b2822658b7513d87edd4db19783fecb2eec1a
Merge: 86a0a63 6e9676d
Date:   Tue Oct 27 05:49:10 2026 +0300

    On main: codebase-memory index rewritten locally before 3.0.9 pull

 .codebase-memory/artifact.json |  14 +++++++-------
 .codebase-memory/graph.db.zst  |  Bin 4399633 -> 4258895 bytes
 2 files changed, 7 insertions(+), 7 deletions(-)

===== cb9ac85 =====
commit cb9ac858129fbbae92f281c5bd0de812f3bbbfc0
Merge: 0f7d0e3 a067080
Date:   Thu Oct 29 02:28:15 2026 +0300

    On main: local codebase-memory index (generated)

 .codebase-memory/artifact.json |  17 +++++++++--------
 .codebase-memory/graph.db.zst  |  Bin 4399633 -> 4275098 bytes
 2 files changed, 9 insertions(+), 8 deletions(-)
```

**النتيجة المُثبتة:** كلُّ واحد من الثلاثة يحوي **ملفَّين اثنين، وكلاهما تحت `.codebase-memory/`** — `artifact.json` (نص) و`graph.db.zst` (ثنائي). لا ملف مصدري واحد، ولا ملف اختبار، ولا إعداد. هذا يؤكّد ما ادُّعاء سابقاً ويحوّله من دعوى إلى دليل.

**التقييم:** `.codebase-memory/` مخرَج آلي محلي — و`AGENTS.md` ينصّ صراحةً على بقائه غير مُودَع. فحتى لو ضاع، ما كان فيه قيمة مصدرية؛ لكنه كان سيُفقد ما بُني من فهرسة محلية. الاسترجاع أرخص من إعادة الفهرسة.

### 1.3 الاسترجاع

```bash
git stash store -m "recovered: codebase-memory index (before 3.0.8 pull) [c466658]" c466658
git stash store -m "recovered: codebase-memory index (before 3.0.9 pull) [794b282]" 794b282
git stash store -m "recovered: codebase-memory index (local generated) [cb9ac85]" cb9ac85
```

**النتيجة:**

```
stash@{0}: recovered: codebase-memory index (local generated) [cb9ac85]
stash@{1}: recovered: codebase-memory index (before 3.0.9 pull) [794b282]
stash@{2}: recovered: codebase-memory index (before 3.0.8 pull) [c466658]
stash@{3}: On main: local console-main.js sourceURL edit (before pull to 3.0.5)
```

الـstash الأصلي (`73104f1` — `console-main.js`) **باقٍ سليم** ومنزلق إلى `stash@{3}`.

**حالة الوصول (reachability) — مُقيسة بالطريقتين:** `git fsck` (الوضع الافتراضي، وهو يحتسب سجلات المراجع) **لا يبلّغ عن أيٍّ من الثلاثة**: كلها قابلة للوصول. والتفصيل الذي لا يظهر في الأمر العادي: `refs/stash` يشير إلى `cb9ac85` مباشرةً (فهو محميّ بالمرجع نفسه)، أمّا `c466658` و`794b282` فيحميهما **سجلّ مراجع `refs/stash`** — ولهذا يبلّغ `git fsck --no-reflogs` (الذي يتجاهل السجلات عمداً) عنهما بأنهما «معلّقان»، ولا يبلّغ عن `cb9ac85`:

```
$ git fsck            → (nothing for the three)     ← reflogs honored
$ git fsck --no-reflogs
dangling commit 794b282…
dangling commit c466658…
```

**ليستا مرشَّحين للـGC:** الـGC يحترم سجلات المراجع افتراضياً. لكن التحفّظ الصادق: حداثة السجلَّين القديمين تتبع سياسة انتهاء سجلات المراجع (`gc.reflogExpire` = 90 يوماً افتراضياً)، فإذا أراد المالك بقاءهما أطول فالمرجع الدائم (tag) هو الطريق، لا الـstash. أي أن الثلاثة محفوظة داخل المستودع، ولا تعتمد على نافذة استرجاع أسبوعين.

### 1.4 ملاحظة على نطاق الممنوع

كل ما سبق كان **قراءة واسترجاع stash** — لا كتابة على الفروع ولا على الفهرس ولا على `main`. الفرع لم يتغيّر.

---

## 2. البند 2 — تنبيه dependabot #9

### 2.1 التشخيص

`npm run security:audit` (= `npm audit --omit=dev --audit-level=high`) قبل الإصلاح:

```
@hono/node-server  1.19.10 - 2.1.2
Severity: moderate
@hono/node-server: `serveStatic` decodes the request path a second time,
leading to bypass of middleware on static paths
https://github.com/advisories/GHSA-rmxm-3fg6-px4f
fix available via `npm audit fix`

1 moderate severity vulnerability
```

السلسلة: `browser-controller` → `@modelcontextprotocol/sdk` → `@hono/node-server` (عبور عابر، غير مُعلَن مباشرة).

### 2.2 التعرّض الفعلي

**مؤكَّد:** المستودع **لا يستدعي** `serveStatic` من `@hono/node-server` إطلاقاً. البحث في الشجرة كلَّها عن `serveStatic`/`@hono/node-server`/`from 'hono'` يعطي نتيجة واحدة — دالة محلية في `tests/helpers/memory-fixtures.ts` باسم `serveStatic`، هي دالة اختبار مكتوبة في المستودع، ليست من الحزمة.

يعني: التعرّض التشغيلي على هذه الشيفرة كان **صفراً**، والتنبيه كان عن حزمة موجودة لا عن مسار مستخدَم. لكنّ التنبيه يبقى تنبيهاً: الحزمة في شجرة الإنتاج، والإصلاح ضمن النطاق المسموح، فلماذا نتركه.

### 2.3 الإصلاح

`npm audit fix` — بلا `--force` (أي بلا كسر التوافق):

| الحزمة | قبل | بعد | ملاحظة |
|---|---|---|---|
| `@hono/node-server` | 2.1.1 | **2.1.5** | الإصلاح الأمني (المُصلَّح من 2.1.3) |
| `@modelcontextprotocol/sdk` | 1.32.1 (مثبَّتة) | **1.32.2** | مُزامَنة: `package.json` يطلب `^1.32.2` و`npm ls` كان يبلّغ `invalid` |
| `eslint` (dev) | 10.13.0 | 10.14.0 | داخل النطاق |
| `minimatch` (dev) | 10.2.5 | 10.2.6 | داخل النطاق |

الـlockfile: `9 insertions(+), 39 deletions(-)` — التَّحذيفات هي حقل `libc` الوصفي من حزم المنصّات الاختيارية (إعادة كتابة npm لبيانات السجلّ)، لا حذف لحزم.

**نطاق `@hono/node-server` عند الـSDK:** `^1.19.9 || ^2.0.5` ⇒ الإصدار 2.1.5 داخل النطاق، بلا كسر للعقد.

### 2.4 النتيجة

```
$ npm run security:audit
found 0 vulnerabilities          (exit 0)

$ npm audit --omit=dev
found 0 vulnerabilities          (exit 0)

$ npm ls @hono/node-server @modelcontextprotocol/sdk
`-- @modelcontextprotocol/sdk@1.32.2
  +-- @hono/node-server@2.1.5
  | `-- hono@4.13.14 deduped
```

بوّابة CI (`npm run security:audit`) صارت نظيفة تماماً، بعد أن كانت تمرّ متجاهِلةً التنبيه لأنها `moderate` مقابل `--audit-level=high`.

### 2.5 تنبيهات سلسلة ESLint — مُسحّة بالـoverride (قرار المالك)

تنبيه شجرة التطوير كان GHSA‑g3hv‑75wg‑m249: `minimatch` قبل 11.0.1، denial of service عبر تضخيم globparts، وهو يصل إلى الشجرة عبر `eslint` → `@eslint/config-array` → `minimatch` (6 مسارات). والمثبَّت كان `10.2.6` — داخل النطاق المتأثر.

**قرار المالك:** تطبيق الـ`overrides` بدل قبول المخاطرة. التطبيق:

```json
"overrides": {
  "minimatch": "^11.0.1"
}
```

**النتيجة بعد التطبيق:**

```
$ npm ls minimatch
`-- eslint@10.14.0
  +-- @eslint/config-array@0.23.5
  | `-- minimatch@11.0.3 deduped
  `-- minimatch@11.0.3 overridden          ← لا وسم invalid

$ npm audit              → found 0 vulnerabilities   (exit 0)   ← الشجرة كاملة
$ npm run security:audit → found 0 vulnerabilities   (exit 0)
$ npm run lint           → EXIT=0
```

فرق القفل: `minimatch` 10.2.6 → 11.0.3، واعتمادٌ جديد `@isaacs/nonrecursive-glob-match@1.0.3`، ونطاق `brace-expansion` من `^5.0.8` إلى `^5.0.12` — **لا حزمة مضافة ولا محذوفة**، ولا أداة تغيّرت.

#### 2.5.1 لماذا الطريق الآلي مرفوض، والطريق المختار مُقاس

**الطريق الآلي (`npm audit fix --force`) — كاسر، ومُقاس:**

```
Will install @eslint/js@9.39.5, which is a breaking change
```

أي **تراجع** لـ`@eslint/js` من 10.0.1 إلى 9.39.5 — لا ترقية. يفكّ التنبيه بإسقاط نسخة من أدوات الفحص، فليس تحسّناً.

**الطريق غير الكاسر (`overrides`) — مُقاس قبل التطبيق، لا بعده:** نسخة معزولة من ESLint 10.14.0 عليها `minimatch@11.0.3`، شغّلتُ بها **ملفات المستودع الحقيقية** و**`eslint.config.js` الحقيقي** بنفس أهداف `npm run lint`:

```
$ node -e "require.resolve('minimatch', { paths: ['<probe>/node_modules/eslint'] })"
<probe>/node_modules/minimatch\dist\commonjs\index.js      ← 11.0.3، لا 10.2.6

$ eslint mcp-server/src tests extension vitest.config.ts eslint.config.js
eslint EXIT=0        ← صفر أخطاء
```

وقبلها اختُبرت أنماط `files`/`ignores` صراحةً: النمط طابق والقاعدة اشتغلت. والحزمة نفسها قابلة للاستدعاء من CJS (توزّع `exports.require` ⇒ `dist/commonjs/index.js`)، فليس هناك كسر ESM/CJS.

**ما لا يغطيه هذا القياس — ويُسجَّل:** `overrides` يدفع `@eslint/config-array` إلى ما هو خارج النطاق الذي يعلنه (`minimatch: ^10.2.4`) — تركيبة لم يخبرها صانع الحزمة. وعلى مستوى المستودع تُركّب `minimatch` من `@eslint/config-array` و`@eslint-community/eslint-utils` معاً. لذا: **الـoverride يُراجَع عند ترقية ESLint القادمة**، ويُحذف إن أعلنته الأداة بنفسها.

**أثره على بوابة CI:** `npm run security:audit` = `npm audit --omit=dev --audit-level=high` — بوابة الإنتاج. البوابة **لا تفحص شجرة التطوير**، فالتنبيهاتُ ومنها كانت ستعبر دون أن تُرى. بعد التطبيق، الشجرة كاملة نظيفة، لكن فحص شجرة التطوير يبقى خارج CI — وهذا بندٌ يستحق قراراً منفصلاً (هل يُضاف `npm audit` كاملاً إلى CI؟).

---

## 3. البند 3 — الـworktree غير المُدار

تقرير المراجعة وصف المسار `.../worktree-pool/browser-controller-.../mewing-feather` كنسخة خارج هذا المستودع.

**القياس الفعلي:**

```
$ git worktree list
C:/Users/Administrator/.zcode/workspace/default/browser-controller b4b604b [main]
```

```
$ Get-ChildItem 'C:\Users\Administrator\.local\share\kilo\worktree-pool' -Force -Recurse
C:\Users\Administrator\.local\share\kilo\worktree-pool\browser-controller-3d8f87ea8255
(عدد العناصر: 1 — المجلد نفسه، وهو فارغ)
```

| الفحص | النتيجة |
|---|---|
| `mewing-feather` موجود؟ | **لا** — `Test-Path` ⇒ `False` |
| `git worktree list` في هذا المستودع | **نسخة واحدة فقط** (النسخة الرئيسية) |
| أي `.git` تحت الـpool | **لا شيء** |
| محتويات `browser-controller-3d8f87ea8255` | **فارغة تماماً** |

**الخلاصة:** الـworktree **لم يعد موجوداً** — نظّفته أداة Kilo نفسها قبل هذه الجلسة. لا `git worktree remove` ولا `git worktree prune` ممكنة ولا مطلوبة: المسار غير مُسجَّل في هذا المستودع أصلاً، و`worktree list` نظيف.

**المتبقّي:** مجلد فارغ واحد داخل pool أداة خارجية. تُرك كما هو: ملكيته لسجلّ Kilo الداخلي، وفِراغه لا يمثّل بقايا بيانات ولا أثراً على المستودع. إن أراد المالك إزالته فليست الأوامر الموضَّحة أدناه إلا تهيئة لـKilo، لا عملية صيانة git.

---

## 4. البند 4 — `pr_body_fix.json`

البند **مسحوب** في المراجعة نفسها: الملف **متتبَّع**، لا خامش.

```
$ git ls-files --error-unmatch pr_body_fix.json   → resolves (tracked)
$ git status --short                                → (clean)
```

لا إجراء. ملاحظة للمالك فقط: ملف خدش في جذر المستودع — قرارُه حذفُه أو إبقاؤه قرارُه، وليس جزءاً من «أصلِح هذا».

---

## 5. البند 5 — تأكيد سلامة حذف فرع dependabot

تقرير المراجعة-self-verified بالفعل، وأُعيد التأكيد على الـcommit لا على ref متحرك:

```
$ git cat-file -t 1dde4f4              → commit
$ git diff --stat 972de04 1dde4f4      → (فارغ)
```

`972de04` سلفٌ لـ`main` الحالي (`b4b604b`)، فشجرةُ فرع dependabot المحذوف مطابقة بايت‑ببايت لسلفٍ موجود في التاريخ ⇒ **لم يفقد الحذف أي محتوى**.

---

## 6. الأوامر المُنفَّذة

```bash
# 1) إثبات واسترجاع الـstashdrops
git show --stat c466658 794b282 cb9ac85
git stash store -m "recovered: codebase-memory index (before 3.0.8 pull) [c466658]" c466658
git stash store -m "recovered: codebase-memory index (before 3.0.9 pull) [794b282]" 794b282
git stash store -m "recovered: codebase-memory index (local generated) [cb9ac85]" cb9ac85
git stash list

# 2) تدقيق وإصلاح التبعيات
npm run security:audit
npm audit fix
npm run security:audit
npm install            # بعد إضافة overrides: { "minimatch": "^11.0.1" }
npm audit              # الشجرة كاملة

# 3) فحص الـworktree
git worktree list
```

**ما لم يُنفَّذ عمداً:** لا `git commit`، ولا `git push`، ولا `git checkout`، ولا `git reset`، ولا `git clean`، ولا أي كتابة على الفروع. المالك ينفّذ الـcommits.

---

## 7. البوابة بعد التنفيذ

| المقياس | قبل | بعد |
|---|---|---|
| `npm run lint` | 0 | **0** |
| `npm run typecheck` | 0 | **0** |
| `npm run build` | 0 | **0** |
| `npm audit --omit=dev` | 1 moderate | **0** |
| `npm audit` (الشجرة كاملة) | 6 moderate | **0** |
| `npm ls` (سلامة الشجرة) | `@modelcontextprotocol/sdk` = `invalid` | **صالح** |
| مجموع الاختبارات | 2,555 | **2,555** |
| ناجح / فاشل | 2,456 / 62 | **2,456 / 62** |
| فشل جديد بالاسم | — | **0** |

الفشل الـ62 الباقية بيئية على ويندوز (الأنبوب الثابت `\\.\pipe\browser-controller`)، لم تتغيّر أسماؤها ولا عددها. تفاصيلها في `docs/audit/14-remediation-report.md` §8.4.
