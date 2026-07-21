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
    'Fill':      { 'zh-CN':'填充','zh-TW':'填滿','ja':'フィル','ko':'채우기','fr':'Remplir','es':'Rellenar','pt':'Preencher','ru':'Заполнить','de':'Füllen','it':'Riempi','ar':'ملء','vi':'Lấp đầy','id':'Isi','th':'เติม','pt-BR':'Preencher','pl':'Wypełnij','hu':'Kitöltés' }
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
