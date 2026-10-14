"use strict";

const LEGACY_STORAGE_KEY = "carpool-board.trips.v1";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const form = document.querySelector("#trip-form");
const entryPanel = document.querySelector(".entry-panel");
const submitButton = document.querySelector("#submit-button");
const resetButton = document.querySelector("#reset-form");
const travelDateInput = document.querySelector("#travel-date");
const capacityInput = document.querySelector("#capacity");
const remainingInput = document.querySelector("#remaining-seats");
const formError = document.querySelector("#form-error");
const tripList = document.querySelector("#trip-list");
const emptyState = document.querySelector("#empty-state");
const emptyTitle = document.querySelector("#empty-title");
const emptyMessage = document.querySelector("#empty-message");
const recordCount = document.querySelector("#record-count");
const cardTemplate = document.querySelector("#trip-card-template");
const setupPanel = document.querySelector("#setup-panel");
const setupMessage = document.querySelector("#setup-message");
const legacyNotice = document.querySelector("#legacy-notice");
const legacyMessage = document.querySelector("#legacy-message");
const migrateButton = document.querySelector("#migrate-button");
const syncStatus = document.querySelector("#sync-status");
const syncStatusText = document.querySelector("#sync-status-text");
const toast = document.querySelector("#toast");

let client;
let currentUserId = "";
let trips = [];
let isReady = false;
let refreshTimer;
let toastTimer;

function hasValidConfig() {
  const config = globalThis.CARPOOL_CONFIG;
  return (
    config &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(config.supabaseUrl || "")) &&
    String(config.supabaseAnonKey || "").length > 20 &&
    !String(config.supabaseAnonKey).includes("YOUR_")
  );
}

function setConnectionStatus(state, text) {
  syncStatus.classList.remove("is-loading", "is-online", "is-offline");
  syncStatus.classList.add(`is-${state}`);
  syncStatusText.textContent = text;
  syncStatus.title = text;
}

function setUiEnabled(enabled) {
  isReady = enabled;
  entryPanel.classList.toggle("is-disabled", !enabled);
  form.querySelectorAll("input, button").forEach((control) => {
    control.disabled = !enabled;
  });
}

function showSetup(message) {
  setupMessage.textContent = message;
  setupPanel.hidden = false;
  setUiEnabled(false);
  setConnectionStatus("offline", "共享未连接");
  emptyTitle.textContent = "等待共享配置";
  emptyMessage.textContent = "完成配置后，所有访问者会看到同一份行程。";
  emptyState.hidden = false;
}

function friendlyError(error) {
  const message = String(error?.message || error || "未知错误");

  if (/anonymous sign-ins.*disabled/i.test(message)) {
    return "Supabase 尚未启用匿名登录，请在 Authentication 设置中启用 Anonymous Sign-Ins。";
  }
  if (/failed to fetch|networkerror/i.test(message)) {
    return "无法连接共享数据库，请检查网络与 Supabase 配置。";
  }
  return message;
}

async function initializeSharedStore() {
  updateMinimumTravelDate();
  setDefaultTravelDate();
  setUiEnabled(false);
  renderTrips();

  if (!hasValidConfig()) {
    showSetup("在 config.js 中填写 Supabase 项目地址与公开密钥，然后按 README 运行数据库脚本。");
    return;
  }
  if (!globalThis.supabase?.createClient) {
    showSetup("共享服务客户端加载失败，请检查网络后刷新页面。");
    return;
  }

  try {
    setConnectionStatus("loading", "正在连接");
    client = globalThis.supabase.createClient(
      globalThis.CARPOOL_CONFIG.supabaseUrl,
      globalThis.CARPOOL_CONFIG.supabaseAnonKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      },
    );

    const sessionResult = await client.auth.getSession();
    if (sessionResult.error) throw sessionResult.error;

    let session = sessionResult.data.session;
    if (!session) {
      const signInResult = await client.auth.signInAnonymously();
      if (signInResult.error) throw signInResult.error;
      session = signInResult.data.session;
    }
    if (!session?.user?.id) throw new Error("无法创建当前访问者身份");

    currentUserId = session.user.id;
    await loadTrips();
    setupPanel.hidden = true;
    setUiEnabled(true);
    setConnectionStatus("online", "共享在线 · 7 天");
    showLegacyMigrationNotice();
    subscribeToChanges();
  } catch (error) {
    console.error("共享数据库初始化失败：", error);
    showSetup(friendlyError(error));
  }
}

