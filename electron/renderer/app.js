const $ = (id) => document.getElementById(id);

const COUNT_LABELS = [
  ["total", "Всего"],
  ["pending", "Ожидают"],
  ["ready", "Готовы"],
  ["updated", "Обновлены"],
  ["skipped", "Пропущены"],
  ["not_found", "Не найдены"],
  ["failed", "Ошибки"],
  ["tasnif_failed", "Сбой Tasnif"],
];

let state = null;
let toastTimer = null;
let groups = [];
let allGroups = [];
let vatRates = [];
let selectedGroupIdValue = null;
let selectedGroupMeta = null;
let groupHighlight = 0;
let groupListOpen = false;
let groupSearchTimer = null;
let groupSearchToken = 0;
let groupSearching = false;
let persistTimer = null;
let applyingState = false;
let lastRunArgs = null;
let activeRunKind = null;

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function selectedRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function setRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function appendLog(line) {
  const log = $("log");
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

function renderCounts(counts) {
  $("counts").innerHTML = COUNT_LABELS.map(
    ([key, label]) =>
      `<div class="count"><b>${counts?.[key] ?? 0}</b><span>${label}</span></div>`,
  ).join("");
}

function formatVatLabel(rate) {
  const name = rate.name?.trim();
  if (name) return `${rate.id} — ${name}`;
  if (rate.value === -1) return `${rate.id} — Без НДС`;
  if (rate.value !== null && rate.value !== undefined) return `${rate.id} — ${rate.value}%`;
  return `НДС ${rate.id}`;
}

function selectedVatId() {
  const value = $("vatSelect").value;
  if (!value) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function renderVatOptions(selectedId) {
  const current = selectedId ?? selectedVatId();
  const options = ['<option value="">Выберите ставку НДС</option>'];
  const seen = new Set();
  for (const rate of vatRates) {
    seen.add(String(rate.id));
    options.push(`<option value="${rate.id}">${escapeHtml(formatVatLabel(rate))}</option>`);
  }
  if (current && !seen.has(String(current))) {
    options.push(`<option value="${current}">${escapeHtml(`${current} — выбранная ставка`)}</option>`);
  }
  $("vatSelect").innerHTML = options.join("");
  $("vatSelect").value = current ? String(current) : "";
}

function groupLabel(group) {
  return group.path || group.name || `Группа ${group.id}`;
}

function selectedLabel() {
  if (!selectedGroupIdValue) return "Все группы";
  if (selectedGroupMeta) return `${selectedGroupIdValue} — ${groupLabel(selectedGroupMeta)}`;
  return `${selectedGroupIdValue} — выбранная группа`;
}

function selectedGroupId() {
  return selectedGroupIdValue;
}

function setSelectedGroup(id, meta = null) {
  selectedGroupIdValue = id;
  selectedGroupMeta = meta && meta.id === id ? meta : id ? selectedGroupMeta : null;
  $("groupSelected").textContent = selectedLabel();
  if (!groupListOpen) $("groupSearch").value = id ? selectedLabel() : "";
}

function listItems() {
  return [{ id: null, all: true }, ...groups];
}

function closeGroupList() {
  groupListOpen = false;
  $("groupList").classList.add("hidden");
  $("groupCombobox").classList.remove("open");
  $("groupSearch").setAttribute("aria-expanded", "false");
  $("groupSearch").value = selectedGroupIdValue ? selectedLabel() : "";
}

function renderGroupList() {
  const list = $("groupList");
  const items = listItems();
  if (groupHighlight >= items.length) groupHighlight = Math.max(0, items.length - 1);
  if (groupSearching) {
    list.innerHTML = `<li class="combobox-empty">Загрузка групп…</li>`;
    return;
  }
  if (items.length === 1 && groups.length === 0) {
    const query = $("groupSearch").value.trim();
    const empty = query && query !== selectedLabel()
      ? "Ничего не найдено"
      : allGroups.length === 0
        ? "Группы ещё не загружены"
        : "Начните вводить название или ID";
    list.innerHTML = `<li class="combobox-option${groupHighlight === 0 ? " active" : ""}${selectedGroupIdValue ? "" : " current"}" role="option" data-index="0" data-id="">Все группы</li><li class="combobox-empty">${empty}</li>`;
    return;
  }

  list.innerHTML = items
    .map((item, index) => {
      const active = index === groupHighlight ? " active" : "";
      if (item.all) {
        const current = selectedGroupIdValue ? "" : " current";
        return `<li class="combobox-option${active}${current}" role="option" data-index="${index}" data-id="">Все группы</li>`;
      }
      const current = item.id === selectedGroupIdValue ? " current" : "";
      return `<li class="combobox-option${active}${current}" role="option" data-index="${index}" data-id="${item.id}">${escapeHtml(`${item.id} — ${groupLabel(item)}`)}</li>`;
    })
    .join("");

  list.querySelector(".combobox-option.active")?.scrollIntoView({ block: "nearest" });
}

function openGroupList() {
  groupListOpen = true;
  $("groupList").classList.remove("hidden");
  $("groupCombobox").classList.add("open");
  $("groupSearch").setAttribute("aria-expanded", "true");
  renderGroupList();
}

function chooseGroupAt(index) {
  const items = listItems();
  const item = items[index];
  if (!item) return;
  if (item.all) setSelectedGroup(null, null);
  else setSelectedGroup(item.id, item);
  closeGroupList();
  void persistSettings();
}

async function loadGroups() {
  if (!state?.hasToken) {
    allGroups = [];
    groups = [];
    if (groupListOpen) renderGroupList();
    return;
  }
  const token = ++groupSearchToken;
  groupSearching = true;
  if (groupListOpen) renderGroupList();
  const loaded = await withError(() => window.api.listGroups());
  if (token !== groupSearchToken) return;
  groupSearching = false;
  if (!loaded) return;
  allGroups = loaded;
  if (selectedGroupIdValue) {
    const match = allGroups.find((group) => group.id === selectedGroupIdValue);
    if (match) {
      selectedGroupMeta = match;
      if (!groupListOpen) setSelectedGroup(selectedGroupIdValue, match);
    }
  }
  applyGroupFilter();
}

function applyGroupFilter() {
  const query = $("groupSearch").value.trim();
  if (!query || query === selectedLabel()) {
    groups = allGroups;
  } else {
    const needle = query.toLowerCase();
    groups = allGroups.filter((group) => {
      const haystack = `${group.id} ${groupLabel(group)}`.toLowerCase();
      return haystack.includes(needle);
    });
  }
  groupHighlight = groups.length > 0 ? 1 : 0;
  if (groupListOpen) renderGroupList();
}

function scheduleGroupSearch() {
  clearTimeout(groupSearchTimer);
  groupSearchTimer = setTimeout(() => {
    applyGroupFilter();
  }, 80);
}

async function resolveSelectedGroupLabel(groupId) {
  if (!groupId || !state?.hasToken) return;
  if (selectedGroupMeta?.id === groupId) return;
  const match = allGroups.find((group) => group.id === groupId);
  if (match) {
    selectedGroupMeta = match;
    if (!groupListOpen) setSelectedGroup(groupId, match);
  }
}

function syncAuthMode() {
  const local = selectedRadio("authMode") === "local";
  $("oauthFields").classList.toggle("hidden", local);
}

function settingsWarning() {
  const mode = selectedRadio("mxikMode");
  const labeled = $("updateIsLabeled").checked;
  const el = $("settingsWarning");
  if (mode === "none" && !labeled) {
    el.textContent = "Выберите режим ИКПУ или включите is_labeled. Иначе в Regos ничего не будет записано.";
    el.classList.remove("hidden");
    return el.textContent;
  }
  el.classList.add("hidden");
  return "";
}

function setSaveHint(text) {
  $("saveHint").textContent = text;
}

function applyState(next) {
  applyingState = true;
  state = next;
  if (Array.isArray(next.lastRunArgs)) lastRunArgs = next.lastRunArgs;
  const { settings, secrets, counts, running, stopping, hasToken } = next;

  $("integrationToken").value = secrets.integrationToken ?? "";
  $("clientId").value = secrets.clientId ?? "";
  $("clientSecret").value = secrets.clientSecret ?? "";
  $("authUrl").value = secrets.authUrl ?? "";
  $("apiBase").value = secrets.apiBase ?? "";
  setRadio("authMode", secrets.clientId && secrets.clientSecret ? "oauth" : "local");
  syncAuthMode();

  setRadio("mxikMode", settings.mxikUpdateMode);
  $("updateIsLabeled").checked = Boolean(settings.updateIsLabeled);
  $("skipDeleted").checked = Boolean(settings.skipDeleted);
  $("skipServices").checked = Boolean(settings.skipServices);
  $("includeChildGroups").checked = settings.includeChildGroups !== false;
  if (!groupListOpen) {
    setSelectedGroup(selectedGroupIdValue ?? settings.groupId ?? null, selectedGroupMeta);
    void resolveSelectedGroupLabel(selectedGroupIdValue);
  }
  settingsWarning();

  renderCounts(counts);
  $("authBadge").textContent = hasToken
    ? secrets.clientId && secrets.clientSecret
      ? "OAuth"
      : "Локальный токен"
    : "Нет токена";
  $("authBadge").classList.toggle("ok", hasToken);
  setRunState({ running: Boolean(running), stopping: Boolean(stopping) });
  applyingState = false;
}

function lastRunTitle(args) {
  if (!args) return "Нет остановленного запуска";
  if (args[0] === "--fetch") return "Продолжить загрузку из Regos";
  if (args[0] === "--tasnif") return "Продолжить поиск в Tasnif";
  if (args[0] === "--update") return "Продолжить обновление Regos";
  return "Продолжить полное обновление";
}

function setRunState(payload) {
  const running = typeof payload === "boolean" ? payload : Boolean(payload?.running);
  const stopping = typeof payload === "boolean" ? false : Boolean(payload?.stopping);
  const blocked = running || stopping;

  $("runBadge").textContent = stopping ? "Остановка" : running ? "Выполняется" : "Ожидание";
  $("runBadge").classList.toggle("run", running && !stopping);
  $("runBadge").classList.toggle("stopping", stopping);

  $("startAll").disabled = blocked;
  $("startResume").disabled = blocked || !lastRunArgs;
  $("startResume").title = lastRunTitle(lastRunArgs);
  $("startFetch").disabled = blocked;
  $("startTasnif").disabled = blocked;
  $("startUpdate").disabled = blocked;
  $("startVat").disabled = blocked;
  $("startIcps").disabled = blocked;
  $("startLabeled").disabled = blocked;
  $("emptyDb").disabled = blocked;
  $("clearGroup").disabled = blocked;
  $("groupSearch").disabled = blocked;
  $("vatSelect").disabled = blocked;
  $("manualIcps").disabled = blocked;
  for (const input of document.querySelectorAll('input[name="manualLabeled"]')) {
    input.disabled = blocked;
  }
  if (!running && !stopping) activeRunKind = null;
  $("stop").disabled = !running || stopping || isBulkKind(activeRunKind);
  $("stopVat").disabled = !running || stopping || activeRunKind !== "vat";
  $("stopManual").disabled = !running || stopping || (activeRunKind !== "icps" && activeRunKind !== "labeled");
}

function currentSettings() {
  return {
    ...state.settings,
    mxikUpdateMode: selectedRadio("mxikMode"),
    updateIsLabeled: $("updateIsLabeled").checked,
    skipDeleted: $("skipDeleted").checked,
    skipServices: $("skipServices").checked,
    includeChildGroups: $("includeChildGroups").checked,
    groupId: selectedGroupId(),
  };
}

function currentSecrets() {
  const local = selectedRadio("authMode") === "local";
  return {
    integrationToken: $("integrationToken").value.trim(),
    clientId: local ? "" : $("clientId").value.trim(),
    clientSecret: local ? "" : $("clientSecret").value.trim(),
    authUrl: $("authUrl").value.trim(),
    apiBase: $("apiBase").value.trim(),
  };
}

async function persistSettings() {
  if (!state || applyingState) return;
  const warning = settingsWarning();
  if (warning) {
    setSaveHint("Не сохранено");
    return;
  }
  setSaveHint("Сохранение…");
  const next = await withError(() => window.api.saveSettings(currentSettings()));
  if (!next) {
    setSaveHint("Ошибка сохранения");
    return;
  }
  state.settings = next.settings;
  setSaveHint("Сохранено");
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistSettings();
  }, 200);
}

