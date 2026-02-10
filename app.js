/* Demumu-like Safety Check-in (Static SPA for GitHub Pages)
   - No real email sending (static). Uses mailto + optional webhook POST.
   - Stores everything in localStorage.
   - Defensive event binding (won't crash if an element id is missing).
*/

const STORE = {
  theme: "demumu_theme",
  profile: "demumu_profile",
  history: "demumu_history",
};

const DEFAULTS = {
  profile: {
    name: "",
    thresholdHours: 24,
    contactsText: "",
    webhookUrl: "",
    lastCheckinAt: null, // ms epoch
    lastWarnAt: null,    // ms epoch
    lastAlertAt: null,   // ms epoch
  }
};

// DOM helpers
const $ = (id) => document.getElementById(id);
const show = (el) => { if(el) el.hidden = false; };
const hide = (el) => { if(el) el.hidden = true; };

// Defensive binding: prevents total app death if one id is missing
const on = (id, event, fn, opts) => {
  const el = $(id);
  if (!el) return false;
  el.addEventListener(event, fn, opts);
  return true;
};

function now() { return Date.now(); }

function loadJson(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    if(!raw) return fallback;
    return JSON.parse(raw);
  }catch{
    return fallback;
  }
}
function saveJson(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

function fmtDate(ms){
  if(!ms) return "—";
  const d = new Date(ms);
  const pad = (n)=> String(n).padStart(2,"0");
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtElapsed(hours){
  if(hours == null) return "—";
  if(hours < 1) return `${Math.max(0, Math.floor(hours*60))}分`;
  if(hours < 48) return `${hours.toFixed(1)}時間`;
  return `${(hours/24).toFixed(1)}日`;
}

function normalizeContacts(text){
  const lines = (text || "")
    .split("\n")
    .map(s=>s.trim())
    .filter(Boolean);
  return Array.from(new Set(lines));
}

function getProfile(){
  const p = loadJson(STORE.profile, null);
  if(!p) return structuredClone(DEFAULTS.profile);
  return { ...structuredClone(DEFAULTS.profile), ...p };
}
function setProfile(p){ saveJson(STORE.profile, p); }

function getHistory(){ return loadJson(STORE.history, []); }
function addHistory(type, title, meta = {}){
  const h = getHistory();
  h.unshift({
    id: crypto?.randomUUID?.() ?? String(Math.random()),
    at: now(),
    type,
    title,
    meta
  });
  saveJson(STORE.history, h.slice(0, 200));
}

function log(line){
  const el = $("log");
  if(!el) return;
  const ts = fmtDate(now());
  el.textContent = `[${ts}] ${line}\n` + el.textContent;
}

// Views
const views = {
  onboarding: $("viewOnboarding"),
  home: $("viewHome"),
  history: $("viewHistory"),
  settings: $("viewSettings"),
};

// Sheet
const sheet = {
  root: $("alertSheet"),
  title: $("sheetTitle"),
  msg: $("sheetMsg"),
  meta: $("sheetMeta"),
  close: $("btnCloseSheet"),
  checkin: $("btnSheetCheckin"),
  mail: $("btnSheetMail"),
  webhook: $("btnSheetWebhook"),
};

function setTheme(theme){
  document.documentElement.dataset.theme = theme;
  localeStorageSafeSet(STORE.theme, theme);
}
function initTheme(){
  const saved = localStorage.getItem(STORE.theme);
  if(saved){
    document.documentElement.dataset.theme = saved;
    return;
  }
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches;
  document.documentElement.dataset.theme = prefersLight ? "light" : "dark";
  localStorage.setItem(STORE.theme, document.documentElement.dataset.theme);
}
function toggleTheme(){
  const cur = document.documentElement.dataset.theme || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(STORE.theme, next);
}

function route(viewName){
  Object.values(views).forEach(hide);
  show(views[viewName]);
}

function isConfigured(profile){
  const contacts = normalizeContacts(profile.contactsText);
  return Number(profile.thresholdHours) > 0 && contacts.length > 0;
}

// Status model:
// OK: elapsed < 0.7*threshold
// WARN: 0.7*threshold <= elapsed < threshold
// ALERT: elapsed >= threshold
function computeStatus(profile){
  const th = Number(profile.thresholdHours || 24);
  const last = profile.lastCheckinAt;
  if(!last) return { level: "none", label: "未チェックイン", th, elapsedH: null };

  const elapsedH = (now() - last) / (1000*60*60);
  if(elapsedH < th * 0.7) return { level: "ok", label: "連絡OK", th, elapsedH };
  if(elapsedH < th) return { level: "warn", label: "要注意", th, elapsedH };
  return { level: "bad", label: "連絡が取れていません", th, elapsedH };
}

function applyStatusToHome(profile){
  const st = computeStatus(profile);

  const dot = $("statusDot");
  const label = $("statusLabel");
  const pill = $("statusPill");
  const lastEl = $("lastCheckin");
  const elpEl = $("elapsed");
  const hint = $("homeHint");

  if(lastEl) lastEl.textContent = fmtDate(profile.lastCheckinAt);
  if(elpEl) elpEl.textContent = fmtElapsed(st.elapsedH);
  if(label) label.textContent = st.label;

  if(dot){
    dot.style.background =
      st.level === "ok" ? "var(--ok)" :
      st.level === "warn" ? "var(--warn)" :
      st.level === "bad" ? "var(--bad)" :
      "var(--muted)";
  }

  if(pill){
    pill.style.borderColor =
      st.level === "ok" ? "rgba(54,211,153,.35)" :
      st.level === "warn" ? "rgba(251,191,36,.35)" :
      st.level === "bad" ? "rgba(251,113,133,.35)" :
      "var(--stroke)";
  }

  if(hint){
    if(st.level === "warn"){
      hint.textContent = `そろそろ押してください（閾値 ${st.th}h）。このまま未チェックインだと通知が走ります。`;
    }else if(st.level === "bad"){
      hint.textContent = `閾値 ${st.th}h を超えています。通知が必要です。安全なら「いま押す」で復旧できます。`;
    }else if(st.level === "none"){
      hint.textContent = `最初のチェックインを行ってください。以後、押されない場合のみ通知が走ります。`;
    }else{
      hint.textContent = `いつ押してもOK。押されない場合のみ通知が走ります。`;
    }
  }

  renderContacts(profile);
}

function renderContacts(profile){
  const chips = $("contactChips");
  const hint = $("contactHint");
  const tagWebhook = $("tagWebhook");

  const contacts = normalizeContacts(profile.contactsText);

  if(chips) chips.innerHTML = "";

  if(contacts.length === 0){
    if(hint) hint.textContent = "通知先が未設定です（設定から追加してください）";
  }else{
    if(hint) hint.textContent = `${contacts.length}件登録`;
    if(chips){
      for(const c of contacts.slice(0, 10)){
        const div = document.createElement("div");
        div.className = "chip";
        div.textContent = c;
        chips.appendChild(div);
      }
      if(contacts.length > 10){
        const div = document.createElement("div");
        div.className = "chip";
        div.textContent = `+${contacts.length - 10}`;
        chips.appendChild(div);
      }
    }
  }

  if(tagWebhook){
    if(profile.webhookUrl && profile.webhookUrl.trim()){
      tagWebhook.textContent = "Webhook：設定済";
      tagWebhook.style.borderColor = "rgba(125,211,252,.35)";
    }else{
      tagWebhook.textContent = "Webhook：未設定";
      tagWebhook.style.borderColor = "var(--stroke)";
    }
  }
}

function openSheet({title, msg, meta, showWebhook}){
  if(sheet.title) sheet.title.textContent = title;
  if(sheet.msg) sheet.msg.textContent = msg;
  if(sheet.meta) sheet.meta.textContent = meta || "";
  show(sheet.root);

  if(sheet.webhook){
    sheet.webhook.disabled = !showWebhook;
    sheet.webhook.title = showWebhook ? "" : "Webhook未設定";
  }
}
function closeSheet(){ hide(sheet.root); }

function buildNotifyText(profile, reason){
  const nm = profile.name?.trim() || "本人";
  const last = profile.lastCheckinAt ? fmtDate(profile.lastCheckinAt) : "—";
  const st = computeStatus(profile);
  const elapsed = st.elapsedH == null ? "—" : fmtElapsed(st.elapsedH);

  const subject = `【重要】${nm}さんと連絡が取れていません`;
  const body =
`連絡が取れていません。念のため確認してください。

対象：${nm}
最終チェックイン：${last}
経過：${elapsed}
理由：${reason}

推奨対応：
1) まず電話
2) 反応がなければ訪問/近隣へ確認
3) 緊急性があれば然るべき窓口へ

（この通知は静的デモのため、アプリ内トリガを再現しています）
`;
  return { subject, body };
}

function mailtoAll(profile, reason){
  const contacts = normalizeContacts(profile.contactsText);
  if(contacts.length === 0){
    openSheet({
      title: "通知先が未設定です",
      msg: "設定からメールアドレスを追加してください。",
      meta: "",
      showWebhook: Boolean(profile.webhookUrl?.trim())
    });
    return;
  }
  const { subject, body } = buildNotifyText(profile, reason);

  const to = encodeURIComponent(contacts.join(","));
  const u = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = u;

  addHistory("mailto", "メール通知（mailto）を作成", { reason, contactsCount: contacts.length });
  log(`📨 mailto起動：${contacts.length}件（理由: ${reason}）`);
}

async function postWebhook(profile, reason){
  const url = (profile.webhookUrl || "").trim();
  if(!url){
    openSheet({
      title: "Webhookが未設定です",
      msg: "設定でWebhook URLを入力してください。",
      meta: "",
      showWebhook: false
    });
    return false;
  }

  const payload = {
    app: "demumu-static",
    at: new Date().toISOString(),
    reason,
    profile: {
      name: profile.name || "",
      thresholdHours: Number(profile.thresholdHours || 24),
      lastCheckinAt: profile.lastCheckinAt,
    },
    computed: computeStatus(profile)
  };

  try{
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    addHistory("webhook", "Webhook通知（POST）送信", { reason, url });
    log(`🔔 Webhook送信成功（理由: ${reason}）`);
    return true;
  }catch(e){
    addHistory("webhook_fail", "Webhook通知（POST）失敗", { reason, url, error: String(e) });
    log(`⚠ Webhook送信失敗：${String(e)}`);
    openSheet({
      title: "Webhook送信に失敗しました",
      msg: "受信側のCORS設定やURLを確認してください。失敗は履歴とログに保存しました。",
      meta: `URL: ${url}`,
      showWebhook: true
    });
    return false;
  }
}

function doCheckin(profile){
  profile.lastCheckinAt = now();
  profile.lastWarnAt = null;
  profile.lastAlertAt = null;
  setProfile(profile);

  addHistory("checkin", "チェックイン", { at: profile.lastCheckinAt });
  log("✅ チェックイン：ボタンが押されました");
  applyStatusToHome(profile);

  if("Notification" in window && Notification.permission === "granted"){
    new Notification("チェックイン完了", { body: "今日の安全記録を更新しました。" });
  }
}

function maybeFireWarningOrAlert(profile){
  const st = computeStatus(profile);
  const th = st.th;

  if(st.level === "warn"){
    const already = profile.lastWarnAt && (now() - profile.lastWarnAt) < (6 * 60 * 60 * 1000);
    if(!already){
      profile.lastWarnAt = now();
      setProfile(profile);
      addHistory("warn", "警告：そろそろチェックイン", { elapsedH: st.elapsedH, thresholdHours: th });
      log(`⚠ 警告：経過 ${fmtElapsed(st.elapsedH)} / 閾値 ${th}h`);
      if("Notification" in window && Notification.permission === "granted"){
        new Notification("そろそろチェックイン", {
          body: `最後のチェックインから ${fmtElapsed(st.elapsedH)} 経過しています。`,
        });
      }
      openSheet({
        title: "⚠ 要注意",
        msg: `しばらく押されていません。このまま（${th}時間）未チェックインだと通知が走ります。`,
        meta: `最終：${fmtDate(profile.lastCheckinAt)} / 経過：${fmtElapsed(st.elapsedH)}`,
        showWebhook: Boolean(profile.webhookUrl?.trim())
      });
    }
    return;
  }

  if(st.level === "bad"){
    const already = profile.lastAlertAt && (now() - profile.lastAlertAt) < (12 * 60 * 60 * 1000);
    if(!already){
      profile.lastAlertAt = now();
      setProfile(profile);
      addHistory("alert", "通知条件到達：連絡が取れていません", { elapsedH: st.elapsedH, thresholdHours: th });
      log(`🚨 通知条件到達：経過 ${fmtElapsed(st.elapsedH)} / 閾値 ${th}h`);
      if("Notification" in window && Notification.permission === "granted"){
        new Notification("連絡が取れていません", {
          body: `最後のチェックインから ${fmtElapsed(st.elapsedH)} 経過。連絡先へ通知してください。`,
        });
      }
      openSheet({
        title: "🚨 連絡が取れていません",
        msg: "登録した連絡先へ通知してください（この静的版は mailto / webhook で実行）。安全なら「無事です」で復旧。",
        meta: `最終：${fmtDate(profile.lastCheckinAt)} / 経過：${fmtElapsed(st.elapsedH)}`,
        showWebhook: Boolean(profile.webhookUrl?.trim())
      });
    }
  }
}

function renderHistory(){
  const list = $("historyList");
  const h = getHistory();
  if(!list) return;

  list.innerHTML = "";

  if(h.length === 0){
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<div><div class="itemTitle">履歴はありません</div><div class="itemMeta">チェックインや通知を行うとここに表示されます</div></div>`;
    list.appendChild(div);
    return;
  }

  for(const it of h){
    const div = document.createElement("div");
    div.className = "item";
    const meta = [fmtDate(it.at), it.type].filter(Boolean).join(" • ");
    div.innerHTML = `
      <div>
        <div class="itemTitle">${escapeHtml(it.title)}</div>
        <div class="itemMeta">${escapeHtml(meta)}</div>
      </div>
      <div class="itemMeta">${escapeHtml(it.meta?.reason || "")}</div>
    `;
    list.appendChild(div);
  }
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function syncSettingsUI(profile){
  if($("obName")) $("obName").value = profile.name || "";
  if($("obThreshold")) $("obThreshold").value = String(profile.thresholdHours || 24);
  if($("obContacts")) $("obContacts").value = profile.contactsText || "";

  if($("stName")) $("stName").value = profile.name || "";
  if($("stThreshold")) $("stThreshold").value = String(profile.thresholdHours || 24);
  if($("stContacts")) $("stContacts").value = profile.contactsText || "";
  if($("stWebhook")) $("stWebhook").value = profile.webhookUrl || "";

  updateNotiState();
}

function updateNotiState(){
  const el = $("notiState");
  const btn = $("btnEnableNoti");
  if(!el) return;

  if(!("Notification" in window)){
    el.textContent = "このブラウザは通知に対応していません。";
    if(btn) btn.disabled = true;
    return;
  }
  el.textContent = `通知権限：${Notification.permission}`;
}

function exportSettings(profile){
  const data = {
    exportedAt: new Date().toISOString(),
    profile: {
      name: profile.name || "",
      thresholdHours: Number(profile.thresholdHours || 24),
      contactsText: profile.contactsText || "",
      webhookUrl: profile.webhookUrl || "",
    }
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "demumu-settings.json";
  a.click();
  URL.revokeObjectURL(a.href);
  addHistory("export", "設定をエクスポート");
  log("⬇ 設定をエクスポートしました");
}

async function importSettings(file){
  const txt = await file.text();
  const obj = JSON.parse(txt);
  const p = getProfile();
  const np = obj?.profile || {};
  p.name = String(np.name || "");
  p.thresholdHours = Number(np.thresholdHours || 24);
  p.contactsText = String(np.contactsText || "");
  p.webhookUrl = String(np.webhookUrl || "");
  setProfile(p);
  addHistory("import", "設定をインポート");
  log("⬆ 設定をインポートしました");
  return p;
}

function init(){
  initTheme();

  let profile = getProfile();

  // Routes
  if(!isConfigured(profile)){
    route("onboarding");
  }else{
    route("home");
  }

  syncSettingsUI(profile);
  applyStatusToHome(profile);

  // Top actions
  on("btnTheme", "click", (e) => { e.preventDefault(); toggleTheme(); });
  on("btnSettings", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    syncSettingsUI(profile);
    route("settings");
  });

  // Onboarding start
  on("obStart", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    profile.name = $("obName")?.value?.trim?.() ?? "";
    profile.thresholdHours = Number($("obThreshold")?.value || 24);
    profile.contactsText = $("obContacts")?.value ?? "";
    setProfile(profile);
    addHistory("setup", "初期設定完了", { thresholdHours: profile.thresholdHours });
    log("✨ 初期設定を完了しました");
    route("home");
    applyStatusToHome(profile);
  });

  // Home
  on("btnCheckin", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    doCheckin(profile);
  });

  on("btnHistory", "click", (e) => {
    e.preventDefault();
    renderHistory();
    route("history");
  });

  on("btnTestNotify", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    openSheet({
      title: "テスト通知",
      msg: "通知の動作確認です。mail / webhook を試せます。",
      meta: "",
      showWebhook: Boolean(profile.webhookUrl?.trim())
    });
  });

  // History
  on("btnBackFromHistory", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    route("home");
    applyStatusToHome(profile);
  });

  on("btnClearHistory", "click", (e) => {
    e.preventDefault();
    saveJson(STORE.history, []);
    log("🧹 履歴を消去しました");
    renderHistory();
  });

  // Settings close
  on("btnCloseSettings", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    route(isConfigured(profile) ? "home" : "onboarding");
    applyStatusToHome(profile);
  });

  // Settings inputs autosave
  const saveSettings = () => {
    const p = getProfile();
    p.name = $("stName")?.value?.trim?.() ?? "";
    p.thresholdHours = Number($("stThreshold")?.value || 24);
    p.contactsText = $("stContacts")?.value ?? "";
    p.webhookUrl = $("stWebhook")?.value?.trim?.() ?? "";
    setProfile(p);
    applyStatusToHome(p);
    return p;
  };

  ["stName","stThreshold","stContacts","stWebhook"].forEach(id=>{
    on(id, "input", () => { profile = saveSettings(); });
    on(id, "change", () => { profile = saveSettings(); });
  });

  // Notifications
  on("btnEnableNoti", "click", async (e) => {
    e.preventDefault();
    if(!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    addHistory("noti", "通知権限変更", { permission: perm });
    log(`🔔 通知権限：${perm}`);
    updateNotiState();
  });

  // Export / Import / Reset
  on("btnExport", "click", (e) => {
    e.preventDefault();
    exportSettings(getProfile());
  });

  on("fileImport", "change", async (e) => {
    const f = e.target.files?.[0];
    if(!f) return;
    profile = await importSettings(f);
    syncSettingsUI(profile);
    route("home");
    applyStatusToHome(profile);
    e.target.value = "";
  });

  on("btnResetAll", "click", (e) => {
    e.preventDefault();
    if(!confirm("全てのデータ（設定・履歴・チェックイン）を削除します。よろしいですか？")) return;
    localStorage.removeItem(STORE.profile);
    localStorage.removeItem(STORE.history);
    log("🧹 全リセットしました");
    profile = getProfile();
    syncSettingsUI(profile);
    route("onboarding");
  });

  // Sheet actions
  on("btnCloseSheet", "click", (e) => { e.preventDefault(); closeSheet(); });

  on("btnSheetCheckin", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    doCheckin(profile);
    closeSheet();
  });

  on("btnSheetMail", "click", (e) => {
    e.preventDefault();
    profile = getProfile();
    mailtoAll(profile, "アプリ内トリガ（警告/通知/テスト）");
  });

  on("btnSheetWebhook", "click", async (e) => {
    e.preventDefault();
    profile = getProfile();
    await postWebhook(profile, "アプリ内トリガ（警告/通知/テスト）");
  });

  // Escape closes sheet
  window.addEventListener("keydown", (e) => {
    if(e.key === "Escape" && sheet.root && !sheet.root.hidden) closeSheet();
  });

  // Periodic monitor while app is open
  setInterval(() => {
    const p = getProfile();
    maybeFireWarningOrAlert(p);
    applyStatusToHome(p);
  }, 30_000);

  // Initial monitor
  setTimeout(() => {
    const p = getProfile();
    maybeFireWarningOrAlert(p);
    applyStatusToHome(p);
  }, 900);

  if(!profile.lastCheckinAt){
    log("ℹ 最初のチェックインをしてください。以後、押されない場合のみ通知が走ります。");
  }
}

function setTheme(theme){
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORE.theme, theme);
}

document.addEventListener("DOMContentLoaded", init);
