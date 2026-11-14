---
description: "Dependency-ordered tasks for profile-scoped site knowledge"
---

# المهام: ملف معرفة منظم لكل موقع

**Input**: [spec.md](spec.md)، [plan.md](plan.md)، [research.md](research.md)، [data-model.md](data-model.md)، [contracts/site-knowledge.md](contracts/site-knowledge.md)، [quickstart.md](quickstart.md)، [checklists/security.md](checklists/security.md).

**الحالة**: قائمة للمراجعة؛ لا تفوّض التنفيذ أو النشر أو استخدام بيانات فعلية. الأسماء الجديدة للملفات والأدوات أدناه مسارات تنفيذ مقترحة، وليست ملفات قائمة.

**الترقيم**: `[P]` تعني إمكانية التوازي فقط بعد اكتمال المتطلبات السابقة وبملفات مستقلة؛ `[USn]` تربط المهمة بقصة المستخدم. أرقام المهام تتبع ترتيب التنفيذ، وحالات الإنجاز السابقة محفوظة. لا يلزم استخدام وكلاء متوازيين.

**اختبارات**: مطلوبة صراحةً بالمواصفة والخطة؛ تُكتب اختبارات السلوك أولًا وتُشغّل لرؤية الفشل المتوقع عندما يكون ذلك عمليًا. لا تُستخدم أسرار أو سجلات مستخدم حقيقية. T030 وT031 عمل قائم ومكتمل قبل استكمال قائمة الاختبارات؛ علامتا الإنجاز لا تثبتان أن TDD نُفذ تاريخيًا ولا تُكملان اختبارات T025–T029. قبل مواصلة تنفيذ US1 تُشغّل اختبارات الوحدة الحالية لهما، وكل مكوّن US1 غير مكتمل يتبع الاختبار أولًا.

## المرحلة 1: التجهيز وحدود التنفيذ

- [X] T001 افحص `AGENTS.md` و`git status` والـ checkout وملفات `specs/008-site-knowledge/plan.md` و`specs/008-site-knowledge/spec.md` واحفظ خط أساس للتغييرات دون تعديل إعدادات أو بيانات المستخدم.
- [X] T002 راجع `mcp-server/src/memory/scope.ts` و`mcp-server/src/bridge-connections.ts` و`SECURITY.md` لتوثيق أن اختيار profile فصل توجيه لعملاء مقترنين موثوقين وليس ACL ضد حامل IPC token.
- [X] T003 راجع كل بنود `specs/008-site-knowledge/checklists/security.md` قبل اعتماد الخطة؛ سجّل الحكم عليها، وعدّل المواصفة أو الخطة لأي فجوة مؤثرة في الخصوصية أو الصلاحيات أو الموافقة، ولا تعتبر بندًا غير محسوم موافقة.
- [ ] T004 راجع `mcp-server/src/tools/action-support.ts` و`mcp-server/src/register-tools.ts` وعقد `specs/008-site-knowledge/contracts/site-knowledge.md` لتحديد عميل يدعم إظهار المعاينة الكاملة وقناة تأكيد المالك؛ لا تعتبر إعلان elicitation دليلًا على عرض المحتوى كاملًا.
- [X] T005 أنشئ بيئة اختبار معزولة وفق `specs/008-site-knowledge/quickstart.md` تستخدم fixtures ومنافذ وstate directory مؤقتة، وتحقق من أن أوامر `package.json` لا تمس daemon أو Chrome profile المستخدم.
- [ ] T006 بعد توفر مسار الموافقة الفعلي وقبل تمكين الحفظ الحقيقي اختبر واجهة المالك المرشحة ببيانات اصطناعية تعرض النص الكامل والنطاق والتحذيرات وصفحات متعددة، بما فيها الاقتطاع والتغيير والانقطاع؛ وثّق العميل وإصداره والنتيجة في `specs/008-site-knowledge/plan.md`. لا تعتبر capability أو عداد الصفحات دليل عرض؛ إن تعذر إثبات مسار مناسب أوقف الكتابة المعنية.
- [ ] T007 سجّل في `specs/008-site-knowledge/plan.md` نتيجة بوابة P0 وقبول المالك الصريح للخطر المتبقي للنص الحر؛ إن لم يثبت عرض كامل المحتوى أو لم يقبل المالك الخطر، أوقف تمكين الكتابة ولا تعتبر elapsed time موافقة.

**Checkpoint للتطوير**: أدوات الاختبار معزولة والمتطلبات الأمنية موثقة؛ يمكن تنفيذ الأساس والقصص ببيانات اصطناعية. **بوابة الاستخدام الحقيقي مستقلة**: لا تُفتح الكتابة الفعلية قبل T006 وT007.

## المرحلة 2: الأساس المشترك — يمنع بدء قصص المستخدم

### اختبارات الأساس أولًا