function fromDatabaseRow(row) {
  return {
    id: String(row.id),
    driverName: String(row.driver_name),
    travelDate: new Date(row.travel_date).toISOString(),
    origin: String(row.origin || "待补充"),
    waypoints: String(row.waypoints || ""),
    destination: String(row.destination || "待补充"),
    capacity: Number(row.capacity),
    remainingSeats: Number(row.remaining_seats),
    contact: String(row.contact),
    ownerId: String(row.owner_id),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function toDatabasePayload(trip, { preserveDates = false } = {}) {
  const payload = {
    driver_name: trip.driverName,
    travel_date: trip.travelDate,
    origin: trip.origin,
    waypoints: trip.waypoints || null,
    destination: trip.destination,
    capacity: trip.capacity,
    remaining_seats: trip.remainingSeats,
    contact: trip.contact,
    owner_id: currentUserId,
  };

  if (preserveDates) {
    payload.created_at = trip.createdAt;
    payload.expires_at = trip.expiresAt;
  }
  return payload;
}

async function loadTrips({ silent = false } = {}) {
  if (!client) return;
  if (!silent) {
    emptyTitle.textContent = "正在读取行程";
    emptyMessage.textContent = "正在同步共享数据库。";
  }

  const { data, error } = await client
    .from("trips")
    .select("id,driver_name,travel_date,origin,waypoints,destination,capacity,remaining_seats,contact,owner_id,created_at,expires_at")
    .order("travel_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;

  trips = (data || []).map(fromDatabaseRow);
  renderTrips();
}

function subscribeToChanges() {
  client
    .channel("public-trips-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, () => scheduleRefresh())
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setConnectionStatus("loading", "共享已连接 · 刷新稍慢");
      } else if (status === "SUBSCRIBED") {
        setConnectionStatus("online", "共享在线 · 7 天");
      }
    });
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(async () => {
    try {
      await loadTrips({ silent: true });
    } catch (error) {
      console.error("实时同步失败：", error);
    }
  }, 180);
}

function parseLegacyTrips() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeImportedTrip).filter((trip) => trip && Date.parse(trip.expiresAt) > Date.now());
  } catch (error) {
    console.warn("无法读取旧版本地数据：", error);
    return [];
  }
}

function showLegacyMigrationNotice() {
  const legacyTrips = parseLegacyTrips();
  if (legacyTrips.length === 0) return;
  legacyMessage.textContent = `检测到旧版保存在本机的 ${legacyTrips.length} 条有效行程。`;
  legacyNotice.hidden = false;
}

async function migrateLegacyTrips() {
  const legacyTrips = parseLegacyTrips();
  if (legacyTrips.length === 0) {
    legacyNotice.hidden = true;
    return;
  }

  migrateButton.disabled = true;
  try {
    const payloads = legacyTrips.map((trip) => toDatabasePayload(trip, { preserveDates: true }));
    const { error } = await client.from("trips").insert(payloads);
    if (error) throw error;

    localStorage.removeItem(LEGACY_STORAGE_KEY);
    legacyNotice.hidden = true;
    await loadTrips({ silent: true });
    showToast(`已发布 ${legacyTrips.length} 条本地行程`);
  } catch (error) {
    console.error("迁移本地数据失败：", error);
    showToast(`发布失败：${friendlyError(error)}`);
  } finally {
    migrateButton.disabled = false;
  }
}

function normalizeImportedTrip(trip) {
  if (!trip || typeof trip !== "object") return null;

  const capacity = Number(trip.capacity);
  const remainingSeats = Number(trip.remainingSeats);
  const origin = typeof trip.origin === "string" && trip.origin.trim() ? trip.origin.trim() : "待补充";
  const waypoints = typeof trip.waypoints === "string" ? trip.waypoints.trim() : "";
  const destination =
    typeof trip.destination === "string" && trip.destination.trim() ? trip.destination.trim() : "待补充";
  const createdAt = Date.parse(trip.createdAt);
  const travelDate = Date.parse(trip.travelDate);
  const expiresAt = Number.isFinite(Date.parse(trip.expiresAt))
    ? Date.parse(trip.expiresAt)
    : createdAt + RETENTION_MS;

  if (
    typeof trip.driverName !== "string" ||
    !trip.driverName.trim() ||
    trip.driverName.trim().length > 30 ||
    typeof trip.contact !== "string" ||
    !trip.contact.trim() ||
    trip.contact.trim().length > 60 ||
    origin.length > 80 ||
    waypoints.length > 160 ||
    destination.length > 80 ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(travelDate) ||
    !Number.isFinite(expiresAt) ||
    Math.abs(expiresAt - createdAt - RETENTION_MS) > 1000 ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 99 ||
    !Number.isInteger(remainingSeats) ||
    remainingSeats < 0 ||
    remainingSeats > capacity
  ) {
    return null;
  }

  return {
    id: typeof trip.id === "string" ? trip.id : "",
    driverName: trip.driverName.trim(),
    travelDate: new Date(travelDate).toISOString(),
    origin,
    waypoints,
    destination,
    capacity,
    remainingSeats,
    contact: trip.contact.trim(),
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function formatDateParts(isoDate) {
  const date = new Date(isoDate);
  return {
    day: String(date.getDate()).padStart(2, "0"),
    monthText: new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      weekday: "short",
    }).format(date),
    timeText: new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date),
  };
}