async function loadVatRates() {
  if (!state?.hasToken) {
    vatRates = [];
    renderVatOptions(null);
    return;
  }
  const loaded = await withError(() => window.api.listVatRates());
  if (!loaded) return;
  vatRates = loaded;
  renderVatOptions(selectedVatId());
}

async function refresh() {
  applyState(await window.api.getState());
  await Promise.all([loadVatRates(), loadGroups()]);
}

async function withError(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(error.message || String(error), true);
    appendLog(error.message || String(error));
    return null;
  }
}

$("saveSecrets").addEventListener("click", async () => {
  const next = await withError(() => window.api.saveSecrets(currentSecrets()));
  if (next) {
    applyState(next);
    toast("Ключи сохранены");
    await Promise.all([loadVatRates(), loadGroups()]);
  }
});

$("refresh").addEventListener("click", () => refresh());

$("emptyDb").addEventListener("click", async () => {
  const next = await withError(() => window.api.emptyDatabase());
  if (!next) return;
  applyState(next);
  if (!next.cancelled) toast("База очищена");
});

$("clearGroup").addEventListener("click", () => {
  setSelectedGroup(null, null);
  groups = allGroups;
  closeGroupList();
  void persistSettings();
});

$("groupSearch").addEventListener("focus", () => {
  if ($("groupSearch").value === selectedLabel() && selectedGroupIdValue) {
    $("groupSearch").select();
  }
  openGroupList();
});