- [X] T008 [P] اكتب في `tests/site-knowledge-scope.test.ts` اختبارات رفض profile `default` أو المكرر وتغيّر connection/session/origin، وincognito وvault protected/unknown، وإثبات عزل profileين على origin واحد دون ادعاء عزل العميل المحلي العدائي.
- [X] T009 [P] اكتب في `tests/site-knowledge-record.test.ts` اختبارات schema وإصدارات مستقبلية وحجم UTF-8 ومحارف عربية وروابط غير آمنة وحقول غير معروفة ورفض علامات الأسرار الاصطناعية دون echo.
- [X] T010 [P] اكتب في `tests/site-knowledge-store.test.ts` اختبارات تخزين معزول وحصص الأحجام وrace/revision وفشل temp/rename/fsync و`OUTCOME_UNKNOWN` وعدم تغيير ملفات 003/004 أو استبدال إصدار غير مدعوم.
- [X] T011 [P] اكتب في `tests/site-knowledge-policy.test.ts` اختبارات التعطيل الافتراضي وenable/disable/exclude/include وتغيّر generation ومنع القراءة أو الكتابة عند تعطيل/استبعاد الذاكرة الحالية؛ تُختبر موافقة المالك وإبطال drafts الفعلي بعد وجود واجهتهما في T036.
- [X] T012 قبل تنفيذ كل مكون من مكونات الأساس، اكتب وشغّل اختبارات سلوكه المستقلة وسجّل خط أساس فعليًا؛ يجوز تنفيذ المكونات المستقلة تباعًا دون انتظار اختبارات مكونات لم تبدأ. قبل checkpoint الأساس شغّل الاختبارات الأربعة معًا بعد build معزول؛ لا تعتبر فشل الاستيراد وحده دليل regression.

### التنفيذ الأساسي

- [X] T013 أنشئ `mcp-server/src/memory/knowledge-record.ts` لتعريف `KnowledgeFile` مع `schemaVersion: 1`، `browserId`، canonical HTTP(S) `origin`، `revision` عدد صحيح متزايد، `updatedAt` UTC و`entries` محدودة؛ ارفض مفاتيح وإصدارات مجهولة دون استبدالها.
- [X] T014 أنشئ `mcp-server/src/memory/knowledge-entry.ts` لحقول `id` العشوائي الثابت و`category`: `site`, `role`, `function`, `problem`, `change`, `test`، و`subject` قصير قابل للبحث و`body`؛ طبّق حد العنصر الإجمالي `2 KiB UTF-8` وارفض account IDs وأسماء الأشخاص والأسرار المكتشفة وURLs ذات userinfo أو query/fragment. الكشف عن النص الحر best-effort؛ تبقى البيانات الخاصة محظورة، وقد قبل المالك الخطر المتبقي بعد مراجعته.
- [X] T015 أضف في `mcp-server/src/memory/knowledge-entry.ts` القيم `source`: `owner_statement`, `direct_observation`, `historical_record`, `task_summary` و`attestation: corroborated | declared`؛ اسمح بمرجع اختياري آمن دون فتحه تلقائيًا، ولا تصنف ادعاء الوكيل دليلًا مستقلًا. اختبار الربط بمصدر الدليل الفعلي في T033.
- [X] T016 أضف في `mcp-server/src/memory/knowledge-entry.ts` القيود `observedAt` و`lastVerifiedAt`: UTC أو null، و`createdAt` و`updatedAt`: UTC يسجلهما النظام؛ امنع استنتاج تاريخ الملاحظة من وقت الإدخال. اختبار مسار التعديل والنظام الفعلي في T033.
- [X] T017 أضف في `mcp-server/src/memory/knowledge-entry.ts` القيم `status`: `unverified`, `verified_at_time`, `historical`, `needs_recheck`؛ و`execution`: `planned`, `performed`, `unknown`, `not_applicable`؛ و`testOutcome`: `not_run`, `passed`, `failed`, `unknown`, `not_applicable`؛ و`relatedIds` ضمن نفس scope فقط، مع اشتراط دليل ووقت تحقق لنتيجة اختبار مثبتة. تحقق موثوقية الدليل في T033.
- [X] T018 أنشئ `mcp-server/src/memory/knowledge-scope.ts` لاشتقاق scope من session/connection وtab context موثوق بالاستفادة من `mcp-server/src/memory/scope.ts`. رفض profile/origin من معاملات الوكيل وربط المصادر الفعلية يُختبر في T033.
- [X] T019 أنشئ `mcp-server/src/memory/knowledge-policy.ts` بسياسة opt-in افتراضيًا وعمليات enable/disable/exclude/include مع إعادة فحص policy الذاكرة القائمة وتغيير generation عند التعطيل أو الاستبعاد؛ يُربط إبطال المقترحات الفعلي بعد إنشاء المسودات في T036.
- [X] T020 أنشئ `mcp-server/src/memory/knowledge-store.ts` في namespace مستقل لكل `(browserId, origin)` بأسماء hash لا تُعامل كتشفير؛ طبّق owner-only والتحقق من symlinks ومطابقة هوية الملف دون لمس سجلات 003/004.
- [X] T021 أكمل `mcp-server/src/memory/knowledge-store.ts` بحدود `128 KiB` و`100 عنصر` للملف، و`500 ملف لكل profile` و`32 MiB إجمالي`، ورفض الكتابة عند بلوغ الحد دون حذف قديم تلقائيًا.
- [X] T022 أضف في `mcp-server/src/memory/knowledge-store.ts` كاتب daemon واحدًا وتسلسلًا لكل scope وفحص revision وواجهة تحقق إلزامية قبل atomic replace، وتمييز فشل ما قبل rename من عدم تأكيد fsync بعده؛ اربط الواجهة بمصدر policy/delete الموثوق عند بناء الخدمة في T034، ولا تدّعِ transaction عبر ملفات.
- [X] T023 عرّف أخطاء الأساس اللازمة في `mcp-server/src/core/error-codes.ts` وأضف اختبارات رسائل لا تطبع محتوى مرفوضًا في `tests/site-knowledge-record.test.ts`؛ استخدم السجل الحالي بدل aliases أو رسائل خام. إضافة أو ربط أخطاء الخدمة النهائية جزء من T033.
- [X] T024 شغّل الاختبارات الأربعة في `tests/site-knowledge-scope.test.ts` و`tests/site-knowledge-record.test.ts` و`tests/site-knowledge-store.test.ts` و`tests/site-knowledge-policy.test.ts` وتحقق من نجاح سلوك الأساس وحدود الكشف الموثقة؛ التحقق المتكامل للخصوصية والموافقة ضمن T033–T036 قبل إتاحة الميزة.

