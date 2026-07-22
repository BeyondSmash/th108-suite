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
    'Take control back':{ 'zh-CN':'收回控制权','zh-TW':'收回控制權','ja':'制御を取り戻す','ko':'제어권 되찾기','fr':'Reprendre le contrôle','es':'Recuperar el control','pt':'Retomar o controlo','ru':'Вернуть управление','de':'Kontrolle zurücknehmen','it':'Riprendi il controllo','ar':'استعادة التحكم','vi':'Lấy lại quyền điều khiển','id':'Ambil Alih Kembali','th':'ควบคุมกลับคืน','pt-BR':'Retomar o controle','pl':'Przejmij kontrolę','hu':'Irányítás visszavétele' },

    // --- Lighting / Layers screen + universal buttons/statuses ---
    'Accept':         { 'zh-CN':'接受','zh-TW':'接受','ja':'承認','ko':'수락','fr':'Accepter','es':'Aceptar','pt':'Aceitar','ru':'Принять','de':'Akzeptieren','it':'Accetta','ar':'قبول','vi':'Chấp nhận','id':'Terima','th':'ยอมรับ','pl':'Akceptuj','hu':'Elfogad' },
    'Choose File':    { 'zh-CN':'选择文件','zh-TW':'選擇檔案','ja':'ファイルを選択','ko':'파일 선택','fr':'Choisir un fichier','es':'Elegir archivo','pt':'Escolher ficheiro','ru':'Выбрать файл','de':'Datei wählen','it':'Scegli file','ar':'اختر ملفًا','vi':'Chọn tệp','id':'Pilih Berkas','th':'เลือกไฟล์','pt-BR':'Escolher arquivo','pl':'Wybierz plik','hu':'Fájl kiválasztása' },
    'Hide':           { 'zh-CN':'隐藏','zh-TW':'隱藏','ja':'非表示','ko':'숨기기','fr':'Masquer','es':'Ocultar','pt':'Ocultar','ru':'Скрыть','de':'Ausblenden','it':'Nascondi','ar':'إخفاء','vi':'Ẩn','id':'Sembunyikan','th':'ซ่อน','pl':'Ukryj','hu':'Elrejtés' },
    'Show':           { 'zh-CN':'显示','zh-TW':'顯示','ja':'表示','ko':'표시','fr':'Afficher','es':'Mostrar','pt':'Mostrar','ru':'Показать','de':'Anzeigen','it':'Mostra','ar':'إظهار','vi':'Hiện','id':'Tampilkan','th':'แสดง','pl':'Pokaż','hu':'Megjelenítés' },
    'Settings':       { 'zh-CN':'设置','zh-TW':'設定','ja':'設定','ko':'설정','fr':'Paramètres','es':'Ajustes','pt':'Definições','ru':'Настройки','de':'Einstellungen','it':'Impostazioni','ar':'الإعدادات','vi':'Cài đặt','id':'Pengaturan','th':'การตั้งค่า','pt-BR':'Configurações','pl':'Ustawienia','hu':'Beállítások' },
    'Reset to default':{ 'zh-CN':'恢复默认','zh-TW':'恢復預設','ja':'デフォルトに戻す','ko':'기본값으로 재설정','fr':'Réinitialiser par défaut','es':'Restablecer valores predeterminados','pt':'Repor predefinição','ru':'Сбросить к умолчанию','de':'Auf Standard zurücksetzen','it':'Ripristina predefiniti','ar':'إعادة التعيين إلى الافتراضي','vi':'Đặt lại về mặc định','id':'Atur ulang ke default','th':'รีเซ็ตเป็นค่าเริ่มต้น','pt-BR':'Redefinir para o padrão','pl':'Przywróć domyślne','hu':'Alaphelyzetbe állítás' },
    'Loading…':       { 'zh-CN':'加载中…','zh-TW':'載入中…','ja':'読み込み中…','ko':'불러오는 중…','fr':'Chargement…','es':'Cargando…','pt':'A carregar…','ru':'Загрузка…','de':'Wird geladen…','it':'Caricamento…','ar':'جارٍ التحميل…','vi':'Đang tải…','id':'Memuat…','th':'กำลังโหลด…','pt-BR':'Carregando…','pl':'Ładowanie…','hu':'Betöltés…' },
    'Opening…':       { 'zh-CN':'打开中…','zh-TW':'開啟中…','ja':'開いています…','ko':'여는 중…','fr':'Ouverture…','es':'Abriendo…','pt':'A abrir…','ru':'Открытие…','de':'Wird geöffnet…','it':'Apertura…','ar':'جارٍ الفتح…','vi':'Đang mở…','id':'Membuka…','th':'กำลังเปิด…','pt-BR':'Abrindo…','pl':'Otwieranie…','hu':'Megnyitás…' },
    'Updating keyboard…':{ 'zh-CN':'正在更新键盘…','zh-TW':'正在更新鍵盤…','ja':'キーボードを更新中…','ko':'키보드 업데이트 중…','fr':'Mise à jour du clavier…','es':'Actualizando teclado…','pt':'A atualizar o teclado…','ru':'Обновление клавиатуры…','de':'Tastatur wird aktualisiert…','it':'Aggiornamento tastiera…','ar':'جارٍ تحديث لوحة المفاتيح…','vi':'Đang cập nhật bàn phím…','id':'Memperbarui papan ketik…','th':'กำลังอัปเดตแป้นพิมพ์…','pt-BR':'Atualizando o teclado…','pl':'Aktualizowanie klawiatury…','hu':'Billentyűzet frissítése…' },
    'done':           { 'zh-CN':'完成','zh-TW':'完成','ja':'完了','ko':'완료','fr':'terminé','es':'listo','pt':'concluído','ru':'готово','de':'fertig','it':'fatto','ar':'تم','vi':'xong','id':'selesai','th':'เสร็จแล้ว','pl':'gotowe','hu':'kész' },
    'working…':       { 'zh-CN':'处理中…','zh-TW':'處理中…','ja':'実行中…','ko':'작업 중…','fr':'en cours…','es':'trabajando…','pt':'a processar…','ru':'выполняется…','de':'wird ausgeführt…','it':'in corso…','ar':'جارٍ العمل…','vi':'đang xử lý…','id':'memproses…','th':'กำลังทำงาน…','pt-BR':'processando…','pl':'pracuję…','hu':'folyamatban…' },
    'scanning…':      { 'zh-CN':'扫描中…','zh-TW':'掃描中…','ja':'スキャン中…','ko':'검색 중…','fr':'analyse…','es':'escaneando…','pt':'a analisar…','ru':'сканирование…','de':'wird gescannt…','it':'scansione…','ar':'جارٍ الفحص…','vi':'đang quét…','id':'memindai…','th':'กำลังสแกน…','pt-BR':'escaneando…','pl':'skanowanie…','hu':'keresés…' },
    'checking…':      { 'zh-CN':'检查中…','zh-TW':'檢查中…','ja':'確認中…','ko':'확인 중…','fr':'vérification…','es':'comprobando…','pt':'a verificar…','ru':'проверка…','de':'wird geprüft…','it':'verifica…','ar':'جارٍ التحقق…','vi':'đang kiểm tra…','id':'memeriksa…','th':'กำลังตรวจสอบ…','pt-BR':'verificando…','pl':'sprawdzanie…','hu':'ellenőrzés…' },
    '+ Add layer':    { 'zh-CN':'+ 添加图层','zh-TW':'+ 新增圖層','ja':'+ レイヤーを追加','ko':'+ 레이어 추가','fr':'+ Ajouter un calque','es':'+ Añadir capa','pt':'+ Adicionar camada','ru':'+ Добавить слой','de':'+ Ebene hinzufügen','it':'+ Aggiungi livello','ar':'+ إضافة طبقة','vi':'+ Thêm lớp','id':'+ Tambah Lapisan','th':'+ เพิ่มเลเยอร์','pl':'+ Dodaj warstwę','hu':'+ Réteg hozzáadása' },
    'Agent Alerts':   { 'zh-CN':'Agent 提醒','zh-TW':'Agent 提醒','ja':'エージェントアラート','ko':'에이전트 알림','fr':'Alertes de l\'agent','es':'Alertas del agente','pt':'Alertas do agente','ru':'Оповещения агента','de':'Agent-Benachrichtigungen','it':'Avvisi agente','ar':'تنبيهات الوكيل','vi':'Cảnh báo tác nhân','id':'Peringatan Agen','th':'การแจ้งเตือนเอเจนต์','pl':'Alerty agenta','hu':'Ügynök-értesítések' },
    '⌨ Hide Keyboard':{ 'zh-CN':'⌨ 隐藏键盘','zh-TW':'⌨ 隱藏鍵盤','ja':'⌨ キーボードを隠す','ko':'⌨ 키보드 숨기기','fr':'⌨ Masquer le clavier','es':'⌨ Ocultar teclado','pt':'⌨ Ocultar teclado','ru':'⌨ Скрыть клавиатуру','de':'⌨ Tastatur ausblenden','it':'⌨ Nascondi tastiera','ar':'⌨ إخفاء لوحة المفاتيح','vi':'⌨ Ẩn bàn phím','id':'⌨ Sembunyikan Papan Ketik','th':'⌨ ซ่อนแป้นพิมพ์','pl':'⌨ Ukryj klawiaturę','hu':'⌨ Billentyűzet elrejtése' },
    '⌨ Show Keyboard':{ 'zh-CN':'⌨ 显示键盘','zh-TW':'⌨ 顯示鍵盤','ja':'⌨ キーボードを表示','ko':'⌨ 키보드 표시','fr':'⌨ Afficher le clavier','es':'⌨ Mostrar teclado','pt':'⌨ Mostrar teclado','ru':'⌨ Показать клавиатуру','de':'⌨ Tastatur anzeigen','it':'⌨ Mostra tastiera','ar':'⌨ إظهار لوحة المفاتيح','vi':'⌨ Hiện bàn phím','id':'⌨ Tampilkan Papan Ketik','th':'⌨ แสดงแป้นพิมพ์','pl':'⌨ Pokaż klawiaturę','hu':'⌨ Billentyűzet megjelenítése' },
    '⌨ Hide live agent preview':{ 'zh-CN':'⌨ 隐藏实时 Agent 预览','zh-TW':'⌨ 隱藏即時 Agent 預覽','ja':'⌨ ライブエージェントプレビューを隠す','ko':'⌨ 실시간 에이전트 미리보기 숨기기','fr':'⌨ Masquer l\'aperçu en direct de l\'agent','es':'⌨ Ocultar vista previa en vivo del agente','pt':'⌨ Ocultar pré-visualização ao vivo do agente','ru':'⌨ Скрыть живой предпросмотр агента','de':'⌨ Live-Agent-Vorschau ausblenden','it':'⌨ Nascondi anteprima live dell\'agente','ar':'⌨ إخفاء المعاينة المباشرة للوكيل','vi':'⌨ Ẩn xem trước tác nhân trực tiếp','id':'⌨ Sembunyikan pratinjau agen langsung','th':'⌨ ซ่อนตัวอย่างเอเจนต์แบบสด','pt-BR':'⌨ Ocultar prévia ao vivo do agente','pl':'⌨ Ukryj podgląd agenta na żywo','hu':'⌨ Élő ügynök-előnézet elrejtése' },
    '⌨ Show live agent preview':{ 'zh-CN':'⌨ 显示实时 Agent 预览','zh-TW':'⌨ 顯示即時 Agent 預覽','ja':'⌨ ライブエージェントプレビューを表示','ko':'⌨ 실시간 에이전트 미리보기 표시','fr':'⌨ Afficher l\'aperçu en direct de l\'agent','es':'⌨ Mostrar vista previa en vivo del agente','pt':'⌨ Mostrar pré-visualização ao vivo do agente','ru':'⌨ Показать живой предпросмотр агента','de':'⌨ Live-Agent-Vorschau anzeigen','it':'⌨ Mostra anteprima live dell\'agente','ar':'⌨ إظهار المعاينة المباشرة للوكيل','vi':'⌨ Hiện xem trước tác nhân trực tiếp','id':'⌨ Tampilkan pratinjau agen langsung','th':'⌨ แสดงตัวอย่างเอเจนต์แบบสด','pt-BR':'⌨ Mostrar prévia ao vivo do agente','pl':'⌨ Pokaż podgląd agenta na żywo','hu':'⌨ Élő ügynök-előnézet megjelenítése' },
    '⌨ Hide Twinkle Region':{ 'zh-CN':'⌨ 隐藏闪烁区域','zh-TW':'⌨ 隱藏閃爍區域','ja':'⌨ きらめき領域を隠す','ko':'⌨ 반짝임 영역 숨기기','fr':'⌨ Masquer la zone de scintillement','es':'⌨ Ocultar región de destello','pt':'⌨ Ocultar região de cintilação','ru':'⌨ Скрыть область мерцания','de':'⌨ Funkelbereich ausblenden','it':'⌨ Nascondi area scintillio','ar':'⌨ إخفاء منطقة التلألؤ','vi':'⌨ Ẩn vùng lấp lánh','id':'⌨ Sembunyikan area kelip','th':'⌨ ซ่อนพื้นที่ระยิบระยับ','pl':'⌨ Ukryj obszar migotania','hu':'⌨ Csillámzóna elrejtése' },
    '⌨ Set Twinkle Keys':{ 'zh-CN':'⌨ 设置闪烁按键','zh-TW':'⌨ 設定閃爍按鍵','ja':'⌨ きらめきキーを設定','ko':'⌨ 반짝임 키 설정','fr':'⌨ Définir les touches de scintillement','es':'⌨ Definir teclas de destello','pt':'⌨ Definir teclas de cintilação','ru':'⌨ Задать клавиши мерцания','de':'⌨ Funkeltasten festlegen','it':'⌨ Imposta tasti scintillio','ar':'⌨ تعيين مفاتيح التلألؤ','vi':'⌨ Đặt phím lấp lánh','id':'⌨ Atur tombol kelip','th':'⌨ ตั้งปุ่มระยิบระยับ','pl':'⌨ Ustaw klawisze migotania','hu':'⌨ Csillámbillentyűk beállítása' },
    'Collapse / expand this section':{ 'zh-CN':'折叠 / 展开此部分','zh-TW':'摺疊 / 展開此區段','ja':'このセクションを折りたたむ / 展開','ko':'이 섹션 접기 / 펼치기','fr':'Réduire / développer cette section','es':'Contraer / expandir esta sección','pt':'Recolher / expandir esta secção','ru':'Свернуть / развернуть этот раздел','de':'Diesen Abschnitt ein-/ausklappen','it':'Comprimi / espandi questa sezione','ar':'طي / توسيع هذا القسم','vi':'Thu gọn / mở rộng phần này','id':'Ciutkan / bentangkan bagian ini','th':'ยุบ / ขยายส่วนนี้','pt-BR':'Recolher / expandir esta seção','pl':'Zwiń / rozwiń tę sekcję','hu':'Szakasz összecsukása / kibontása' }
  };

  var LS_KEY = 'th108_lang';
  var cur = 'en';    // the RESOLVED code actually rendered (never 'system')
  var sel = 'system';  // the user's SELECTION — may be the 'system' sentinel, which re-resolves from the OS each load

  // Map the OS/browser locale(s) to the closest supported language; English if nothing matches.
  function resolveSystem() {
    var prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (var i = 0; i < prefs.length; i++) {
      var p = prefs[i]; if (!p) continue; var lp = p.toLowerCase();
      var exact = LANGS.filter(function (l) { return l.code.toLowerCase() === lp; })[0];
      if (exact) return exact.code;
      var base = lp.split('-')[0];
      if (base === 'zh') return /(tw|hk|mo|hant)/.test(lp) ? 'zh-TW' : 'zh-CN';   // Traditional vs Simplified
      if (base === 'pt') return /br/.test(lp) ? 'pt-BR' : 'pt';
      var bm = LANGS.filter(function (l) { return l.code.toLowerCase() === base; })[0];
      if (bm) return bm.code;
    }
    return 'en';
  }
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
    sel = (code === 'system' || LANGS.some(function (l) { return l.code === code; })) ? code : 'system';
    cur = (sel === 'system') ? resolveSystem() : sel;   // 'system' re-resolves from the OS; a specific pick is used as-is
    var lang = LANGS.filter(function (l) { return l.code === cur; })[0];
    document.documentElement.lang = cur;
    document.documentElement.dir = (lang && lang.rtl) ? 'rtl' : 'ltr';
    translateTree(document.body, cur);
    try { localStorage.setItem(LS_KEY, sel); } catch (_) {}   // persist the SELECTION (may be 'system'), not the resolved code
    applyAllOffsets();   // dir may have flipped → re-seat the cluster/separator/label with this direction's offsets
    syncActive(sel);
    try { document.dispatchEvent(new CustomEvent('th108:langapplied', { detail: { code: cur } })); } catch (_) {}   // tab widths changed → let the controller re-seat the tab highlight
  }

  // highlight the active language in the popup (also called from apply() so localStorage-init stays in sync)
  function syncActive(code) {
    var lbl = document.getElementById('th108LangLabel');
    if (lbl) lbl.textContent = (LANGS.filter(function (l) { return l.code === cur; })[0] || {}).name || '';
    var panel = document.getElementById('th108LangPanel'); if (!panel) return;
    var opts = panel.querySelectorAll('[role="option"]');
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].getAttribute('data-code') === code;
      opts[i].setAttribute('aria-selected', on ? 'true' : 'false');
      opts[i].style.background = on ? 'var(--border)' : 'none';
      opts[i].style.fontWeight = on ? '600' : 'normal';
    }
  }

  // Baked-in positions (dialed in via ?langtune=1). localStorage overrides these when a nudge was saved.
  // The transforms are PHYSICAL (translate x/y), so RTL needs its own values — each key has an _rtl twin,
  // resolved by keyFor() from the live document direction. Tuning in Arabic edits the _rtl set only.
  var OFFDEFS = {
    th108_langoff: { x: -15, y: 3 }, th108_langoff_rtl: { x: -1.5, y: 3 },
    th108_sepoff:  { x: -2, y: -5 }, th108_sepoff_rtl:  { x: -12.5, y: -5 },
    th108_lbloff:  { x: 0, y: 0 },   th108_lbloff_rtl:  { x: -16, y: -4 }
  };
  function keyFor(base) { return (document.documentElement.dir === 'rtl') ? base + '_rtl' : base; }
  // Apply a subpixel nudge to an element (baked default for the current direction, or the persisted override if tuned).
  function applyOffset(el, base) {
    var key = keyFor(base);
    var d = OFFDEFS[key] || OFFDEFS[base] || { x: 0, y: 0 };
    var o = { x: d.x, y: d.y };
    try { var s = JSON.parse(localStorage.getItem(key)); if (s) o = s; } catch (_) {}
    if (el) el.style.transform = 'translate(' + o.x + 'px,' + o.y + 'px)';
    return o;
  }
  // Re-apply all three nudges — called on every language switch so a direction flip picks up the right (LTR vs RTL) set.
  function applyAllOffsets() {
    applyOffset(document.getElementById('langExt'), 'th108_langoff');
    applyOffset(document.querySelector('.hdrsep'), 'th108_sepoff');
    applyOffset(document.getElementById('th108LangLabel'), 'th108_lbloff');
  }
  // Dev-only position tuner (open with ?langtune=1): three independent groups — the whole | + 🌐 cluster,
  // the | separator, and the language label. Each axis has a typeable box (fine) + a slider (coarse), kept in sync;
  // live + persisted. Copy writes all transforms to the clipboard to bake in.
  function buildLangTuner(host, sep, lbl) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:60px;right:12px;z-index:99999;background:var(--card,#161b22);color:var(--text,#e6edf3);border:1px solid var(--border,#30363d);border-radius:10px;padding:10px 12px;font:12px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.4);width:250px';
    var head = document.createElement('div'); head.textContent = '🌐 position tuner'; head.style.cssText = 'font-weight:700;margin-bottom:4px';
    box.appendChild(head);

    var groups = [];  // { base, o } — for Log
    function group(title, el, base) {
      var o = applyOffset(el, base); groups.push({ base: base, o: o });
      var h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-weight:600;opacity:.85;margin:8px 0 2px'; box.appendChild(h);
      function row(axis) {
        var wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0';
        var lab = document.createElement('span'); lab.textContent = axis.toUpperCase(); lab.style.cssText = 'width:12px;opacity:.7';
        var num = document.createElement('input'); num.type = 'number'; num.step = '0.1'; num.value = o[axis];
        num.style.cssText = 'width:60px;background:var(--inset,#0d1117);color:inherit;border:1px solid var(--border,#30363d);border-radius:6px;padding:3px 5px;font:inherit';
        var r = document.createElement('input'); r.type = 'range'; r.min = '-400'; r.max = '400'; r.step = '0.5'; r.value = o[axis]; r.style.cssText = 'flex:1;min-width:0';
        function apply() { el.style.transform = 'translate(' + o.x + 'px,' + o.y + 'px)'; try { localStorage.setItem(keyFor(base), JSON.stringify(o)); } catch (_) {} }   // keyFor → writes the LTR or _rtl key per live direction
        // Typing drives the slider; dragging drives the box. Never write back into the field being edited (lets you type "-", "1.").
        num.addEventListener('input', function () { var v = parseFloat(num.value); if (isNaN(v)) return; o[axis] = v; r.value = v; apply(); });
        r.addEventListener('input', function () { o[axis] = parseFloat(r.value); num.value = o[axis]; apply(); });
        wrap.appendChild(lab); wrap.appendChild(num); wrap.appendChild(r); box.appendChild(wrap);
      }
      row('x'); row('y');
    }
    group('Cluster ( | 🌐 )', host, 'th108_langoff');
    group('Separator ( | )', sep, 'th108_sepoff');
    group('Label', lbl, 'th108_lbloff');

    var log = document.createElement('button'); log.textContent = 'Copy values';
    log.style.cssText = 'margin-top:10px;width:100%;padding:5px;cursor:pointer;background:var(--inset,#21262d);color:inherit;border:1px solid var(--border,#30363d);border-radius:7px';
    log.addEventListener('click', function () {
      var text = groups.map(function (g) { return keyFor(g.base) + ': { x: ' + g.o.x + ', y: ' + g.o.y + ' }'; }).join('\n');   // resolved key (LTR or _rtl) → paste straight into OFFDEFS
      console.log('[🌐 tuner]\n' + text);
      try {
        navigator.clipboard.writeText(text).then(
          function () { var t = log.textContent; log.textContent = 'Copied ✓'; setTimeout(function () { log.textContent = t; }, 1200); },
          function () { log.textContent = 'Copy failed — see console'; }
        );
      } catch (_) { log.textContent = 'Copy failed — see console'; }
    });
    box.appendChild(log);
    document.body.appendChild(box);
  }

  // Compact 🌐 button; clicking drops the language list below it (keeps the header tight). Emoji is unselectable.
  function buildDropdown() {
    var mount = document.getElementById('langMount'); if (!mount || mount.__built) return;
    mount.__built = true;

    var wrap = document.createElement('span');
    wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;user-select:none;-webkit-user-select:none';

    var btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'th108LangBtn'; btn.title = 'Language';
    btn.setAttribute('aria-label', 'Language'); btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '🌐';
    // inline-flex centering (not padding/line-height) optically centers the emoji glyph; height matches the On button / slider row
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;height:26px;width:30px;padding:0;font-size:14px;line-height:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:999px;cursor:pointer;user-select:none;-webkit-user-select:none';

    var panel = document.createElement('div');
    panel.id = 'th108LangPanel'; panel.setAttribute('role', 'listbox'); panel.hidden = true;
    // left:0 → opens rightward from the button (into the empty right gutter, not over the cards). overflow-x:hidden + border-box options = no horizontal scrollbar.
    panel.style.cssText = 'position:absolute;top:calc(100% + 4px);left:0;z-index:1000;min-width:150px;max-height:60vh;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:4px';   // box-shadow (theme-aware glow) lives in CSS on #th108LangPanel

    function onOver() { if (this.getAttribute('aria-selected') !== 'true') this.style.background = 'var(--border)'; }
    function onOut()  { if (this.getAttribute('aria-selected') !== 'true') this.style.background = 'none'; }
    function onPick() { apply(this.getAttribute('data-code')); close(); btn.focus(); }
    function addOpt(code, label) {
      var opt = document.createElement('button');
      opt.type = 'button'; opt.setAttribute('role', 'option'); opt.setAttribute('data-code', code); opt.textContent = label;
      opt.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:start;background:none;border:0;color:inherit;font:inherit;font-size:13px;padding:6px 9px;border-radius:6px;cursor:pointer;white-space:nowrap';
      opt.addEventListener('mouseenter', onOver); opt.addEventListener('mouseleave', onOut); opt.addEventListener('click', onPick);
      panel.appendChild(opt);
    }
    // "System" first — the default — with the OS-resolved language shown so the mapping is visible, not hidden
    var sysName = (LANGS.filter(function (l) { return l.code === resolveSystem(); })[0] || {}).name || 'English';
    addOpt('system', 'System · ' + sysName);
    for (var i = 0; i < LANGS.length; i++) addOpt(LANGS[i].code, LANGS[i].name);

    function onDoc(e) { if (!wrap.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { close(); btn.focus(); } }
    function open()  { panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.style.borderColor = 'var(--blue,#58a6ff)'; btn.style.boxShadow = '0 0 0 2px rgba(88,166,255,.35)'; document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }
    function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.style.borderColor = 'var(--border)'; btn.style.boxShadow = 'none'; document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); }
    btn.addEventListener('click', function () { panel.hidden ? open() : close(); });

    var lbl = document.createElement('span');   // current language name, shown to the right of the 🌐 button
    lbl.id = 'th108LangLabel'; lbl.style.cssText = 'margin-left:7px;font-size:13px;font-weight:600;color:var(--muted);user-select:none;white-space:nowrap';
    lbl.addEventListener('click', function () { panel.hidden ? open() : close(); });   // click the label too
    lbl.style.cursor = 'pointer';

    wrap.appendChild(btn); wrap.appendChild(lbl); wrap.appendChild(panel);
    mount.appendChild(wrap);
    syncActive(sel);
    var host = document.getElementById('langExt') || btn;   // move the whole | + 🌐 cluster, not just the button
    var sep = document.querySelector('.hdrsep');             // the | on its own, nudged relative to the cluster
    var lblEl = document.getElementById('th108LangLabel');   // the current-language text, nudged on its own
    applyOffset(host, 'th108_langoff');   // baked default, or a saved nudge
    applyOffset(sep, 'th108_sepoff');
    applyOffset(lblEl, 'th108_lbloff');
    if (/[?&]langtune=1/.test(location.search)) buildLangTuner(host, sep, lblEl);
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
    var saved = null; try { saved = localStorage.getItem(LS_KEY); } catch (_) {}
    // First visit (no saved choice) defaults to 'system' — follow the OS locale. A saved specific code wins.
    sel = (saved && (saved === 'system' || LANGS.some(function (l) { return l.code === saved; }))) ? saved : 'system';
    buildDropdown();
    apply(sel);
    observe();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.TH108i18n = { apply: apply, LANGS: LANGS, CATALOG: CATALOG, retranslate: function () { translateTree(document.body, cur); } };
})();
