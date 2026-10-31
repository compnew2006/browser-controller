# ADR index — فهرس سجلات القرارات المعمارية

هذا الملف هو **الفهرس الوحيد** لسجلات القرارات المعمارية في هذا المستودع. وُجد لحل تصادم الترقيم: كان هناك ترقيمان مستقلان يسيران جنبًا إلى جنب، فصار رقم واحد يشير إلى قرارين مختلفين تمامًا.

**ما كان التصادم.** في `docs/adr/` ثمانية سجلات مرقّمة `0001`–`0008`. وفي `docs/audit/` أحد عشر مسودة مرقّمة `ADR-01`–`ADR-11`: خمسة منها في `docs/audit/05-architecture-analysis.md` (قسم 4) وستة في `docs/audit/10-decision-records.md`. فمثلًا `docs/adr/0001-website-memory-store.md` قرار عن مخزن ذاكرة JSON بلا اعتماديات، بينما «ADR-01» في `05-architecture-analysis.md` قرار مختلف تمامًا عن مصدر واحد للحقيقة في بروتوكول السلك. والأسوأ أن الأرقام المتقاربة تُوهم بارتباط موضوعي لا وجود له: «ADR-06» في `10-decision-records.md` هو عن حوكمة `browser_evaluate`، و`docs/adr/0006-the-counter-outside-the-anonymity-gate.md` هو عن عدّاد عناصر التحكّم المخفية خارج بوابة التعتيم.

**ما هذا الملف لا يفعله.** هذا الفهرس لا يعيد ترقيم أي سجل ولا يحذف أيًّا منها ولا يدمج المسودات في السجلات canonical. إعادة الترقيم والدمج قرار يخصّ المالك، وقد تُركت عمدًا. الصفوف التي لا يقابلها سجل canonical عمدًا معلَّمة **«مسودة بلا سجل canonical»** بدل حذفها أو ترقيمها على الخفاء.

---

## 1. السجلات canonical

كل سجل هنا ملف مستقل داخل `docs/adr/`، وحالته مقروءة من حقل `Status` في الملف نفسه. لا شيء هنا مُخمَّن.

| # | File | Title | Status | الموضوع |
|---|---|---|---|---|
| 0001 | `0001-website-memory-store.md` | Dependency-free JSON record store for website memory | `proposed` | مخزن JSON بلا اعتماديات يملكه الـdaemon: `policy.json` وملف لكل أصل، يُستبدل ذرّيًا، خلف واجهة `MemoryStore`. |
| 0002 | `0002-extension-cookies-permission.md` | Add the `cookies` extension permission to verify public status | `accepted` | إضافة إذن `cookies` إلى `extension/manifest.json` لقراءة **أسماء** الكوكيز فقط وحساب `anonymous`؛ بدونه تبقى الميزة `null` بسبب `no_permission`. |
| 0003 | `0003-website-memory-policy-control.md` | Owner CLI plus owner-confirmed agent requests for memory policy | `proposed` | قناتان لتغيير السياسة (CLI المالك، وطلبات الوكيل المؤكدة من المالك) تنتهيان عند `MemoryService.admin` واحد، فمسار واحد لكل انتقال. |
| 0004 | `0004-site-map-storage-and-profile-boundary.md` | Site map storage, per-profile policy and the profile as the account boundary | `proposed` | ملف Chrome هو حدّ الحساب: كل خريطة وعدّاد وسجل سياسة مفهرس بـ`browserId`، وملف سياسة منفصل `memory/map-policy.json`. |
| 0005 | `0005-observing-clicks-for-the-site-map.md` | Observing clicks for the site map | `proposed` | `browser_click` يصبح قابلًا للرصد عند فعالية الخريطة فقط، عبر `siteContext` خفيف لا يقرأ كوكيز ولا تخزين، وبقدرة امتداد جديدة `site-map`. |
| 0006 | `0006-the-counter-outside-the-anonymity-gate.md` | The hidden-control counter sits outside the anonymity gate | `proposed` | fact «شكل النموذج» يمرّ من بوابة التعتيم كأي fact، أما عدّاد عناصر التحكّم المخفية فلا يمرّ بها، ويتبع قاعدة الزيارة. |
| 0007 | `0007-attributing-a-failed-action.md` | A failed action is attributed through the last observed read of its tab | `proposed` | خدمة الذاكرة تحتفظ بذاكرة تبويبات خاصة بها (آخر أصل ومسار وحكم تعتيم، 64 تبويبًا و120 ثانية)، ولا يُنسب شيء لتبويب لم يُقرأ قط. |
| 0008 | `0008-the-shape-gate-is-a-switch.md` | The shape's gate is a switch, not a baked-in decision | `proposed` | بوابة الشكل خيار صريح `ShapeGate` (`option1` افتراضيًا) بدل قرار مدفون في الكود، فيصبح تغييرُه قلب مفتاح لا إعادة كتابة. |

---

## 2. المسودات في `docs/audit/` ومقابلها

كل المسودات أدناه مرقّمة بـ`ADR-xx` وهي **ليست** سجلات canonical. الفهرسة تبيّن أيًّا منها يقابله ملف في `docs/adr/` وأيُّها لا يقابله شيء بعد.

