# تقرير مقارنة Playwright MCP وBrowser Controller على the-internet.herokuapp.com

تاريخ التنفيذ: 23 أكتوبر 2026 (Africa/Cairo)
المشروع محل التوصيات: real-browser-mcp — الفحص قرائي فقط، ولم أعدّل كود المشروع.

## الخلاصة

- فتحت وفحصت **51/51 صفحة فريدة** بكل أداة. في الجولة المقاسة رجعت الصفحات كلها HTTP 200، ولم يظهر فشل تنقّل من أي MCP.
- في جولة فتح الصفحة ثم قراءة metadata صغيرة، كان متوسط الزمن **862ms مع Playwright** مقابل **615ms مع Browser Controller**؛ والـp50 **782ms مقابل 534ms**. Browser Controller كان أقل في هذه الجولة بحوالي **28.7% إجماليًا**، لكن دي جولة واحدة، والصفحات اتفتحت في جلستين مختلفتين مع cache/network مختلفين؛ مش حكم نهائي على سرعة المحرك.
- التوكينات الحقيقية **غير متاحة من MCPs**. كبديل موضّح بوضوح: حجم payload بالحروف كان **102,630 حرفًا لـPlaywright** و**43,452 لـBrowser Controller** (حوالي **57.7% أقل** للأداة الثانية في هذا البروتوكول). الحروف ليست تحويلًا دقيقًا إلى tokens.
- اختبرت تفاعلات ممثلة، لكن **مش كل تفاعل خاص بكل صفحة اكتمل**. بعض محاولات التفاعل اتعطلت بسبب محددات اخترتها غلط، أو نافذة Chrome على تبويب الاختبار الحقيقي؛ التفاصيل تحت.

## طريقة القياس

- استخدمت Playwright MCP في جلسة معزولة، وBrowser Controller MCP في تبويب Chrome مؤقت أنشأته لهذا الاختبار. باقي تبويبات Chrome لم ألمسها.
- لكل مسار في القياس: استدعاء تنقّل ثم استدعاء قراءة DOM موحّدة نسبيًا (العنوان، أول heading، عدد controls/links/images، حالة HTTP المتاحة). كل أداة نفذت **102 استدعاء MCP** في هذه الجولة: 51 تنقّل + 51 قراءة.
- الأرقام الزمنية لكل صفحة تشمل وقت استدعاء التنقّل والقراءة؛ ليست زمن تنزيل الشبكة وحده. p50 وp95 هنا عبر **مسارات مختلفة**، مش تكرارات لنفس الصفحة.
- أعدت بعض الصفحات لاحقًا للتحقق من التفاعلات؛ جدول الـ51 يعرض الجولة المنفصلة المقاسة، لا مجموع الإعادات.
- سجل الحروف يجمع أطوال arguments ونتائج MCP الخام، ويتضمن wrappers/أصداء كود Playwright. لا أملك usage meter للـLLM tokenization.

## ملخص الأرقام

| القياس | Playwright MCP | Browser Controller MCP |
|---|---:|---:|
| صفحات فريدة في الجولة | 51 | 51 |
| HTTP 200 | 51/51 | 51/51 |
| أخطاء تنقّل من الأداة | 0 | 0 |
| إجمالي زمن التنقّل + قراءة DOM | 43,987ms | 31,376ms |
| المتوسط | 862ms | 615ms |
| p50 عبر الصفحات | 782ms | 534ms |
| p95 عبر الصفحات | 1113ms | 949ms |
| أطول صفحة | 1288ms | 1050ms |
| حروف arguments | 25,845 | 26,151 |
| حروف النتائج | 76,785 | 17,301 |
| مجموع الحروف (proxy فقط) | 102,630 | 43,452 |

## نتائج التفاعلات الممثلة

الأزمنة التالية تشمل التنقّل والتفاعل/الانتظار لكل حالة. تنفيذ Playwright كان داخل script batch، بينما Browser Controller استُخدم بأدوات متتابعة؛ لذلك دي **ملاحظات workflow** وليست مقارنة عادلة لزمن المحرك وحده.

| الحالة | Playwright ms | Browser Controller ms | نتيجة Playwright | نتيجة Browser Controller |
|---|---:|---:|---|---|
| Add/Remove Elements | 249 | 1764 | Add Element ثم Delete؛ عاد العدد إلى صفر | إضافة ثم حذف؛ الخطوتان بلا خطأ |
| Checkboxes | 194 | 1175 | تم اختيار checkbox والتحقق من checked=true | النقر اكتمل بلا خطأ؛ الحالة لم تُقرأ بعده |
| Dropdown | 175 | 542 | تم اختيار القيمة 1 | تعبئة الاختيار اكتملت بلا خطأ |
| Drag and Drop | 275 | 896 | تم السحب؛ ظهر A=B بعده | استدعاء dragTo اكتمل بلا خطأ |
| Dynamic Controls | 3545 | 4105 | Remove ثم Add نجحا | Remove + انتظار النص + Add نجحوا |
| Dynamic Loading | 5766 | 6277 | ظهر النص المخفي بعد Start | ظهر الهدف بعد Start |
| Horizontal Slider | 172 | 643 | القيمة أصبحت 3.5 | تعبئة range اكتملت بلا خطأ |

