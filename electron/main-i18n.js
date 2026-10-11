'use strict';

/*
 * Strings shown by the main process itself (tray menu, tooltip, OS
 * notifications). The UI's translations.js is an ES module the main process
 * can't load, so these few live here, in the same 15 languages.
 *
 * Language: the one the user picked in Settings, else the first OS language
 * we support (same rule as the UI), else English.
 */

const STRINGS = {
  en: { open: 'Open Shroudly', status: 'Status', active: 'Active', inactive: 'Inactive', start: 'Start protection', stop: 'Stop protection', quit: 'Quit', minimized: 'Shroudly keeps running in the tray', started: 'Protection is on', stopped: 'Protection is off', updateReady: 'Version {version} is ready. Shroudly will restart to install it.' },
  zh: { open: '打开 Shroudly', status: '状态', active: '已启用', inactive: '未启用', start: '开启保护', stop: '停止保护', quit: '退出', minimized: 'Shroudly 仍在系统托盘中运行', started: '保护已开启', stopped: '保护已关闭', updateReady: '版本 {version} 已就绪，Shroudly 将重启以完成安装。' },
  hi: { open: 'Shroudly खोलें', status: 'स्थिति', active: 'सक्रिय', inactive: 'निष्क्रिय', start: 'सुरक्षा शुरू करें', stop: 'सुरक्षा बंद करें', quit: 'बाहर निकलें', minimized: 'Shroudly ट्रे में चलता रहेगा', started: 'सुरक्षा चालू है', stopped: 'सुरक्षा बंद है', updateReady: 'संस्करण {version} तैयार है। इसे इंस्टॉल करने के लिए Shroudly फिर से शुरू होगा।' },
  es: { open: 'Abrir Shroudly', status: 'Estado', active: 'Activo', inactive: 'Inactivo', start: 'Activar protección', stop: 'Detener protección', quit: 'Salir', minimized: 'Shroudly sigue funcionando en la bandeja', started: 'Protección activada', stopped: 'Protección desactivada', updateReady: 'La versión {version} está lista. Shroudly se reiniciará para instalarla.' },
  ar: { open: 'فتح Shroudly', status: 'الحالة', active: 'نشط', inactive: 'غير نشط', start: 'تشغيل الحماية', stop: 'إيقاف الحماية', quit: 'خروج', minimized: 'يستمر Shroudly في العمل من شريط النظام', started: 'الحماية مفعّلة', stopped: 'الحماية متوقفة', updateReady: 'الإصدار {version} جاهز. سيُعاد تشغيل Shroudly لتثبيته.' },
  ru: { open: 'Открыть Shroudly', status: 'Статус', active: 'Активна', inactive: 'Неактивна', start: 'Включить защиту', stop: 'Остановить защиту', quit: 'Выйти', minimized: 'Shroudly продолжает работать в трее', started: 'Защита включена', stopped: 'Защита выключена', updateReady: 'Версия {version} готова. Shroudly перезапустится, чтобы установить её.' },
  pt: { open: 'Abrir o Shroudly', status: 'Estado', active: 'Ativo', inactive: 'Inativo', start: 'Ativar proteção', stop: 'Parar proteção', quit: 'Sair', minimized: 'O Shroudly continua em execução na bandeja', started: 'Proteção ativada', stopped: 'Proteção desativada', updateReady: 'A versão {version} está pronta. O Shroudly será reiniciado para instalá-la.' },
  fr: { open: 'Ouvrir Shroudly', status: 'État', active: 'Actif', inactive: 'Inactif', start: 'Activer la protection', stop: 'Arrêter la protection', quit: 'Quitter', minimized: 'Shroudly reste actif dans la zone de notification', started: 'Protection activée', stopped: 'Protection désactivée', updateReady: 'La version {version} est prête. Shroudly va redémarrer pour l’installer.' },
  fa: { open: 'باز کردن Shroudly', status: 'وضعیت', active: 'فعال', inactive: 'غیرفعال', start: 'شروع محافظت', stop: 'توقف محافظت', quit: 'خروج', minimized: 'Shroudly در سینی سیستم به کار خود ادامه می‌دهد', started: 'محافظت روشن است', stopped: 'محافظت خاموش است', updateReady: 'نسخهٔ {version} آماده است. Shroudly برای نصب آن دوباره راه‌اندازی می‌شود.' },
  tr: { open: "Shroudly'yi aç", status: 'Durum', active: 'Etkin', inactive: 'Devre dışı', start: 'Korumayı başlat', stop: 'Korumayı durdur', quit: 'Çıkış', minimized: 'Shroudly sistem tepsisinde çalışmaya devam ediyor', started: 'Koruma açık', stopped: 'Koruma kapalı', updateReady: 'Sürüm {version} hazır. Kurmak için Shroudly yeniden başlatılacak.' },
  bn: { open: 'Shroudly খুলুন', status: 'অবস্থা', active: 'সক্রিয়', inactive: 'নিষ্ক্রিয়', start: 'সুরক্ষা চালু করুন', stop: 'সুরক্ষা বন্ধ করুন', quit: 'প্রস্থান', minimized: 'Shroudly ট্রেতে চলতে থাকবে', started: 'সুরক্ষা চালু আছে', stopped: 'সুরক্ষা বন্ধ আছে', updateReady: 'সংস্করণ {version} প্রস্তুত। এটি ইনস্টল করতে Shroudly আবার চালু হবে।' },
  ur: { open: 'Shroudly کھولیں', status: 'حالت', active: 'فعال', inactive: 'غیر فعال', start: 'تحفظ شروع کریں', stop: 'تحفظ بند کریں', quit: 'باہر نکلیں', minimized: 'Shroudly سسٹم ٹرے میں چلتا رہے گا', started: 'تحفظ آن ہے', stopped: 'تحفظ بند ہے', updateReady: 'ورژن {version} تیار ہے۔ اسے انسٹال کرنے کے لیے Shroudly دوبارہ شروع ہوگا۔' },
  id: { open: 'Buka Shroudly', status: 'Status', active: 'Aktif', inactive: 'Tidak aktif', start: 'Mulai perlindungan', stop: 'Hentikan perlindungan', quit: 'Keluar', minimized: 'Shroudly tetap berjalan di baki sistem', started: 'Perlindungan aktif', stopped: 'Perlindungan nonaktif', updateReady: 'Versi {version} siap. Shroudly akan dimulai ulang untuk memasangnya.' },
  ja: { open: 'Shroudly を開く', status: 'ステータス', active: '有効', inactive: '無効', start: '保護を開始', stop: '保護を停止', quit: '終了', minimized: 'Shroudly はトレイで実行を続けます', started: '保護がオンになりました', stopped: '保護がオフになりました', updateReady: 'バージョン {version} の準備ができました。インストールのため Shroudly を再起動します。' },
  de: { open: 'Shroudly öffnen', status: 'Status', active: 'Aktiv', inactive: 'Inaktiv', start: 'Schutz starten', stop: 'Schutz beenden', quit: 'Beenden', minimized: 'Shroudly läuft im Infobereich weiter', started: 'Schutz ist aktiv', stopped: 'Schutz ist aus', updateReady: 'Version {version} ist bereit. Shroudly startet neu, um sie zu installieren.' },
};

const ALIASES = { in: 'id' }; // legacy Indonesian tag

/* "tr-TR" / "zh_Hant_TW" / "pt-BR" -> a supported code, or null. */
function matchLanguage(tag) {
  if (!tag) return null;
  let base = String(tag).split(/[-_]/)[0].toLowerCase();
  base = ALIASES[base] || base;
  return STRINGS[base] ? base : null;
}

function resolveLanguage(saved, systemLanguages) {
  if (saved && STRINGS[saved]) return saved;
  for (const tag of systemLanguages || []) {
    const code = matchLanguage(tag);
    if (code) return code;
  }
  return 'en';
}

function strings(lang) { return STRINGS[lang] || STRINGS.en; }

module.exports = { resolveLanguage, strings };