| مسودة | المصدر | الموضوع | المقابل canonical | حالة المسودة |
|---|---|---|---|---|
| ADR-01 | `docs/audit/05-architecture-analysis.md` §4 | One source of truth for the wire protocol | **مسودة بلا سجل canonical** | «Decision (recommended)» — مقترح |
| ADR-02 | `docs/audit/05-architecture-analysis.md` §4 | Vault service: composition over inheritance | **مسودة بلا سجل canonical** | «Decision (recommended)» — مقترح |
| ADR-03 | `docs/audit/05-architecture-analysis.md` §4 | Bundle injected page scripts at build time | **مسودة بلا سجل canonical** | «Decision (recommended)» — مؤجَّل حتى تقرر تذكرة wayfinder |
| ADR-04 | `docs/audit/05-architecture-analysis.md` §4 | Split `ExtensionBridge` | **مسودة بلا سجل canonical** | «Decision (recommended)» — مقترح |
| ADR-05 | `docs/audit/05-architecture-analysis.md` §4 | Router is a composition root, not a library module | **مسودة بلا سجل canonical** | «Decision (recommended)» — منفَّذ (`106e721`)، لكن بلا ملف canonical |
| ADR-06 | `docs/audit/10-decision-records.md` | `browser_evaluate` is gated by the site's effective safety action | **مسودة بلا سجل canonical** | Accepted, 2026-10-27, owner decision |
| ADR-07 | `docs/audit/10-decision-records.md` | The per-call shield and persisted tab locks supersede the tab-control-lock spec | **مسودة بلا سجل canonical** | Accepted, 2026-10-27 (يُلغي `specs/tab-control-lock/spec.md`) |
| ADR-08 | `docs/audit/10-decision-records.md` | Locks live until the owning session ends; the extension is the sole authority | **مسودة بلا سجل canonical** | Accepted, 2026-10-27, owner decision |
| ADR-09 | `docs/audit/10-decision-records.md` | Keep the inspection output format; the server instruction guards page-derived text | **مسودة بلا سجل canonical** | Accepted, 2026-10-27, owner decision |
| ADR-10 | `docs/audit/10-decision-records.md` | Add a secret rotation command | **مسودة بلا سجل canonical** | Accepted, 2026-10-27، منفَّذ في `0a3cb8b` |
| ADR-11 | `docs/audit/10-decision-records.md` | Exception to Constitution Art 11: two code-graph tools | **مسودة بلا سجل canonical** | Accepted, 2026-10-27، استثناء مسجَّل |

**لماذا كل المسودات بلا مقابل canonical.** الأرقام المتقاربة ليست موضوعًا متقاربًا: السجلات الـcanonical الثمانية كلها تخص مواصفات الذاكرة والخريطة (003 / 004 / 007)، بينما المسودات الأحد عشر تخص البروتوكول والخزنة والـrouter والأقفال والتقييم وتنسيق الإخراج وتدوير الأسرار وأدوات رسم الكود. **لا يوجد موضوع واحد مشترك**، فالتصادم كان تصادم أرقام لا تصادم محتوى. ولهذا السبب لم يُنقل أي محتوى: الترقية تعني إنشاء ملف canonical جديد، لا إعادة ترقيم الملفات القائمة.

---

## 3. القاعدة التي تحسم التصادم من الآن

السجلات canonical توجد **فقط** داخل `docs/adr/`، باسم ملف `docs/adr/NNNN-<slug>.md` — أربعة أرقام موحّدة الصيغة، ثم شرطة، ثم slug قصير. المسودات الموجودة في `docs/audit/` تبقى **مقترحات** إلى أن تُرقّى بملف في `docs/adr/`؛ والترقية لا تعني نقل نص، بل تعني كتابة السجل في مكانه الصحيح مع حالته ودليله. وأي مرجع خلفي — في الكود أو في المستندات أو في رسالة commit — يجب أن يذكر **اسم الملف بالضبط** حتى يصبح قابلًا للبحث: اكتب `docs/adr/0006-the-counter-outside-the-anonymity-gate.md`، ولا تكتب «ADR-06» ولا «ADR 6». الرقم وحده لم يعد معرّفًا فريدًا بعد اليوم.

**تسلسل الترقية المقترح** (قرار المالك، لم يُنفَّذ): نبدأ بـADR-10 وADR-06 لأنهما قراران مقبولة ومطبَّقان في كود قائم، ثم ADR-08 وADR-09 وADR-07 وADR-11، ثم مسودات `05` الخمس إن رُقيت. عند الترقية يُختار الرقم التالي المتاح في `docs/adr/` (بعد `0008`، أي `0009` فما فوق)، لا الرقم القديم `ADR-xx`.

---

## 4. ملاحظات على الاستخدام

- **ما ورد في `docs/audit/04-duplication-register.md`.** المدخلان B3 وB5 كانا يشيران إلى «ADR-01» و«ADR-03» بلا توضيح، وكانا يقصدان مسودتي `docs/audit/05-architecture-analysis.md`. حُدِّثا يوم 2026-10-31 ليشيرا إلى المسودة وملفها صراحةً.
- **ما ورد في `docs/audit/06-remediation-phases.md` و`docs/audit/07-wayfinder/wayfinder-map.md` و`docs/audit/09-feature-architecture-review.md`.** كلها تشير إلى نفس سلسلة المسودات `ADR-01`–`ADR-11`، ولم تُعدَّل لأن تعديلها خارج نطاق هذا الفهرس. المرجع هنا كافٍ للتمييز.
- **صيغة العناوين.** أعمدة `Title` و`Subject` في الجدول الأول تنقل العناوين الأصلية كما هي في ملفات `docs/adr/`؛ والملفات نفسها بالإنجليزية. الترجمة العربية مختصرة ومقصدها الفهرسة فقط، ولا تُغني عن النص الأصلي عند المراجعة.