$("groupSearch").addEventListener("input", () => {
  groupHighlight = 0;
  openGroupList();
  scheduleGroupSearch();
});

$("groupSearch").addEventListener("keydown", (event) => {
  const items = listItems();
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!groupListOpen) openGroupList();
    groupHighlight = Math.min(items.length - 1, groupHighlight + 1);
    renderGroupList();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!groupListOpen) openGroupList();
    groupHighlight = Math.max(0, groupHighlight - 1);
    renderGroupList();
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (!groupListOpen) openGroupList();
    else chooseGroupAt(groupHighlight);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeGroupList();
    $("groupSearch").blur();
  }
});

$("groupList").addEventListener("mousedown", (event) => {
  const option = event.target.closest(".combobox-option");
  if (!option) return;
  event.preventDefault();
  chooseGroupAt(Number(option.dataset.index));
});

document.addEventListener("click", (event) => {
  if (!$("groupCombobox").contains(event.target)) closeGroupList();
});

function isBulkKind(kind) {
  return kind === "vat" || kind === "icps" || kind === "labeled";
}

function runArgs(baseArgs) {
  const groupId = selectedGroupId();
  if (groupId) return [...baseArgs, "--group", String(groupId)];
  return baseArgs;
}

async function start(args, options = {}) {
  if (!options.skipMxikWarning) {
    const warning = settingsWarning();
    if (warning) {
      toast(warning, true);
      return;
    }
  }
  if (!state?.hasToken) {
    toast("Сначала сохраните токен интеграции", true);
    return;
  }
  await persistSettings();
  const commandArgs = options.raw ? args : runArgs(args);
  activeRunKind = isBulkKind(commandArgs[0]) ? commandArgs[0] : "mxik";
  setRunState({ running: true, stopping: false });
  const result = await withError(() => window.api.startRun(commandArgs));
  if (Array.isArray(result?.lastRunArgs)) lastRunArgs = result.lastRunArgs;
  if (!result || result.cancelled || !result.running) {
    activeRunKind = null;
    setRunState({ running: false, stopping: false });
  }
}