**Checkpoint**: التخزين والنطاق والسياسة قابلة للاختبار في عزلة، والكتابة غير مكشوفة للوكيل بعد.

## المرحلة 3: US1 — حفظ ومراجعة معرفة عامة (Priority: P1، أساس MVP)

**الهدف**: حفظ وتعديل وحذف وتصدير معرفة عامة لموقع/profile واحد بعد مراجعة وموافقة محددتين، مع قراءة أساسية للسجل.  
**الاختبار المستقل**: أضف ثلاث معلومات اصطناعية، اختر اثنتين ووافق؛ اقرأ وعدّل واحذف واحدة، واختبر الإلغاء والـ profile الآخر وعدم وجود بيانات فعلية.

### الاختبارات أولًا

- [ ] T025 [P] [US1] اكتب في `tests/site-knowledge-approval.test.ts` اختبارات prepare/preview/confirm/cancel، واختيار عنصرين من ثلاثة، والتأكيد الكامل، ورفض غياب elicitation أو اقتطاع العرض أو الرفض أو timeout أو replay دون كتابة.
- [ ] T026 [P] [US1] اكتب في `tests/site-knowledge-races.test.ts` اختبارات تغيّر المحتوى/selection/profile/origin/connection/revision بعد المعاينة، وسباقات delete/disable، وفشل الدفعة دون partial commit.
- [ ] T027 [P] [US1] اكتب في `tests/site-knowledge-privacy.test.ts` اختبارات علامات اصطناعية معروفة لكلمات مرور وtokens وبيانات دفع ومعرّفات حساب في المعاملات والمصدر والروابط والأخطاء والـ logs والـ export؛ تحقق من رفض ما يكتشفه الفاحص وعدم إظهاره، ولا تفترض اكتشاف كل معرّف أو نص حر.
- [ ] T028 [P] [US1] اكتب في `tests/site-knowledge-record.test.ts` و`tests/site-knowledge-integration.test.ts` اختبارات schema لعلاقات المواقع، وقراءة وكيل مصرح به لملفه دون elicitation إضافي، ورفض تغيير scope إلى profile آخر من مدخل الوكيل، ومرجع A→B بلا جلب بيانات B أو توسيع الإذن؛ أثبت أن session read-only يسمح بالقراءة ويرفض الكتابة، وارفض tab غير مملوك، وتحقق من توافق الذاكرة الحالية.
- [ ] T029 [US1] شغّل `tests/site-knowledge-draft.test.ts` و`tests/site-knowledge-approval.test.ts` لتسجيل نتيجة التحقق الحالية لـ T030/T031، واكتب وشغّل اختبارات كل مكوّن US1 غير مكتمل قبل تنفيذه وسجّل الفشل المتوقع؛ قبل checkpoint شغّل اختبارات T025–T028 معًا في البيئة المعزولة. لا تدّعِ ترتيب TDD تاريخيًا للمكونات المكتملة ولا تعتبر اختبار draft منفردًا بديلًا عن اختبارات الربط والموافقة الفعلية.

### التنفيذ والتكامل

