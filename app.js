/* Demumu-like Safety Check-in (Static SPA for GitHub Pages)
   - No real email sending (static). Uses mailto + optional webhook POST.
   - Stores everything in localStorage.
*/

const STORE = {
  version: "demumu_v1",
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
    lastCheckinAt: null,      // ms epoch
    lastWarnAt: null,         // ms epoch (warning shown)
    lastAlertAt: null,        // ms epoch (alert triggered)
  }
};

// --- DOM helpers
const $ = (id) => document.getElementById(id);
const show = (el) => { el.hidden = false; };
const hide = (el) => { el.hidden = true; };

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
  const days = hours / 24;
  return `${days.toFixed(1)}日`;
}

function normalizeContacts(text){
  const lines = (text || "")
    .split("\n")
    .map(s=>s.trim())
    .filter(Boolean);
  // de-dup
  return Array.from(new Set(lines));
}

function getProfile(){
  const p = loadJson(STORE.profile, null);
  if(!p) return structuredClone(DEFAULTS.profile);
  return { ...structuredClone(DEFAULTS.profile), ...p };
}
function setProfile(p){
  saveJson(STORE.profile, p);
}

function getHistory(){
  return loadJson(STORE.history, []);
}
function addHistory(type, title, meta = {}){
  const h = getHistory();
  h.unshift({
    id: crypto?.randomUUID?.() ?? String(Math.random()),
    at: now(),
    type, title, meta
  });
  saveJson(STORE.history, h.slice(0, 200));
}

function log(line){
  const el = $("log");
  if(!el) return;
  const ts = fmtDate(now());
  el.textContent = `[${ts}] ${line}\n` + el.textContent;
}

// --- UI references
const views = {
  onboarding: $("viewOnboarding"),
  home: $("viewHome"),
  history: $("viewHistory"),
  settings: $("viewSettings"),
};
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
  localStorage.setItem(STORE.theme, theme);
}
function initTheme(){
  const saved = localStorage.getItem(STORE.theme);
  if(saved){
    setTheme(saved);
    return;
  }
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches;
  setTheme(prefersLight ? "light" : "dark");
}

function route(viewName){
  for(const k of Object.keys(views)) hide(views[k]);
  show(views[viewName]);
}

function isConfigured(profile){
  // Minimal viable: threshold + at least one contact line (email-like or anything)
  const contacts = normalizeContacts(profile.contactsText);
  return Number(profile.thresholdHours) > 0 && contacts.length > 0;
}

// Status model (Demumu-like):
// - OK: elapsed < 0.7 * threshold
// - WARN: 0.7*threshold <= elapsed < threshold
// - ALERT: elapsed >= threshold
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

  lastEl.textContent = fmtDate(profile.lastCheckinAt);
  elpEl.textContent = fmtElapsed(st.elapsedH);

  label.textContent = st.label;

  // set colors
  dot.style.background = st.level === "ok" ? "var(--ok)"
    : st.level === "warn" ? "var(--warn)"
    : st.level === "bad" ? "var(--bad)"
    : "var(--muted)";

  pill.style.borderColor =
    st.level === "ok" ? "rgba(109,255,156,.35)"
    : st.level === "warn" ? "rgba(255,211,110,.35)"
    : st.level === "bad" ? "rgba(255,92,122,.35)"
    : "var(--stroke)";

  if(st.level === "warn"){
    hint.textContent = `そろそろ押してください（閾値 ${st.th}h）。このまま未チェックインだと通知が走ります。`;
  }else if(st.level === "bad"){
    hint.textContent = `閾値 ${st.th}h を超えています。通知が必要です。安全なら「いま押す」で復旧できます。`;
  }else if(st.level === "none"){
    hint.textContent = `最初のチェックインを行ってください。以後、押されない場合のみ通知が走ります。`;
  }else{
    hint.textContent = `いつ押してもOK。押されない場合のみ通知が走ります。`;
  }

  renderContacts(profile);
}

function renderContacts(profile){
  const chips = $("contactChips");
  const hint = $("contactHint");
  const tagWebhook = $("tagWebhook");

  const contacts = normalizeContacts(profile.contactsText);
  chips.innerHTML = "";
  if(contacts.length === 0){
    hint.textContent = "通知先が未設定です（設定から追加してください）";
  }else{
    hint.textContent = `${contacts.length}件登録`;
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

  if(profile.webhookUrl && profile.webhookUrl.trim()){
    tagWebhook.textContent = "Webhook：設定済";
    tagWebhook.style.borderColor = "rgba(110,231,255,.35)";
  }else{
    tagWebhook.textContent = "Webhook：未設定";
    tagWebhook.style.borderColor = "var(--stroke)";
  }
}

function openSheet({title, msg, meta, showWebhook}){
  sheet.title.textContent = title;
  sheet.msg.textContent = msg;
  sheet.meta.textContent = meta || "";
  show(sheet.root);

  sheet.webhook.disabled = !showWebhook;
  sheet.webhook.title = showWebhook ? "" : "Webhook未設定";
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

  // mailto: supports single "to" list separated by commas (not always reliable for many)
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
    return;
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
    new Notification("チェックイン完了", {
      body: "今日の安全記録を更新しました。",
    });
  }
}

function maybeFireWarningOrAlert(profile){
  const st = computeStatus(profile);
  const th = st.th;

  // For accuracy, rely on periodic checks while app is open.
  // When closed, cannot guarantee on static hosting (no server).
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
    const t = new Date(it.at);
    const meta = [
      fmtDate(it.at),
      it.type
    ].filter(Boolean).join(" • ");
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
  // Onboarding
  if($("obName")) $("obName").value = profile.name || "";
  if(