$("startAll").addEventListener("click", () => start([]));
$("startResume").addEventListener("click", () => {
  if (!lastRunArgs) {
    toast("Сначала запустите обновление, затем остановите его, чтобы продолжить", true);
    return;
  }
  const args = lastRunArgs.filter((arg) => arg !== "--resume");
  void start([...args, "--resume"], { raw: true });
});
$("startFetch").addEventListener("click", () => start(["--fetch"]));
$("startTasnif").addEventListener("click", () => start(["--tasnif"]));
$("startUpdate").addEventListener("click", () => start(["--update"]));
$("startVat").addEventListener("click", () => {
  const vatId = selectedVatId();
  if (!vatId) {
    toast("Выберите ставку НДС", true);
    return;
  }
  void start(["vat", "--vat-id", String(vatId)], { skipMxikWarning: true });
});
$("startIcps").addEventListener("click", () => {
  const icps = $("manualIcps").value.trim();
  if (!icps) {
    toast("Введите код ИКПУ", true);
    return;
  }
  void start(["icps", "--icps", icps], { skipMxikWarning: true });
});
$("startLabeled").addEventListener("click", () => {
  const labeled = selectedRadio("manualLabeled") === "true" ? "true" : "false";
  void start(["labeled", "--labeled", labeled], { skipMxikWarning: true });
});

async function stopRun() {
  setRunState({ running: false, stopping: true });
  const result = await withError(() => window.api.stopRun());
  if (result) {
    setRunState({ running: false, stopping: false });
  } else {
    await refresh();
  }
}

$("stop").addEventListener("click", () => {
  void stopRun();
});
$("stopVat").addEventListener("click", () => {
  void stopRun();
});
$("stopManual").addEventListener("click", () => {
  void stopRun();
});

for (const input of document.querySelectorAll('input[name="authMode"]')) {
  input.addEventListener("change", syncAuthMode);
}
for (const input of document.querySelectorAll('input[name="mxikMode"], #updateIsLabeled, #skipDeleted, #skipServices, #includeChildGroups')) {
  input.addEventListener("change", () => {
    settingsWarning();
    schedulePersist();
  });
}

window.api.onLog(appendLog);
window.api.onRunState(setRunState);
window.api.onState(applyState);

refresh().catch((error) => toast(error.message || String(error), true));