- [X] T030 [US1] أنشئ `mcp-server/src/memory/knowledge-draft.ts` لـ draft ذاكرة فقط: id عشوائي، `createdAt`, `expiresAt` بحد `5 دقائق`، عملية واختيار مرتب، scope مشتق وrevision وجيل policy/delete وcanonical payload؛ حد الدفعة `8 عناصر` والمعاينة الكاملة `4 KiB`، ولا logs/disk للمسودات.
- [X] T031 [US1] أضف في `mcp-server/src/memory/knowledge-draft.ts` ربط `ApprovalBinding` بـ session وconnection وprofile وorigin وoperation وrevision وجيل policy/delete وexpiry وdigest، والاستهلاك مرة واحدة وآليات الإبطال عند الإلغاء وانتهاء الجلسة؛ ربط أحداث الانقطاع وrestart الفعلية يُختبر في T036. لا تعتبر digest إثباتًا ضد عميل يملك token.
- [ ] T032 [US1] أنشئ `mcp-server/src/memory/knowledge-service.ts` لتنفيذ prepare/validate/preview/confirm/cancel وadd/edit/delete/export/read، وحدّث `knowledge-record.ts` و`knowledge-store.ts` لحفظ والتحقق من `relatedSites` المحدودة ضمن KnowledgeFile؛ أعد اشتقاق scope وافحص revision والسياسة تحت التسلسل، واقبل المجموعة كاملة أو ارفضها بلا partial write.
- [ ] T033 [US1] اربط الخدمة بمصدر session/connection/tab الموثوق و`createKnowledgeProposal`؛ لا تقبل profile أو origin أو system IDs/timestamps من الوكيل، ولا تجعل owner_statement أو corroborated أو نتيجة اختبار مؤكدة من ادعائه. اختبر الإدخال والتعديل والمصدر وتوقيتات النظام ورفض evidence غير الموثق عبر MCP الفعلي، قبل إتاحة الأدوات.
- [ ] T034 [US1] اربط حارس commit الإلزامي في `mcp-server/src/memory/knowledge-store.ts` بحالة scope والجلسة وجيل policy/delete الفعلية داخل تسلسل daemon؛ اختبر تغيير كل منها قبل الاستبدال وفشل التحقق دون كتابة، ولا تعتمد على callback يقدمه الوكيل.
- [ ] T035 [US1] بعد إنشاء المسودات والخدمة، اربط `scripts/memory.mjs` وdaemon بواجهة المالك المحلية التفاعلية في `specs/008-site-knowledge/contracts/site-knowledge.md` لعمليات enable/disable/exclude/include، مع عرض النطاق والتأكيد ورفض الانقطاع والوضع غير التفاعلي؛ اختبر التمكين والإبطال وإعادة التشغيل، دون قبول تأكيد الوكيل أو تمكين استخدام حقيقي قبل T006.
- [ ] T036 [US1] اختبر موافقة المالك الفعلية وإبطال المسودات عند التعطيل أو الاستبعاد، وغياب الموافقة والانقطاع وrestart ورفض تغيير السياسة أو تنفيذ draft قديم؛ اختبر مسار IPC وCLI مع بيانات اصطناعية.
- [ ] T037 [US1] أضف في `mcp-server/src/memory/knowledge-service.ts` idempotency محدودة تربط request ID بالمحتوى والنطاق والنتيجة، وترفض replay المتعارض؛ بعد restart أو `OUTCOME_UNKNOWN` توجّه لفحص السجل ولا تدّعي exactly-once.
- [ ] T038 [US1] أنشئ `mcp-server/src/tools/site-knowledge-manage.ts` بعقد strict لمعاينة اختيار المستخدم ثم owner elicitation وعرض كامل البيانات والنطاق، مع نزع حقول التأكيد التي يرسلها الوكيل ورفض العميل غير القادر على المعاينة الكاملة أو التأكيد؛ افحص حد 4 KiB بعد تنسيق الرسالة كاملة بعناوينها وتحذيراتها، ولا تعتبر حد payload وحده كافيًا.
- [ ] T039 [US1] أنشئ `mcp-server/src/tools/site-knowledge.ts` لقراءة أساسية tab-scoped دون موافقة قراءة إضافية بعد تحقق profile، مع وسم المحتوى غير الموثوق وإرجاع `relatedSites` الوصفية من ملف origin الحالي فقط، وعدم قبول browserId/origin من معاملات الوكيل أو جلب بيانات origin مرتبط.
- [ ] T040 [US1] اربط `mcp-server/src/tools/registry.ts` و`mcp-server/src/protocol/wire-tools.ts` و`mcp-server/src/daemon.ts` بالخدمة والأدوات الجديدة، مع اشتقاق timeout/idempotency من سجل الأدوات والحفاظ على أسماء وعقود الأدوات القديمة.
- [ ] T041 [US1] حدّث `mcp-server/src/tools/session-mode.ts` و`tests/site-knowledge-integration.test.ts` لتصنيف إدارة المعرفة كعملية كتابة، وإثبات أن read-only وtab isolation لا يتجاوزهما أي مسار أو batch.
- [ ] T042 [US1] قبل تسجيل أي مسار كتابة للاستخدام الفعلي، أضف واختبر في `tests/site-knowledge-approval.test.ts` و`tests/site-knowledge-integration.test.ts` فشلًا مغلقًا افتراضيًا عندما لا توجد واجهة مؤهلة وفق T006، بما في ذلك طلب MCP وIPC وCLI وbatch ومتغيرات البيئة وادعاءات الوكيل. يسمح بحقن موافقة اصطناعية داخل الاختبارات المعزولة فقط؛ لا تُستخدم فحوص الاختبار لإثبات أهلية واجهة الإنتاج.
- [ ] T043 [US1] قبل T044 اكتب وشغّل في `tests/site-knowledge-delete-recovery.test.ts` حالات فشل إنشاء أو دوام سجل الحجب، وفشل كل مخزن وrestart وتزامن الحذف مع approval؛ سجّل الفشل المتوقع عندما يكون عمليًا، ثم أعد التشغيل بعد T044 للتحقق من عدم ظهور المحجوب أو إحياء drafts أو نجاح كاذب.
- [ ] T044 [US1] بعد T043 أضف في `mcp-server/src/memory/admin.ts` و`mcp-server/src/memory/knowledge-service.ts` تنسيق حذف الموقع و`delete --all`: ثبّت سجل حجب دائمًا بلا محتوى وأبطل drafts قبل أي حذف؛ فشل إثبات دوام السجل يمنع الحذف. أعد تحميل الحجب قبل فتح المخازن بعد restart، وأبلغ بالفشل الجزئي، ولا ترفع الحجب قبل إثبات اكتمال التنظيف وتثبيت حالته؛ لا تدّع ذرّية متعددة الملفات.
- [ ] T045 [US1] شغّل اختبارات US1 و`tests/memory-policy-tool.test.ts` و`tests/map-policy-tool.test.ts` و`tests/memory-privacy.test.ts` و`tests/protocol-tool-names.test.ts` في نسخة معزولة، وأصلح أي انحدار دون إضعاف الاختبارات.