function formatExpiry(expiresAt) {
  const remainingHours = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / (60 * 60 * 1000)));
  return remainingHours < 24
    ? `${remainingHours} 小时后清理`
    : `${Math.ceil(remainingHours / 24)} 天后清理`;
}

function contactHref(contact) {
  const normalized = contact.replace(/[\s()-]/g, "");
  return /^\+?\d{7,15}$/.test(normalized) ? `tel:${normalized}` : "";
}

function renderTrips() {
  tripList.replaceChildren();
  recordCount.textContent = `${trips.length} 条`;

  if (trips.length === 0) {
    emptyState.hidden = false;
    if (isReady) {
      emptyTitle.textContent = "还没有行程";
      emptyMessage.textContent = "新增的行程会立即分享给所有访问者。";
    }
    return;
  }

  emptyState.hidden = true;
  const fragment = document.createDocumentFragment();

  trips.forEach((trip) => {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    const dateParts = formatDateParts(trip.travelDate);
    const contactLink = card.querySelector(".contact-value");
    const decreaseButton = card.querySelector(".decrease-button");
    const increaseButton = card.querySelector(".increase-button");
    const deleteButton = card.querySelector(".delete-button");
    const stepper = card.querySelector(".stepper");
    const readOnlyLabel = card.querySelector(".read-only-label");
    const isOwner = trip.ownerId === currentUserId;

    card.dataset.id = trip.id;
    card.classList.toggle("is-owned", isOwner);
    card.querySelector(".date-block__day").textContent = dateParts.day;
    card.querySelector(".date-block__month").textContent = dateParts.monthText;
    card.querySelector(".date-block__time").textContent = dateParts.timeText;
    card.querySelector(".ownership-label").textContent = isOwner ? "我发布的" : "共享行程";
    card.querySelector(".expiry-label").textContent = formatExpiry(trip.expiresAt);
    card.querySelector(".driver-name").textContent = trip.driverName;
    card.querySelector(".origin-value").textContent = trip.origin;
    card.querySelector(".waypoints-value").textContent = trip.waypoints || "无";
    card.querySelector(".destination-value").textContent = trip.destination;
    contactLink.textContent = trip.contact;

    const href = contactHref(trip.contact);
    if (href) contactLink.href = href;

    card.querySelector(".remaining-value").textContent = trip.remainingSeats;
    card.querySelector(".capacity-value").textContent = `/ ${trip.capacity} 人`;
    card.querySelector(".stepper-value").textContent = trip.remainingSeats;

    if (isOwner) {
      decreaseButton.disabled = trip.remainingSeats === 0;
      increaseButton.disabled = trip.remainingSeats === trip.capacity;
    } else {
      stepper.hidden = true;
      readOnlyLabel.hidden = false;
      deleteButton.hidden = true;
    }
    fragment.append(card);
  });

  tripList.append(fragment);
}

function setDefaultTravelDate() {
  if (travelDateInput.value) return;
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  travelDateInput.value = toDateTimeLocalValue(nextHour);
}

function updateMinimumTravelDate() {
  travelDateInput.min = toDateTimeLocalValue(new Date());
}

function toDateTimeLocalValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function clearFieldErrors() {
  formError.textContent = "";
  form.querySelectorAll("[aria-invalid='true']").forEach((input) => input.removeAttribute("aria-invalid"));
}

function showFormError(message, input) {
  formError.textContent = message;
  input?.setAttribute("aria-invalid", "true");
  input?.focus();
}