نتائج إضافية:

- Playwright: Basic Auth وDigest Auth نجحا بالبيانات التي زوّدتني بها؛ Form Authentication نجح معه login ثم logout.
- Playwright: صفحة JavaScript Error أنتجت page error واحدًا، وهو سلوك متوقع من صفحة الاختبار نفسها.
- Playwright: صفحة Status Codes أعادت 200 و301 و404 و500 للمسارات المقابلة؛ هذه استجابات مقصودة وليست أخطاء MCP.
- Browser Controller: Context Menu/dialog اتعاملت معه عبر أداة dialog المخصصة قبل توقف التفاعلات.
- Broken Images: الصفحة بها 4 صور، منها صورتان مكسورتان عمدًا؛ الصفحة نفسها رجعت 200.
- File Upload لم أصل لتأكيد نجاح submission. Playwright حدّد الملف محليًا لكن صفحة التأكيد لم تظهر. Browser Controller قبِل مسار الملف بعد تصحيح شكل الإدخال، ثم ظهر Chrome-level modal منع النقر على Submit. ما اعتبرتش ده عيبًا في real-browser-mcp.
- File Download لم يتأكد تنزيله. Secure File Download اتفحصت صفحته فقط؛ ما جرّبتش credentials غير معطاة. في Two-Factor Login لم أخمّن OTP.
- Entry Ad وExit Intent لم يُظهرا modal في هذه الجلسة. Multiple Windows: الصفحة والرابط اشتغلوا، لكن إنشاء popup جديد لم يتأكد.

## أخطاء/قيود التفاعل

- **لا توجد أخطاء تنقّل في الـ51 صفحة** بأي أداة.
- بعض أخطاء Playwright كانت من test selectors غير مناسبة، وليست من MCP: مثل button بدل .button في Challenging DOM، وfigure img غير الفريد، واستخدام ID قديم للـmultiple select. صححت/تحققت من عدة حالات مباشرة بأدوات MCP.
- أثناء سلسلة Browser Controller التي شملت file input وتسجيل دخول تجريبي ظهرت حالة Chrome modal overlay، وبعدها بعض الأفعال رجّعت INPUT_BLOCKED. لم أحاول إغلاق نافذة Chrome أو تجاوزها. أغلقت فقط تبويب الاختبار الذي أنشأته، وتركت كل التبويبات الأخرى دون تغيير.
- تجربة الملف في Playwright كانت باستخدام محتوى مؤقت غير حساس؛ حذفت ملف fixture المحلي بعد الاختبار.

## تحسينات مقترحة لـreal-browser-mcp

1. **الأولوية الأولى — Benchmark عادل ومتكرر:** أضف runner يعيد كل سيناريو 3–5 مرات بترتيب عشوائي، يسخّن الأداتين بالتساوي، ويقيس navigation وDOM-read وaction منفصلين. الجولة الحالية اتجاهية فقط.
2. **الأولوية الأولى — اجمع الخطوات في round-trip واحد:** المشروع يحتوي أصلًا browser_batch بحد أقصى 50 خطوة وينفّذها بالتتابع؛ استخدمه في المقارنات وسير العمل بدل استدعاء MCP منفصل لكل خطوة. قارن batch-to-batch مع الأدوات المنافسة.
3. **الأولوية الثانية — حافظ على المخرجات المختصرة:** browser_navigate لا يضيف snapshot إلا عند طلبه صراحة، وbrowser_snapshot له حد أحرف. في fast mode، أرجع العنوان/الـheading/postcondition فقط، ولا تطلب snapshot أو screenshot بعد كل action.
4. **الأولوية الثانية — لا تعمل observation زائد:** في mcp-server/src/tools/action-support.ts، observe: diff وexpect يطلبان snapshot قبل/بعد الفعل. استخدم postcondition على خطوة نهائية أو خطوات عالية المخاطر، لا على كل خطوة داخل batch، مع الإبقاء على safety checks.
5. **الأولوية الثالثة — instrumentation مفيد:** سجّل duration_ms ووقت target resolution/CDP/safety/observation وحجم input/output لكل tool. اربط قياس tokens الحقيقي ببيانات usage من العميل؛ لا تستنتجه من الأحرف.
6. **الأولوية الثالثة — اختبارات modal/file chooser:** أضف اختبارات regression تميز JS alert عن Chrome/file-picker/security modal. عند وجود Chrome-level modal، الأفضل إيقاف السلسلة برسالة واضحة وعدم retry أو dismiss تلقائي.

هذه الأولويات توصيات من الجولة ومراجعة سطح الأدوات؛ لم أغيّر implementation أو أشغّل regression suite لأن المطلوب كان تقرير مقارنة، لا تعديل الكود.