**Checkpoint US1**: تتحقق معايير SC-001 وSC-003 وSC-003a وSC-003b وSC-004 وSC-006 وSC-008 وSC-009 ذات الصلة؛ لا يُفعّل حفظ حقيقي إن بقيت بوابة P0 غير مثبتة أو غير معتمدة.

## المرحلة 4: US2 — البحث والأدلة والتعارضات (Priority: P1، يكمل MVP)

**الهدف**: إجابة مقيدة بالنطاق تعرض المصدر والتواريخ والحالة والتعارضات دون تحويل القديم أو المخطط إلى حقيقة حالية.  
**الاختبار المستقل**: حمّل fixtures اصطناعية إلى مخزن الاختبار واقرأ وابحث فيها بعميل profile مصرح دون الاعتماد على تدفق US1 التفاعلي.

### الاختبارات أولًا

- [X] T046 [P] [US2] اكتب في `tests/site-knowledge-search.test.ts` اختبارات بحث عربي وUTF-8، فلاتر category، وسجلات متعارضة ومخططة وفاشلة وغير مثبتة، وإظهار المصدر والتواريخ دون تفسير النص كتعليمات.
- [X] T047 [P] [US2] اكتب في `tests/site-knowledge-pagination.test.ts` اختبارات limits وcursor خاطئ/قديم/مختلف النطاق، وprofileين لنفس origin وعدم تسريب بيانات أو مقاطع من profiles أخرى.
- [ ] T048 [US2] شغّل `tests/site-knowledge-search.test.ts` و`tests/site-knowledge-pagination.test.ts` وتحقق من فشلهما للسلوك غير المنفذ قبل الإضافة.

### التنفيذ

- [ ] T049 [US2] أنشئ `mcp-server/src/memory/knowledge-query.ts` للبحث والترتيب وإبراز الادعاءات المتعارضة مع source/attestation و`observedAt`/`lastVerifiedAt` و`status` وexecution/testOutcome، دون ترقية أحدث ادعاء لحالة حية تلقائيًا.
- [ ] T050 [US2] أكمل `mcp-server/src/tools/site-knowledge.ts` بعقد `action: read | search`، و`query` بحد `160 حرفًا`، وحد صفحة `20 عنصرًا` و`8 KiB`، وcursor opaque مرتبط بالـ scope والفلتر وrevision ويرفض القيم القديمة أو الخاطئة؛ لا يُستخدم البحث لتوسيع origin أو profile.
- [ ] T051 [US2] حدّث `mcp-server/src/memory/knowledge-service.ts` لعرض روابط `relatedIds` داخل scope فقط و`relatedSites` كمرجع وصفي دون قراءة origin الهدف، وتقديم provenance الوكيل بلا دليل كـ `declared` وغير متحقق، وعدم فتح source reference تلقائيًا.
- [ ] T052 [US2] شغّل `tests/site-knowledge-search.test.ts` و`tests/site-knowledge-pagination.test.ts` و`tests/site-knowledge-integration.test.ts` وتحقق من SC-002 وSC-003a والتصفح المحدود.

