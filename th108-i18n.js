/* th108-i18n.js — lightweight in-page localization for the TH108 controller.
   Two translation mechanisms so it covers this very-dynamic app without a full source refactor:
     1) runtime text/attribute translation keyed by the ENGLISH source string — for simple chrome
        (tab names, buttons, labels, tooltips). No markup needed; caches the original so it round-trips.
     2) [data-i18n="key"] elements — for rich prose (Docs/FAQ paragraphs) where the string has inline
        <b>/<code>/<i>; the catalog value is full translated HTML. Added section by section.
   A debounced MutationObserver re-applies to freshly-rendered DOM (layers/profiles build in JS).
   Arabic is RTL → sets <html dir>. Choice persists in localStorage. Language list mirrors Epomaker's site. */
(function () {
  'use strict';

  var LANGS = [
    { code: 'en',    name: 'English' },
    { code: 'zh-CN', name: '中文(简体)' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'ja',    name: '日本語' },
    { code: 'ko',    name: '한국어' },
    { code: 'fr',    name: 'Français' },
    { code: 'es',    name: 'Español' },
    { code: 'pt',    name: 'Português' },
    { code: 'ru',    name: 'Русский' },
    { code: 'de',    name: 'Deutsch' },
    { code: 'it',    name: 'Italiano' },
    { code: 'ar',    name: 'العربية', rtl: true },
    { code: 'vi',    name: 'Tiếng Việt' },
    { code: 'id',    name: 'Bahasa Indonesia' },
    { code: 'th',    name: 'ภาษาไทย' },
    { code: 'pt-BR', name: 'Português (Brasileiro)' },
    { code: 'pl',    name: 'Polski' },
    { code: 'hu',    name: 'Magyar' }
  ];

  // English source → { langCode: translation }. English needs no entry (the key IS the English text).
  // SEED = the header/nav chrome; expanded section-by-section. pt-BR falls back to pt when absent (see tr()).
  var CATALOG = {
    'Home':      { 'zh-CN':'主页','zh-TW':'首頁','ja':'ホーム','ko':'홈','fr':'Accueil','es':'Inicio','pt':'Início','ru':'Главная','de':'Startseite','it':'Home','ar':'الرئيسية','vi':'Trang chủ','id':'Beranda','th':'หน้าแรก','pl':'Główna','hu':'Kezdőlap' },
    'Hotkeys':   { 'zh-CN':'快捷键','zh-TW':'快捷鍵','ja':'ホットキー','ko':'단축키','fr':'Raccourcis','es':'Atajos','pt':'Atalhos','ru':'Горячие клавиши','de':'Tastenkürzel','it':'Scorciatoie','ar':'الاختصارات','vi':'Phím tắt','id':'Pintasan','th':'ปุ่มลัด','pl':'Skróty','hu':'Gyorsbillentyűk' },
    'Lighting':  { 'zh-CN':'灯光','zh-TW':'燈光','ja':'ライティング','ko':'조명','fr':'Éclairage','es':'Iluminación','pt':'Iluminação','ru':'Подсветка','de':'Beleuchtung','it':'Illuminazione','ar':'الإضاءة','vi':'Ánh sáng','id':'Pencahayaan','th':'แสงไฟ','pl':'Podświetlenie','hu':'Világítás' },
    'LCD Screen':{ 'zh-CN':'LCD屏幕','zh-TW':'LCD螢幕','ja':'LCD画面','ko':'LCD 화면','fr':'Écran LCD','es':'Pantalla LCD','pt':'Ecrã LCD','ru':'LCD-экран','de':'LCD-Bildschirm','it':'Schermo LCD','ar':'شاشة LCD','vi':'Màn hình LCD','id':'Layar LCD','th':'หน้าจอ LCD','pt-BR':'Tela LCD','pl':'Ekran LCD','hu':'LCD képernyő' },
    'Profiles':  { 'zh-CN':'配置文件','zh-TW':'設定檔','ja':'プロファイル','ko':'프로필','fr':'Profils','es':'Perfiles','pt':'Perfis','ru':'Профили','de':'Profile','it':'Profili','ar':'الملفات الشخصية','vi':'Hồ sơ','id':'Profil','th':'โปรไฟล์','pl':'Profile','hu':'Profilok' },
    'Docs':      { 'zh-CN':'文档','zh-TW':'文件','ja':'ドキュメント','ko':'문서','fr':'Docs','es':'Docs','pt':'Docs','ru':'Документация','de':'Doku','it':'Documentazione','ar':'المستندات','vi':'Tài liệu','id':'Dokumen','th':'เอกสาร','pl':'Dokumentacja','hu':'Dokumentáció' },
    'FAQ':       { 'zh-CN':'常见问题','zh-TW':'常見問題','ja':'よくある質問','ko':'자주 묻는 질문','fr':'FAQ','es':'Preguntas frecuentes','pt':'Perguntas frequentes','ru':'Вопросы и ответы','de':'FAQ','it':'FAQ','ar':'الأسئلة الشائعة','vi':'Câu hỏi thường gặp','id':'Tanya Jawab','th':'คำถามที่พบบ่อย','pt-BR':'Perguntas frequentes','pl':'Częste pytania','hu':'GYIK' },
    'Online':    { 'zh-CN':'在线','zh-TW':'線上','ja':'オンライン','ko':'온라인','fr':'En ligne','es':'En línea','pt':'Online','ru':'В сети','de':'Online','it':'Online','ar':'متصل','vi':'Trực tuyến','id':'Daring','th':'ออนไลน์','pl':'Online','hu':'Online' },
    'Grid':      { 'zh-CN':'网格','zh-TW':'網格','ja':'グリッド','ko':'그리드','fr':'Grille','es':'Cuadrícula','pt':'Grelha','ru':'Сетка','de':'Raster','it':'Griglia','ar':'شبكة','vi':'Lưới','id':'Kisi','th':'ตาราง','pt-BR':'Grade','pl':'Siatka','hu':'Rács' },
    'Fill':      { 'zh-CN':'填充','zh-TW':'填滿','ja':'フィル','ko':'채우기','fr':'Remplir','es':'Rellenar','pt':'Preencher','ru':'Заполнить','de':'Füllen','it':'Riempi','ar':'ملء','vi':'Lấp đầy','id':'Isi','th':'เติม','pt-BR':'Preencher','pl':'Wypełnij','hu':'Kitöltés' },

    // --- Core chrome batch (card titles + universal buttons). Deep FAQ/Docs prose grows on the [data-i18n] path. ---
    'About':          { 'zh-CN':'关于','zh-TW':'關於','ja':'概要','ko':'정보','fr':'À propos','es':'Acerca de','pt':'Sobre','ru':'О программе','de':'Über','it':'Informazioni','ar':'حول','vi':'Giới thiệu','id':'Tentang','th':'เกี่ยวกับ','pl':'Informacje','hu':'Névjegy' },
    'Advanced Keys':  { 'zh-CN':'高级按键','zh-TW':'進階按鍵','ja':'高度なキー','ko':'고급 키','fr':'Touches avancées','es':'Teclas avanzadas','pt':'Teclas avançadas','ru':'Расширенные клавиши','de':'Erweiterte Tasten','it':'Tasti avanzati','ar':'المفاتيح المتقدمة','vi':'Phím nâng cao','id':'Tombol Lanjutan','th':'ปุ่มขั้นสูง','pl':'Klawisze zaawansowane','hu':'Speciális billentyűk' },
    'Assign to Key':  { 'zh-CN':'分配到按键','zh-TW':'指派至按鍵','ja':'キーに割り当て','ko':'키에 할당','fr':'Assigner à une touche','es':'Asignar a tecla','pt':'Atribuir a tecla','ru':'Назначить клавише','de':'Taste zuweisen','it':'Assegna a tasto','ar':'تعيين لمفتاح','vi':'Gán cho phím','id':'Tetapkan ke Tombol','th':'กำหนดให้ปุ่ม','pl':'Przypisz do klawisza','hu':'Billentyűhöz rendel' },
    'Background Daemon':{ 'zh-CN':'后台守护进程','zh-TW':'背景常駐程式','ja':'バックグラウンドデーモン','ko':'백그라운드 데몬','fr':'Démon d\'arrière-plan','es':'Demonio en segundo plano','pt':'Daemon em segundo plano','ru':'Фоновая служба','de':'Hintergrunddienst','it':'Daemon in background','ar':'الخدمة الخلفية','vi':'Tiến trình nền','id':'Daemon Latar Belakang','th':'เดมอนเบื้องหลัง','pl':'Usługa w tle','hu':'Háttérszolgáltatás' },
    'Changelog':      { 'zh-CN':'更新日志','zh-TW':'更新日誌','ja':'変更履歴','ko':'변경 기록','fr':'Journal des modifications','es':'Registro de cambios','pt':'Registo de alterações','ru':'Список изменений','de':'Änderungsprotokoll','it':'Registro modifiche','ar':'سجل التغييرات','vi':'Nhật ký thay đổi','id':'Catatan Perubahan','th':'บันทึกการเปลี่ยนแปลง','pt-BR':'Registro de alterações','pl':'Lista zmian','hu':'Változásnapló' },
    'Decorative Light Toggles':{ 'zh-CN':'装饰灯开关','zh-TW':'裝飾燈開關','ja':'装飾ライトの切り替え','ko':'장식 조명 토글','fr':'Bascules d\'éclairage décoratif','es':'Interruptores de luz decorativa','pt':'Interruptores de luz decorativa','ru':'Переключатели декоративной подсветки','de':'Deko-Licht-Schalter','it':'Interruttori luci decorative','ar':'مفاتيح الإضاءة الزخرفية','vi':'Bật/tắt đèn trang trí','id':'Sakelar Lampu Dekoratif','th':'สลับไฟตกแต่ง','pl':'Przełączniki podświetlenia dekoracyjnego','hu':'Dekorvilágítás kapcsolók' },
    'Feature Guide':  { 'zh-CN':'功能指南','zh-TW':'功能指南','ja':'機能ガイド','ko':'기능 가이드','fr':'Guide des fonctionnalités','es':'Guía de funciones','pt':'Guia de funcionalidades','ru':'Руководство по функциям','de':'Funktionsübersicht','it':'Guida alle funzioni','ar':'دليل الميزات','vi':'Hướng dẫn tính năng','id':'Panduan Fitur','th':'คู่มือฟีเจอร์','pt-BR':'Guia de recursos','pl':'Przewodnik po funkcjach','hu':'Funkciók útmutató' },
    'GIF Screen':     { 'zh-CN':'GIF 屏幕','zh-TW':'GIF 螢幕','ja':'GIF画面','ko':'GIF 화면','fr':'Écran GIF','es':'Pantalla GIF','pt':'Ecrã GIF','ru':'GIF-экран','de':'GIF-Bildschirm','it':'Schermo GIF','ar':'شاشة GIF','vi':'Màn hình GIF','id':'Layar GIF','th':'หน้าจอ GIF','pt-BR':'Tela GIF','pl':'Ekran GIF','hu':'GIF képernyő' },
    'Get the daemon': { 'zh-CN':'获取守护进程','zh-TW':'取得常駐程式','ja':'デーモンを入手','ko':'데몬 받기','fr':'Obtenir le démon','es':'Obtener el demonio','pt':'Obter o daemon','ru':'Установить службу','de':'Dienst herunterladen','it':'Ottieni il daemon','ar':'احصل على الخدمة','vi':'Tải tiến trình nền','id':'Dapatkan daemon','th':'รับเดมอน','pl':'Pobierz usługę','hu':'Szolgáltatás beszerzése' },
    'Keyboard':       { 'zh-CN':'键盘','zh-TW':'鍵盤','ja':'キーボード','ko':'키보드','fr':'Clavier','es':'Teclado','pt':'Teclado','ru':'Клавиатура','de':'Tastatur','it':'Tastiera','ar':'لوحة المفاتيح','vi':'Bàn phím','id':'Papan Ketik','th':'แป้นพิมพ์','pl':'Klawiatura','hu':'Billentyűzet' },
    'Layer Compositor':{ 'zh-CN':'图层合成器','zh-TW':'圖層合成器','ja':'レイヤーコンポジター','ko':'레이어 합성기','fr':'Compositeur de calques','es':'Compositor de capas','pt':'Compositor de camadas','ru':'Композитор слоёв','de':'Ebenen-Compositor','it':'Compositore di livelli','ar':'مُركِّب الطبقات','vi':'Trình ghép lớp','id':'Kompositor Lapisan','th':'ตัวรวมเลเยอร์','pl':'Kompozytor warstw','hu':'Rétegkompozitor' },
    'Log':            { 'zh-CN':'日志','zh-TW':'日誌','ja':'ログ','ko':'로그','fr':'Journal','es':'Registro','pt':'Registo','ru':'Журнал','de':'Protokoll','it':'Registro','ar':'السجل','vi':'Nhật ký','id':'Log','th':'บันทึก','pt-BR':'Registro','pl':'Dziennik','hu':'Napló' },
    'Onboard Effects':{ 'zh-CN':'板载效果','zh-TW':'板載效果','ja':'オンボードエフェクト','ko':'온보드 효과','fr':'Effets embarqués','es':'Efectos integrados','pt':'Efeitos integrados','ru':'Встроенные эффекты','de':'Onboard-Effekte','it':'Effetti integrati','ar':'التأثيرات المدمجة','vi':'Hiệu ứng tích hợp','id':'Efek Bawaan','th':'เอฟเฟกต์ในตัว','pl':'Efekty wbudowane','hu':'Beépített effektek' },
    'Pick a Key':     { 'zh-CN':'选择一个按键','zh-TW':'選擇按鍵','ja':'キーを選択','ko':'키 선택','fr':'Choisir une touche','es':'Elegir una tecla','pt':'Escolher uma tecla','ru':'Выберите клавишу','de':'Taste wählen','it':'Scegli un tasto','ar':'اختر مفتاحًا','vi':'Chọn một phím','id':'Pilih Tombol','th':'เลือกปุ่ม','pl':'Wybierz klawisz','hu':'Válassz billentyűt' },
    'Toolbox':        { 'zh-CN':'工具箱','zh-TW':'工具箱','ja':'ツールボックス','ko':'도구 상자','fr':'Boîte à outils','es':'Caja de herramientas','pt':'Caixa de ferramentas','ru':'Инструменты','de':'Werkzeugkasten','it':'Strumenti','ar':'صندوق الأدوات','vi':'Hộp công cụ','id':'Kotak Alat','th':'กล่องเครื่องมือ','pl':'Przybornik','hu':'Eszköztár' },
    '♪ Now Playing':  { 'zh-CN':'♪ 正在播放','zh-TW':'♪ 正在播放','ja':'♪ 再生中','ko':'♪ 재생 중','fr':'♪ En lecture','es':'♪ Reproduciendo','pt':'♪ A reproduzir','ru':'♪ Сейчас играет','de':'♪ Aktuelle Wiedergabe','it':'♪ In riproduzione','ar':'♪ قيد التشغيل','vi':'♪ Đang phát','id':'♪ Sedang Diputar','th':'♪ กำลังเล่น','pt-BR':'♪ Tocando agora','pl':'♪ Teraz odtwarzane','hu':'♪ Most szól' },
    'Legal & Disclaimer':{ 'zh-CN':'法律与免责声明','zh-TW':'法律與免責聲明','ja':'法的情報と免責事項','ko':'법적 고지 및 면책','fr':'Mentions légales et avertissement','es':'Aviso legal y exención de responsabilidad','pt':'Aviso legal e isenção de responsabilidade','ru':'Правовая информация и отказ от ответственности','de':'Rechtliches & Haftungsausschluss','it':'Note legali e disclaimer','ar':'إشعار قانوني وإخلاء مسؤولية','vi':'Pháp lý & Miễn trừ trách nhiệm','id':'Hukum & Penafian','th':'กฎหมายและข้อจำกัดความรับผิด','pl':'Informacje prawne i zastrzeżenia','hu':'Jogi nyilatkozat' },
    'Apply':          { 'zh-CN':'应用','zh-TW':'套用','ja':'適用','ko':'적용','fr':'Appliquer','es':'Aplicar','pt':'Aplicar','ru':'Применить','de':'Anwenden','it':'Applica','ar':'تطبيق','vi':'Áp dụng','id':'Terapkan','th':'ใช้','pl':'Zastosuj','hu':'Alkalmaz' },
    'Apply to keyboard':{ 'zh-CN':'应用到键盘','zh-TW':'套用至鍵盤','ja':'キーボードに適用','ko':'키보드에 적용','fr':'Appliquer au clavier','es':'Aplicar al teclado','pt':'Aplicar ao teclado','ru':'Применить к клавиатуре','de':'Auf Tastatur anwenden','it':'Applica alla tastiera','ar':'تطبيق على لوحة المفاتيح','vi':'Áp dụng cho bàn phím','id':'Terapkan ke papan ketik','th':'ใช้กับแป้นพิมพ์','pl':'Zastosuj do klawiatury','hu':'Alkalmaz a billentyűzetre' },
    'Cancel':         { 'zh-CN':'取消','zh-TW':'取消','ja':'キャンセル','ko':'취소','fr':'Annuler','es':'Cancelar','pt':'Cancelar','ru':'Отмена','de':'Abbrechen','it':'Annulla','ar':'إلغاء','vi':'Hủy','id':'Batal','th':'ยกเลิก','pl':'Anuluj','hu':'Mégse' },
    'Connect Keyboard':{ 'zh-CN':'连接键盘','zh-TW':'連接鍵盤','ja':'キーボードを接続','ko':'키보드 연결','fr':'Connecter le clavier','es':'Conectar teclado','pt':'Ligar teclado','ru':'Подключить клавиатуру','de':'Tastatur verbinden','it':'Connetti tastiera','ar':'توصيل لوحة المفاتيح','vi':'Kết nối bàn phím','id':'Hubungkan Papan Ketik','th':'เชื่อมต่อแป้นพิมพ์','pt-BR':'Conectar teclado','pl':'Połącz klawiaturę','hu':'Billentyűzet csatlakoztatása' },
    'Reset':          { 'zh-CN':'重置','zh-TW':'重設','ja':'リセット','ko':'재설정','fr':'Réinitialiser','es':'Restablecer','pt':'Repor','ru':'Сброс','de':'Zurücksetzen','it':'Reimposta','ar':'إعادة تعيين','vi':'Đặt lại','id':'Atur Ulang','th':'รีเซ็ต','pt-BR':'Redefinir','pl':'Resetuj','hu':'Visszaállítás' },
    'Take control back':{ 'zh-CN':'收回控制权','zh-TW':'收回控制權','ja':'制御を取り戻す','ko':'제어권 되찾기','fr':'Reprendre le contrôle','es':'Recuperar el control','pt':'Retomar o controlo','ru':'Вернуть управление','de':'Kontrolle zurücknehmen','it':'Riprendi il controllo','ar':'استعادة التحكم','vi':'Lấy lại quyền điều khiển','id':'Ambil Alih Kembali','th':'ควบคุมกลับคืน','pt-BR':'Retomar o controle','pl':'Przejmij kontrolę','hu':'Irányítás visszavétele' }
  };

  var LS_KEY = 'th108_lang';
  var cur = 'en';
  var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  // translation for a normalized English key in `code`, with pt-BR→pt fallback; '' English or none.
  function tr(key, code) {
    if (code === 'en') return null;
    var e = CATALOG[key]; if (!e) return null;
    if (e[code] != null) return e[code];
    if (code === 'pt-BR' && e['pt'] != null) return e['pt'];
    return null;
  }
  // keep leading/trailing whitespace of the original around the translated core
  function reWs(orig, core) { var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(orig); return (m ? m[1] : '') + core + (m ? m[3] : ''); }

  function translateTree(root, code) {
    if (!root || root.nodeType !== 1) return;
    // 1) rich prose blocks: data-i18n → full translated HTML (cache original once)
    var blocks = root.querySelectorAll ? root.querySelectorAll('[data-i18n]') : [];
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i], key = el.getAttribute('data-i18n');
      if (el.__i18nEn == null) el.__i18nEn = el.innerHTML;
      var t = tr(key, code);
      el.innerHTML = (t != null) ? t : el.__i18nEn;
    }
    // 2) simple text nodes matched by their English source
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var tn, list = [];
    while ((tn = walker.nextNode())) list.push(tn);
    for (var j = 0; j < list.length; j++) {
      var node = list[j];
      if (node.parentNode && node.parentNode.closest && node.parentNode.closest('[data-i18n]')) continue;   // handled as a block
      var en = (node.__i18nEn != null) ? node.__i18nEn : node.nodeValue;
      var key2 = norm(en); if (!key2) continue;
      if (!CATALOG[key2]) { if (node.__i18nEn != null && code === 'en') node.nodeValue = node.__i18nEn; continue; }
      if (node.__i18nEn == null) node.__i18nEn = en;
      var t2 = tr(key2, code);
      node.nodeValue = (t2 != null) ? reWs(en, t2) : node.__i18nEn;
    }
    // 3) translatable attributes
    var attrs = ['title', 'placeholder', 'aria-label'];
    for (var a = 0; a < attrs.length; a++) {
      var attr = attrs[a], cacheK = '__i18n_' + attr;
      var els = root.querySelectorAll ? root.querySelectorAll('[' + attr + ']') : [];
      for (var k = 0; k < els.length; k++) {
        var e2 = els[k];
        var orig = (e2[cacheK] != null) ? e2[cacheK] : e2.getAttribute(attr);
        var kk = norm(orig); if (!kk || !CATALOG[kk]) continue;
        if (e2[cacheK] == null) e2[cacheK] = orig;
        var t3 = tr(kk, code);
        e2.setAttribute(attr, (t3 != null) ? t3 : e2[cacheK]);
      }
    }
  }

  function apply(code) {
    if (!LANGS.some(function (l) { return l.code === code; })) code = 'en';
    cur = code;
    var lang = LANGS.filter(function (l) { return l.code === code; })[0];
    document.documentElement.lang = code;
    document.documentElement.dir = (lang && lang.rtl) ? 'rtl' : 'ltr';
    translateTree(document.body, code);
    try { localStorage.setItem(LS_KEY, code); } catch (_) {}
    var sel = document.getElementById('th108LangSel'); if (sel && sel.value !== code) sel.value = code;
  }

  function buildDropdown() {
    var mount = document.getElementById('langMount'); if (!mount || mount.__built) return;
    mount.__built = true;
    var sel = document.createElement('select');
    sel.id = 'th108LangSel';
    sel.title = 'Language';
    sel.setAttribute('aria-label', 'Language');
    sel.style.cssText = 'font:inherit;font-size:13px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 8px;cursor:pointer;max-width:150px';
    for (var i = 0; i < LANGS.length; i++) {
      var o = document.createElement('option'); o.value = LANGS[i].code; o.textContent = LANGS[i].name; sel.appendChild(o);
    }
    sel.value = cur;
    sel.addEventListener('change', function () { apply(sel.value); });
    var wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:5px';
    var globe = document.createElement('span'); globe.textContent = '🌐'; globe.style.fontSize = '14px';
    wrap.appendChild(globe); wrap.appendChild(sel);
    mount.appendChild(wrap);
  }

  // Re-translate freshly-rendered DOM (layers/profiles/binder build in JS after load). Debounced; skips English.
  var pending = [], timer = null;
  function observe() {
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(function (muts) {
      if (cur === 'en') return;
      for (var i = 0; i < muts.length; i++) for (var j = 0; j < muts[i].addedNodes.length; j++) {
        var n = muts[i].addedNodes[j]; if (n.nodeType === 1) pending.push(n);
      }
      if (pending.length && !timer) timer = setTimeout(function () {
        timer = null; var batch = pending; pending = [];
        for (var k = 0; k < batch.length; k++) { try { translateTree(batch[k], cur); } catch (_) {} }
      }, 150);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    try { cur = localStorage.getItem(LS_KEY) || 'en'; } catch (_) { cur = 'en'; }
    if (!LANGS.some(function (l) { return l.code === cur; })) cur = 'en';
    buildDropdown();
    apply(cur);
    observe();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.TH108i18n = { apply: apply, LANGS: LANGS, CATALOG: CATALOG, retranslate: function () { translateTree(document.body, cur); } };
})();