function readAndValidateForm() {
  const formData = new FormData(form);
  const driverName = String(formData.get("driverName") || "").trim();
  const travelDate = String(formData.get("travelDate") || "");
  const origin = String(formData.get("origin") || "").trim();
  const waypoints = String(formData.get("waypoints") || "").trim();
  const destination = String(formData.get("destination") || "").trim();
  const capacity = Number(formData.get("capacity"));
  const remainingSeats = Number(formData.get("remainingSeats"));
  const contact = String(formData.get("contact") || "").trim();

  if (!driverName) {
    showFormError("请填写司机称呼", form.elements.driverName);
    return null;
  }
  if (!travelDate || !Number.isFinite(Date.parse(travelDate))) {
    showFormError("请选择有效的出行日期与时间", form.elements.travelDate);
    return null;
  }
  if (Date.parse(travelDate) < Date.now() - 60 * 1000) {
    showFormError("出行时间不能早于当前时间", form.elements.travelDate);
    return null;
  }
  if (!origin) {
    showFormError("请填写出发地", form.elements.origin);
    return null;
  }
  if (!destination) {
    showFormError("请填写终点", form.elements.destination);
    return null;
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 99) {
    showFormError("可载人数应为 1 至 99 的整数", form.elements.capacity);
    return null;
  }
  if (!Number.isInteger(remainingSeats) || remainingSeats < 0 || remainingSeats > capacity) {
    showFormError("剩余人数应为 0 至可载人数之间的整数", form.elements.remainingSeats);
    return null;
  }
  if (!contact) {
    showFormError("请填写联系方式", form.elements.contact);
    return null;
  }

  return {
    driverName,
    travelDate: new Date(travelDate).toISOString(),
    origin,
    waypoints,
    destination,
    capacity,
    remainingSeats,
    contact,
  };
}

async function handleSubmit(event) {
  event.preventDefault();
  clearFieldErrors();
  if (!isReady) return;

  const trip = readAndValidateForm();
  if (!trip) return;
  submitButton.disabled = true;

  try {
    const { data, error } = await client
      .from("trips")
      .insert(toDatabasePayload(trip))
      .select("id,driver_name,travel_date,origin,waypoints,destination,capacity,remaining_seats,contact,owner_id,created_at,expires_at")
      .single();
    if (error) throw error;

    trips.push(fromDatabaseRow(data));
    trips.sort((a, b) => Date.parse(b.travelDate) - Date.parse(a.travelDate));
    renderTrips();
    form.reset();
    setDefaultTravelDate();
    form.elements.driverName.focus();
    showToast("行程已共享，将在 7 天后自动清理");
  } catch (error) {
    console.error("添加共享行程失败：", error);
    showFormError(`添加失败：${friendlyError(error)}`);
  } finally {
    submitButton.disabled = false;
  }
}

async function updateRemainingSeats(id, difference) {
  const trip = trips.find((item) => item.id === id);
  if (!trip || trip.ownerId !== currentUserId) return;

  const nextValue = Math.min(trip.capacity, Math.max(0, trip.remainingSeats + difference));
  if (nextValue === trip.remainingSeats) return;

  try {
    const { data, error } = await client
      .from("trips")
      .update({ remaining_seats: nextValue })
      .eq("id", id)
      .eq("owner_id", currentUserId)
      .select("remaining_seats")
      .single();
    if (error) throw error;

    trip.remainingSeats = Number(data.remaining_seats);
    renderTrips();
  } catch (error) {
    console.error("更新剩余座位失败：", error);
    showToast(`更新失败：${friendlyError(error)}`);
  }
}

async function deleteTrip(id) {
  const trip = trips.find((item) => item.id === id);
  if (!trip || trip.ownerId !== currentUserId) return;
  if (!window.confirm(`确定删除“${trip.driverName}”的这条行程吗？`)) return;

  try {
    const { error } = await client.from("trips").delete().eq("id", id).eq("owner_id", currentUserId);
    if (error) throw error;
    trips = trips.filter((item) => item.id !== id);
    renderTrips();
    showToast("共享行程已删除");
  } catch (error) {
    console.error("删除共享行程失败：", error);
    showToast(`删除失败：${friendlyError(error)}`);
  }
}

function handleListClick(event) {
  const card = event.target.closest(".trip-card");
  if (!card) return;
  if (event.target.closest(".decrease-button")) {
    updateRemainingSeats(card.dataset.id, -1);
  } else if (event.target.closest(".increase-button")) {
    updateRemainingSeats(card.dataset.id, 1);
  } else if (event.target.closest(".delete-button")) {
    deleteTrip(card.dataset.id);
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3000);
}

form.addEventListener("submit", handleSubmit);
resetButton.addEventListener("click", () => {
  form.reset();
  clearFieldErrors();
  setDefaultTravelDate();
  form.elements.driverName.focus();
});
capacityInput.addEventListener("input", () => {
  if (!remainingInput.value || Number(remainingInput.value) > Number(capacityInput.value)) {
    remainingInput.value = capacityInput.value;
  }
});
form.addEventListener("input", clearFieldErrors);
tripList.addEventListener("click", handleListClick);
migrateButton.addEventListener("click", migrateLegacyTrips);

window.setInterval(() => {
  updateMinimumTravelDate();
  if (isReady && !document.hidden) {
    loadTrips({ silent: true }).catch((error) => console.error("定时同步失败：", error));
  }
}, 60 * 1000);

initializeSharedStore();