**Checkpoint US2**: MVP يجمع US1 وUS2؛ يمكن اختبار القراءة والتعارض مستقلًا ببيانات اختبار ثابتة بعد الأساس.

## المرحلة 5: US5 مشتقة — الاستعادة المدارة (FR-012a، SC-007)

**الهدف**: تصدير واستعادة نطاق واحد بعد معاينة وتحذير وموافقة. US5 معرّف تنظيمي مشتق من متطلب الاستعادة، وليست قصة إضافية في spec.md.  
**الاختبار المستقل**: استعد artifact اصطناعيًا لملف موقع/profile بعد حذف عنصر، واختبر التحذير والرفض والموافقة دون استخدام بيانات US1 الفعلية.

### الاختبارات أولًا

- [ ] T053 [P] [US5] اكتب في `tests/site-knowledge-restore.test.ts` اختبارات تحذير إحياء المحذوف، وموافقة/رفض/timeout، ومعاينة متعددة الصفحات كاملة أو رفضها، واستعادة أكثر من 8 عناصر ضمن حد الملف، وصفحة ناقصة أو متغيرة، وانتهاء 30 دقيقة والانقطاع وإعادة التشغيل، وartifact تالف أو مستقبلي أو أكبر من الحد، وعدم تغيير بيانات قبل commit عند الفشل.
- [ ] T054 [P] [US5] اكتب في `tests/site-knowledge-export.test.ts` اختبارات export لنطاق واحد وprofileين، وتحقق من flush وإخراج يتجاوز `65536 bytes` دون JSON مبتور أو تسريب drafts أو secrets.
- [ ] T055 [US5] شغّل `tests/site-knowledge-restore.test.ts` و`tests/site-knowledge-export.test.ts` وتحقق من الفشل المتوقع قبل تنفيذ الواجهة.

### التنفيذ

- [ ] T056 [US5] أنشئ `mcp-server/src/memory/knowledge-backup.ts` و`RestoreDraft` حسب `data-model.md` لتحليل artifact محدود ومتحقق schema/version/scope/permissions وإنتاج معاينة كاملة بصفحات مرتبطة ببصمة واحدة وإقرار مرتب بكل صفحة وصلاحية محدودة؛ ارفض التغيير والانقطاع والحدود الزائدة دون قراءة مسار اعتباطي يحدده الوكيل.
- [ ] T057 [US5] أضف `prepare_restore` إلى `mcp-server/src/tools/site-knowledge-manage.ts` مع تحذير صريح باحتمال استعادة محذوف، وتأكيد مالك مرتبط بكامل المحتوى والنطاق/revision؛ إذا تعذر إثبات عرض جميع الصفحات ترفض الاستعادة.
- [ ] T058 [US5] حدّث `mcp-server/src/memory/knowledge-service.ts` لاستعادة ذرية لملف واحد بعد التأكيد وإعادة التحقق، وإرجاع `OUTCOME_UNKNOWN` عند عدم تأكيد دوام الكتابة، وعدم المساس بمخازن الذاكرة القديمة.
- [ ] T059 [US5] حدّث أو أنشئ owner CLI مناسبًا في `scripts/memory.mjs` لإخراج export كامل مع flush قبل انتهاء العملية، واختيار artifact من المالك، دون كشف profiles أخرى أو نسخ أسرار؛ اختبر الاستعادة من بيانات اصطناعية فقط.
- [ ] T060 [US5] شغّل `tests/site-knowledge-restore.test.ts` و`tests/site-knowledge-export.test.ts` وتحقق من SC-007 وعدم الادعاء بالسيطرة على الاستعادة الخارجية.

## المرحلة 6: US3 — مقترح ملخص المهمة (Priority: P2)

**الهدف**: تكوين مقترح غير محفوظ يميّز المنفذ من المخطط ونتائج الاختبارات، ثم يخضع لنفس اختيار وموافقة US1.  
**الاختبار المستقل**: مرّر أحداث مهمة اصطناعية محدودة بأدلتها إلى منشئ المقترح وتحقق من الرفض/القبول دون كتابة قبل الموافقة.

### الاختبارات أولًا