## سجل الـ51 مسارًا

زمن الصفحة بالمللي ثانية. HTTP هو Playwright / Browser Controller.

| # | الصفحة | المسار | PW ms | BC ms | HTTP |
|---:|---|---|---:|---:|---:|
| 1 | A/B Testing | `/abtest` | 792 | 556 | 200/200 |
| 2 | Add/Remove Elements | `/add_remove_elements/` | 799 | 525 | 200/200 |
| 3 | Basic Auth | `/basic_auth` | 944 | 682 | 200/200 |
| 4 | Broken Images | `/broken_images` | 944 | 613 | 200/200 |
| 5 | Canvas | `/canvas` | 769 | 528 | 200/200 |
| 6 | Challenging DOM | `/challenging_dom` | 766 | 865 | 200/200 |
| 7 | Checkboxes | `/checkboxes` | 763 | 530 | 200/200 |
| 8 | Context Menu | `/context_menu` | 1100 | 511 | 200/200 |
| 9 | Digest Authentication | `/digest_auth` | 926 | 672 | 200/200 |
| 10 | Disappearing Elements | `/disappearing_elements` | 774 | 527 | 200/200 |
| 11 | Drag and Drop | `/drag_and_drop` | 778 | 534 | 200/200 |
| 12 | Dropdown | `/dropdown` | 771 | 548 | 200/200 |
| 13 | Dynamic Content | `/dynamic_content` | 769 | 518 | 200/200 |
| 14 | Dynamic Controls | `/dynamic_controls` | 780 | 839 | 200/200 |
| 15 | Dynamic Loading | `/dynamic_loading` | 776 | 533 | 200/200 |
| 16 | Entry Ad | `/entry_ad` | 1105 | 501 | 200/200 |
| 17 | Exit Intent | `/exit_intent` | 779 | 530 | 200/200 |
| 18 | File Download | `/download` | 920 | 631 | 200/200 |
| 19 | File Upload | `/upload` | 768 | 510 | 200/200 |
| 20 | Floating Menu | `/floating_menu` | 927 | 906 | 200/200 |
| 21 | Forgot Password | `/forgot_password` | 780 | 496 | 200/200 |
| 22 | Form Authentication | `/login` | 782 | 1050 | 200/200 |
| 23 | Frames | `/frames` | 768 | 529 | 200/200 |
| 24 | Geolocation | `/geolocation` | 1052 | 525 | 200/200 |
| 25 | Horizontal Slider | `/horizontal_slider` | 861 | 518 | 200/200 |
| 26 | Hovers | `/hovers` | 775 | 542 | 200/200 |
| 27 | Infinite Scroll | `/infinite_scroll` | 1273 | 949 | 200/200 |
| 28 | Inputs | `/inputs` | 770 | 533 | 200/200 |
| 29 | JQuery UI Menus | `/jqueryui/menu` | 933 | 631 | 200/200 |
| 30 | JavaScript Alerts | `/javascript_alerts` | 782 | 815 | 200/200 |
| 31 | JavaScript onload event error | `/javascript_error` | 757 | 527 | 200/200 |
| 32 | Key Presses | `/key_presses` | 1011 | 535 | 200/200 |
| 33 | Large & Deep DOM | `/large` | 1288 | 951 | 200/200 |
| 34 | Large Form | `/large_form` | 778 | 512 | 200/200 |
| 35 | Multiple Select Dropdown | `/multiple_dropdown` | 777 | 534 | 200/200 |
| 36 | Multiple Windows | `/windows` | 770 | 524 | 200/200 |
| 37 | Nested Frames | `/nested_frames` | 1113 | 823 | 200/200 |
| 38 | Notification Messages | `/notification_message` | 936 | 925 | 200/200 |
| 39 | Radio Buttons | `/radio_buttons` | 770 | 541 | 200/200 |
| 40 | Read-only Inputs | `/readonly` | 1034 | 523 | 200/200 |
| 41 | Redirect Link | `/redirector` | 759 | 505 | 200/200 |
| 42 | Secure File Download | `/download_secure` | 930 | 666 | 200/200 |
| 43 | Shadow DOM | `/shadowdom` | 785 | 517 | 200/200 |
| 44 | Shifting Content | `/shifting_content` | 779 | 579 | 200/200 |
| 45 | Slow Resources | `/slow` | 786 | 522 | 200/200 |
| 46 | Sortable Data Tables | `/tables` | 810 | 799 | 200/200 |
| 47 | Status Codes | `/status_codes` | 779 | 538 | 200/200 |
| 48 | Subdirectories | `/subdirectories` | 1033 | 515 | 200/200 |
| 49 | Two-Factor Login | `/two_factor` | 761 | 525 | 200/200 |
| 50 | Typos | `/typos` | 760 | 526 | 200/200 |
| 51 | WYSIWYG Editor | `/tinymce` | 845 | 642 | 200/200 |