- [ ] T061 [P] [US3] اكتب في `tests/site-knowledge-summary.test.ts` اختبارات تصنيف executed/planned/test outcomes، ومصدر `task_summary` ودليل غائب، ورفض أو تحرير المقترح وعدم الكتابة أو الاتصال الخارجي قبل الموافقة.
- [ ] T062 [US3] شغّل `tests/site-knowledge-summary.test.ts` وتحقق من فشل السلوك الجديد قبل التنفيذ.
- [ ] T063 [US3] قبل T064 افحص مسارات أحداث الجلسة المتاحة ووثّق مصدر الحدث والنتيجة والوقت وربط النطاق وحد الثقة في `specs/008-site-knowledge/plan.md`؛ أضف اختبارات ادعاء بلا دليل وأحداث اصطناعية. إن لم يوجد مصدر موثوق، لا تخترعه وتبقى ادعاءات الوكيل `declared` و`unverified` بعد الموافقة.

### التنفيذ

- [ ] T064 [US3] أنشئ `mcp-server/src/memory/knowledge-summary.ts` ليحوّل أحداث المهمة المصرح بها إلى اقتراح محدود في الذاكرة فقط، مع تمييز الأدلة الحقيقية من ادعاءات الوكيل، وعدم نسخ صفحة كاملة أو بيانات حساب.
- [ ] T065 [US3] اربط إنشاء المقترح بواجهة `mcp-server/src/tools/site-knowledge-manage.ts` ثم مسار `mcp-server/src/memory/knowledge-draft.ts` الحالي، مع اختيار المجموعة والمراجعة والموافقة؛ لا تشغيل تلقائي لخدمة AI خارجية.
- [ ] T066 [US3] شغّل `tests/site-knowledge-summary.test.ts` و`tests/site-knowledge-approval.test.ts` وأثبت عدم حفظ المرفوض والمخطط كمنفذ.

## المرحلة 7: US4 — استيراد اختياري لمصادر سابقة (Priority: P3)

**الهدف**: معاينة مصدر محلي يختاره المالك واختيار مدخلات لنطاق واحد واعتمادها قبل أي كتابة.  
**الاختبار المستقل**: استورد ملف fixture اصطناعيًا فيه سجل قديم وعلامة سر، واختر مدخلًا آمنًا مع التحقق من المصدر والتاريخ ورفض الحفظ قبل الموافقة.

### الاختبارات أولًا

- [ ] T067 [P] [US4] اكتب في `tests/site-knowledge-import.test.ts` اختبارات اختيار مصدر بواسطة المالك، أحجام وحدود parser، مصدر/تاريخ مجهول، تعارضات، رفض سر، ملف متغير بعد المعاينة، وإلغاء أو رفض موافقة المجموعة دون كتابة.
- [ ] T068 [US4] شغّل `tests/site-knowledge-import.test.ts` وتحقق من فشل السلوك غير المنفذ قبل إضافة الاستيراد.

### التنفيذ

- [ ] T069 [US4] أنشئ `mcp-server/src/memory/knowledge-import.ts` لتحليل المصدر المحلي الذي اختاره المالك ضمن حدود صريحة، واستخراج مقترحات تاريخية منسوبة للمصدر دون فتح روابط أو إرسال محتوى للشبكة.
- [ ] T070 [US4] اربط `mcp-server/src/tools/site-knowledge-manage.ts` و`scripts/memory.mjs` بواجهة اختيار المصدر من المالك ومعاينة واختيار دفعة واحدة لكل scope؛ اربط الموافقة بالبصمة والمحتوى المختار وأعد التحقق من المصدر عند commit.
- [ ] T071 [US4] شغّل `tests/site-knowledge-import.test.ts` و`tests/site-knowledge-privacy.test.ts` و`tests/site-knowledge-approval.test.ts` وتحقق من SC-005 وSC-008 وعدم الحفظ قبل الموافقة.

## المرحلة 8: المراجعة والتوثيق الشامل

- [ ] T072 حدّث `README.md` و`SECURITY.md` لوصف opt-in ونطاق profile وحد الثقة والخطر المتبقي للنص الحر وموافقة المالك والبيانات المؤجلة، دون ادعاء عزل عميل محلي عدائي.
- [ ] T073 حدّث `docs/operations-recovery.md` و`specs/008-site-knowledge/quickstart.md` بأوامر الاختبارات الفعلية وحدود الحذف الجزئي والاستعادة والنسخ الخارجية والـ rollback، دون أي أسرار أو بيانات فعلية.
- [ ] T074 قِس p95 للبحث والكتابة باستخدام fixture اصطناعي عند الحدود المحددة في `plan.md`؛ وثّق حجم البيانات وعدد التكرارات والبيئة والنتائج الفعلية في `quickstart.md` كـ baseline توثيقي غير مانع للتسليم، دون ادعاء SLO أو استخدام بيانات حقيقية. لا يتحول إلى معيار قبول إلا بهدف زمني يعتمده المالك لاحقًا.
- [ ] T075 نفّذ في نسخة معزولة جميع checks المنصوص عليها في `AGENTS.md`: build وlint وtypecheck وtest:coverage وsecurity:audit وcontext:lint وcontext:measure وarch:check؛ سجّل النظام وNode والنتائج الفعلية في `specs/008-site-knowledge/quickstart.md` أو تقرير مراجعة الميزة.
- [ ] T076 نفّذ السيناريوهات المناسبة في `specs/008-site-knowledge/quickstart.md` باستخدام Chromium وfixtures معزولة، بما فيها واجهة التأكيد الفعلية المؤهلة وعربي/RTL وتغيّر النطاق؛ إذا لم تثبت المعاينة كاملة فتبقى الكتابة معطلة وأبلغ بالحد.
- [ ] T077 راجع diff الفعلي و`specs/008-site-knowledge/contracts/site-knowledge.md` ضد جميع FR وSC، وفحوص الخصوصية والعزل وإعادة المحاولة والـ rollback، ثم أصلح الموجود وأعد الفحوص المتأثرة؛ لا تدّعِ حماية مطلقة من أسرار غير مكتشفة.
- [ ] T078 حدّث فهرس codebase-memory حسب آليته المدعومة بعد تغيير علاقات المصدر، وتحقق من التغطية والـ root للملفات المتأثرة؛ سجّل أي gaps في `specs/008-site-knowledge/quickstart.md` دون بيانات خاصة.

## الاعتماد وترتيب التنفيذ

- تُراجع قائمة الأمان T003 قبل اعتماد الخطة. يسبق تجهيز البيئة وحدود الثقة (T001 وT002 وT005) الأساس، وتسبق المرحلة 2 قصص المستخدم. يمكن تنفيذ الكود والاختبارات الاصطناعية قبل إثبات واجهة المراجعة؛ يجب إكمال T006 ثم T007 قبل تمكين أي كتابة فعلية أو تسليم. تسبق T042 تسجيل أي مسار كتابة حقيقي، وتبقى الواجهات غير مسجلة أو مرفوضة افتراضيًا حتى التأهيل؛ لا تسمح معاملات الوكيل أو متغيرات البيئة بتجاوز الشرط. تُستكمل T033–T036 بعد المسودات والخدمة وقبل اكتمال US1، وتسبق T043 المهمة T044، كما تسبق T063 المهمة T064.
- **US1 → US2**: القراءة الأساسية جزء من US1 للتحقق، وUS2 يضيف البحث والتعارضات؛ US2 قابل للاختبار بfixtures مستقلة بعد الأساس. يشكل الاثنان MVP المطلوب في الخطة.
- **US5 بعد US1**: يستخدم المخزن والموافقة والـ export؛ سيناريوهاته مستقلة بartifact اصطناعي. يمكن تصميمه مبكرًا لكن تسليمه بعد US1 وبوابة الموافقة.
- **US3 بعد US1**: يستخدم draft والموافقة؛ لا يعتمد على US5. **US4 بعد US1** ويستخدم parser مستقل؛ إن شارك مسار artifact مع US5 فيعتمد على عقده المكتمل، ولا يعتمد على US3.
- المراجعة الشاملة بعد القصص المراد تسليمها؛ الاستعادة والملخص والاستيراد لا تُفعَّل تلقائيًا عند اكتمال MVP. تتطلب الهجرة الحقيقية والنشر ترخيصًا مستقلًا.

## أمثلة توازٍ آمنة

- الأساس: T008–T011 اختبارات في ملفات مختلفة بعد T001 وT002 وT005؛ تُنفذ T012 قبل تنفيذ الأساس. لا يعتمد إعداد الاختبارات على اكتمال بوابة الاستخدام الحقيقي.
- US1: T025–T028 في ملفات اختبار منفصلة بعد checkpoint الأساس؛ مهام `knowledge-service.ts` و`knowledge-draft.ts` متسلسلة حسب العلاقات ولا تُعدل بالتوازي.
- US2: T046 وT047 في ملفين مستقلين بعد الأساس؛ T049 ثم T050–T052 وفق الاعتماد.
- US5: T053 وT054 متوازيان بعد US1؛ T056 ثم T057–T060 بالتسلسل.
- US3: T061 مستقل ويمكن إعداده بعد US1؛ T064 ثم T065 ثم T066.
- US4: T067 مستقل ويمكن إعداده بعد US1؛ T069 ثم T070 ثم T071. لا يحرر US3 وUS4 ملف `site-knowledge-manage.ts` بالتوازي.

## استراتيجية التسليم

ابدأ بالبوابات والتخزين والسياسة، ثم US1 وUS2 مع اختبارات منفصلة وبيانات اصطناعية. لا تُرسل محتوى للخارج، ولا تعتمد أن detector يمنع كل الأسرار. بعد مراجعة MVP يمكن اختيار US5 ثم US3 وUS4؛ احتفظ بالتوافق والـ rollback في كل مرحلة. المتابعة إلى `$speckit-implement` تتطلب مراجعة هذه المهام والبوابات، ولا تتضمن commit أو نشرًا أو تعديل بيانات المستخدم.
