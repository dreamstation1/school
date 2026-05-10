/** @typedef {{ subject: string, room?: string }} Cell */
/** @typedef {{ text: string, x0: number, y0: number, x1: number, y1: number, xm: number, yc: number, h: number, conf: number }} OcrWord */

const STORAGE_KEY = "school-timetable-alarm:v1";
const FIRED_PREFIX = "school-timetable-fired:";

/** @type {readonly string[]} */
const DAY_IDS = ["mon", "tue", "wed", "thu", "fri"];
const DAY_LABELS = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금" };

/** @returns {string} yyyy-mm-dd 로컬 */
function dateKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @param {string} hhmm "HH:mm" */
function parseTodayTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  return t.getTime();
}

/** Mon=0 ... Fri=4, Sat/Sun = -1 */
function weekdayIndexMon0() {
  const js = new Date().getDay();
  if (js === 0 || js === 6) return -1;
  return js - 1;
}

function defaultState() {
  return {
    periodStarts: ["08:30", "09:25", "10:20", "11:15", "13:00", "13:55", "14:50", "15:45"],
    /** @type {Record<string, Cell[]>} */
    schedule: {
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
    },
    remindSchoolBeforeMin: 60,
    enablePeriodReminders: false,
    remindPeriodBeforeMin: 5,
    timetableImageDataUrl: null,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const def = defaultState();
    return {
      ...def,
      ...parsed,
      periodStarts: Array.isArray(parsed.periodStarts) ? parsed.periodStarts : def.periodStarts,
      schedule: { ...def.schedule, ...(parsed.schedule || {}) },
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  const { timetableImageDataUrl, ...rest } = state;
  const toSave = { ...rest, timetableImageDataUrl };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

/** @param {number[]} nums */
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** @returns {Promise<string>} jpeg data URL */
async function bitmapToClampedDataUrl(bitmap, mime = "image/jpeg", quality = 0.82) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(bitmap, 0, 0);
  return canvas.toDataURL(mime, quality);
}

/** 뷰 저장용 + OCR용 · 큰 원본 알아서 줄임 */
async function fileToSizedDataUrl(file, maxSide = 1400, qualityStart = 0.86, maxAttempts = 5) {
  const img = typeof createImageBitmap === "function" ? await createImageBitmap(file) : null;
  if (!img) {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : "");
      fr.onerror = () => reject(fr.error || new Error("read fail"));
      fr.readAsDataURL(file);
    });
  }

  let w = img.width;
  let h = img.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) return bitmapToClampedDataUrl(img);
  ctx.drawImage(img, 0, 0, tw, th);

  let q = qualityStart;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length < 950_000) return url;
    q = Math.max(0.52, q - 0.08);
  }
  return canvas.toDataURL("image/jpeg", 0.52);
}

/** HH:mm 문자열 또는 "" */
function toHHMM(h, min) {
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** @returns {TimeMatch[]} 순서 유지하면서 문자열 순회 */
function collectTimesInOrder(text) {
  const re = /\b(\d{1,2})\s*[:：]\s*(\d{2})\b/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (Number.isNaN(h) || Number.isNaN(min)) continue;
    if (min > 59) continue;
    if (h < 6 || h > 21) continue;
    out.push({ pos: m.index, str: toHHMM(h, min), minutes: h * 60 + min });
  }
  return out;
}

/** 학교 교시 줄에 흔한 시각 목록 추출 · 너무 많으면 교시 줄로 보이지 않음 */
function extractPeriodTimesFromPlainText(fullText, cap = 12) {
  const matches = collectTimesInOrder(fullText);
  /** @type {string[]} */
  const ordered = [];
  const seenSame = new Set();
  const seenMinute = /** @type {Set<number>} */ (new Set());
  for (const m of matches) {
    const keyMinute = Math.floor(m.minutes / 30) * 30;
    if (seenMinute.has(keyMinute)) continue;
    if (seenSame.has(m.str)) continue;
    seenSame.add(m.str);
    seenMinute.add(keyMinute);
    ordered.push(m.str);
    if (ordered.length >= cap) break;
  }
  if (ordered.length < 3) return null;
  return ordered;
}

function isLikelyPeriodOrTimeCell(txt) {
  const t = String(txt || "").replace(/\s+/g, "").trim();
  if (!t) return true;
  if (/^\d{1,2}$/.test(t)) return true;
  if (/^\d{1,2}교시$/.test(t)) return true;
  return /\d{1,2}[:：]\d{2}/.test(t);
}

function normalizeSubjectText(txt) {
  let s = String(txt || "").trim();
  s = s.replace(/\s+/g, "");
  s = s.replace(/^[.|·]+\s*/, "");
  s = s.replace(/^\d{1,2}교시/, "");
  return s.trim();
}

/** @type {readonly string[]} */
const NOISE_CELL = [
  "구분",
  "교시",
  "시간",
  "요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "|",
];

function skipSubject(txt) {
  const n = normalizeSubjectText(txt);
  if (!n) return "";
  if (NOISE_CELL.includes(n)) return "";
  if (/^[월화수목금]+$/.test(n) && n.length <= 6) return "";
  return n;
}

/** @param {*} raw tess word */
function toOcrWord(raw) {
  const b =
    raw.bbox && typeof raw.bbox.x0 === "number"
      ? raw.bbox
      : typeof raw.x0 === "number"
        ? raw
        : { x0: 0, y0: 0, x1: 0, y1: 0 };
  const conf = typeof raw.confidence === "number" ? raw.confidence : 55;
  return {
    text: String(raw.text || "").trim(),
    x0: b.x0,
    y0: b.y0,
    x1: b.x1,
    y1: b.y1,
    xm: (b.x0 + b.x1) / 2,
    yc: (b.y0 + b.y1) / 2,
    h: Math.max(1, b.y1 - b.y0),
    conf,
  };
}

/** @param {OcrWord[]} words */
function clusterWordsIntoRows(words) {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.yc - b.yc);
  /** @type {{ items: OcrWord[], avgY: number, h: number }[]} */
  const rows = [];
  for (const w of sorted) {
    let row = rows.find((r) => Math.abs(w.yc - r.avgY) < Math.max(r.h, w.h) * 0.62);
    if (!row) {
      row = { items: [], avgY: w.yc, h: w.h };
      rows.push(row);
    }
    row.items.push(w);
    row.avgY = row.items.reduce((s, q) => s + q.yc, 0) / row.items.length;
    row.h = Math.max(row.h, w.h);
  }
  rows.sort((a, b) => a.avgY - b.avgY);
  return rows.map((r) => [...r.items].sort((a, b) => a.x0 - b.x0));
}

/** @param {OcrWord[]} sortedRow */
function splitRowIntoMergedCells(sortedRow) {
  if (!sortedRow.length) return [];
  const widths = sortedRow.map((w) => w.x1 - w.x0);
  const mw = median(widths.filter((x) => x > 0)) || 24;
  const clusters = [];
  let cur = [sortedRow[0]];
  for (let i = 1; i < sortedRow.length; i++) {
    const gap = sortedRow[i].x0 - sortedRow[i - 1].x1;
    if (gap > mw * 1.45) {
      clusters.push(cur);
      cur = [];
    }
    cur.push(sortedRow[i]);
  }
  clusters.push(cur);
  return clusters.map((c) =>
    normalizeSubjectText(
      c
        .map((w) => w.text)
        .join("")
        .replace(/\|/g, "")
        .trim(),
    ),
  );
}

function rowLikelyWeekdayHeader(cellsJoined) {
  const j = cellsJoined.filter(Boolean);
  let hits = 0;
  for (const lbl of DAY_IDS) {
    if (cellsJoined.some((c) => c && c.includes(DAY_LABELS[lbl]))) hits++;
    if (j.some((cell) => cell === DAY_LABELS[lbl])) hits++;
  }
  return hits >= 3;
}

/** @returns {Partial<Record<typeof DAY_IDS[number], number>> | null} */
function dayCentersFromHeaderRow(rowSorted) {
  const map = /** @type {Partial<Record<typeof DAY_IDS[number], number>>} */ ({});
  for (const id of DAY_IDS) {
    const hit = rowSorted.find((w) => w.text.replace(/\s+/g, "").includes(DAY_LABELS[id]));
    if (hit) map[id] = hit.xm;
  }
  const keys = Object.keys(map);
  if (keys.length < 3) return null;
  return map;
}

/** @returns {Partial<typeof DAY_IDS[number]>[]} */
function buildScheduleFromWords(allWords, maxRowsGuess) {
  const words = allWords.filter((w) => w.text && w.conf > 26);
  if (words.length < 6) return [];
  const rows = clusterWordsIntoRows(words);

  /** @type {Partial<typeof DAY_IDS[number]>[]} */
  const out = [];
  /** @type {Partial<Record<typeof DAY_IDS[number], number>> | null} */
  let centers = null;
  /** @type {number} */
  let headerIdx = -1;

  rows.forEach((row, idx) => {
    const cells = splitRowIntoMergedCells(row);
    if (!cells.length || !rowLikelyWeekdayHeader(cells)) return;
    const c = dayCentersFromHeaderRow(row);
    if (c) {
      centers = c;
      headerIdx = idx;
    }
  });

  if (!centers)
    centers = DAY_IDS.reduce((acc, id, di) => {
      acc[id] = 140 + di * 90;
      return acc;
    }, /** @type {Partial<Record<typeof DAY_IDS[number], number>>} */ ({}));

  rows.forEach((row, ri) => {
    if (!row.length || ri === headerIdx) return;

    /** @type {Partial<typeof DAY_IDS[number]>} */
    const daySubjects = {};
    const clusters = splitRowIntoMergedCells(row);

    const metaStripped =
      clusters[0] && isLikelyPeriodOrTimeCell(clusters[0]) ? clusters.slice(1) : clusters;

    metaStripped.forEach((cell, ci) => {
      const xm =
        clusters[0] && isLikelyPeriodOrTimeCell(clusters[0]) && clusters[ci + 1]
          ? row[Math.min(ci + 1, row.length - 1)]?.xm
          : clusterCenterXGuess(row, cell);
      if (!cell || xm == null || isLikelyPeriodOrTimeCell(cell)) return;
      const subj = skipSubject(cell);
      if (!subj) return;
      const nearest = nearestDayFromCenters(
        centers,
        xm ?? row.map((w) => w.xm)[Math.min(ci, row.length - 1)],
      );
      if (nearest)
        daySubjects[nearest] = subj;
    });

    if (DAY_IDS.every((id) => !daySubjects[id])) {
      const peeled = [
        ...(clusters[0] && isLikelyPeriodOrTimeCell(clusters[0]) ? clusters.slice(1) : clusters),
      ];
      const tail = peeled.slice(Math.max(0, peeled.length - 5));
      if (tail.length === 5) {
        DAY_IDS.forEach((id, i) => {
          const s = skipSubject(tail[i]);
          if (s) daySubjects[id] = s;
        });
      }
    }

    const any = DAY_IDS.some((id) => daySubjects[id]);
    if (any) out.push(daySubjects);
  });

  if (maxRowsGuess && out.length > maxRowsGuess) out.length = maxRowsGuess;
  return out;
}

/**
 * @param {OcrWord[]} row
 * @param {string} cell
 */
function clusterCenterXGuess(row, cell) {
  const w = row.find((q) => q.text && cell.includes(q.text.replace(/\s+/g, "").slice(0, 2)));
  return w ? w.xm : row[Math.floor(row.length / 2)]?.xm;
}

/**
 * @param {Partial<Record<typeof DAY_IDS[number], number>>} centers
 * @param {number} xm
 */
function nearestDayFromCenters(centers, xm) {
  let bestId = /** @type {typeof DAY_IDS[number] | null} */ (null);
  let best = Infinity;
  for (const id of DAY_IDS) {
    const c = centers[id];
    if (typeof c !== "number") continue;
    const d = Math.abs(c - xm);
    if (d < best && d < 140) {
      best = d;
      bestId = id;
    }
  }
  if (bestId) return bestId;
  const ranked = DAY_IDS.map((id) => ({ id, c: centers[id] ?? xm })).sort((x, y) => x.c - y.c);
  let idx = Math.max(
    0,
    ranked.findIndex((p) => p.c >= xm - 55),
  );
  if (idx < 0) idx = ranked.length - 1;
  idx = Math.min(ranked.length - 1, Math.max(0, idx));
  return ranked[idx]?.id ?? DAY_IDS[0];
}

/**
 * @param {unknown[]} words tess data.words
 */
function tessWords(words) {
  if (!words || !Array.isArray(words)) return [];
  return words.map(toOcrWord).filter((w) => w.text.length > 0);
}

/**
 * 순수 텍스트 라인 파싱 ( 보조용 )
 */
function parsePlainSubjectsPerRow(fullText, maxPeriods = 14) {
  const lines = fullText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  /** @type {Partial<typeof DAY_IDS[number]>[]} */
  const rows = [];

  for (const line of lines) {
    if (!/[가-힣a-z]/i.test(line)) continue;

    const lineCollapsed = line.replace(/\s+/g, "");
    if (
      DAY_IDS.filter((id) => lineCollapsed.includes(DAY_LABELS[id])).length >= 4 &&
      lineCollapsed.length <= 18
    ) {
      continue;
    }

    let cols = line
      .split(/\t| {2,}|\|\s*/)
      .filter(Boolean)
      .map((s) =>
        normalizeSubjectText(String(s))
          .replace(/^[·•*-]+/, "")
          .replace(/^\|\s*/, ""),
      )
      .filter(Boolean);

    while (cols.length && isLikelyPeriodOrTimeCell(cols[0])) cols.shift();

    if (!cols.some((x) => /[\uAC00-\uD7AF]|[A-Za-z]{2}/.test(x))) continue;

    const onlyDayAbbrev =
      cols.length > 0 &&
      cols.every((x) => DAY_IDS.some((id) => DAY_LABELS[id] === normalizeSubjectText(x)));
    if (onlyDayAbbrev) continue;

    /** @type {Partial<typeof DAY_IDS[number]>} */
    const daySubjects = {};

    if (cols.length >= 6 && isLikelyPeriodOrTimeCell(cols[0])) {
      DAY_IDS.forEach((id, i) => {
        const s = skipSubject(cols[i + 1]);
        if (s) daySubjects[id] = s;
      });
    }

    const lastFive = cols.slice(Math.max(0, cols.length - 5));
    const lastLooksLikeSubjects =
      lastFive.length === 5 &&
      lastFive.every((x) => /[\uAC00-\uD7AF]{2}/.test(x) || /[A-Za-z]{2}/.test(x));
    const notOnlyDayAbbrev =
      !lastFive.every((x) =>
        DAY_IDS.some((id) => DAY_LABELS[id] === normalizeSubjectText(x)),
      );

    if (lastLooksLikeSubjects && notOnlyDayAbbrev) {
      DAY_IDS.forEach((id, i) => {
        const sub = skipSubject(lastFive[i]);
        if (!daySubjects[id] && sub) daySubjects[id] = sub;
      });
    }

    if (DAY_IDS.some((id) => daySubjects[id])) rows.push(daySubjects);

    if (rows.length >= maxPeriods) break;
  }

  return rows;
}

async function recognizeTimetable(dataUrl, onProgress) {
  /** @type {any} */
  const Tesseract = globalThis.Tesseract;
  if (!Tesseract || typeof Tesseract.recognize !== "function") {
    throw new Error(
      "Tesseract 라이브러리를 불러오지 못했어요. 인터넷(CDN)·스크립트 차단 설정을 확인해 주세요.",
    );
  }

  const { data } = await Tesseract.recognize(dataUrl, "kor+eng", {
    logger(m) {
      if (typeof onProgress !== "function") return;
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        onProgress(`글자 인식 중… ${Math.round(m.progress * 100)}%`);
      } else if (typeof m.status === "string") {
        onProgress(`${m.status} …`);
      }
    },
  });

  return data;
}

/**
 * @returns {{ rowCount: number, periodsFromOcr: boolean }}
 */
function mergeOcrIntoState(state, bundle, overwriteSubjects, editedText) {
  const fallback = typeof editedText === "string" ? editedText : "";
  const text =
    fallback.trim().length > 0
      ? fallback
      : typeof bundle?.fullText === "string"
        ? bundle.fullText
        : "";

  /** @type {unknown[]} */
  const rawWords = bundle && Array.isArray(bundle.words) ? bundle.words : [];

  const times = extractPeriodTimesFromPlainText(text || "");
  const periodsFromOcr = Boolean(times && times.length >= 4);
  if (periodsFromOcr) state.periodStarts = [...times];

  const wordRows = buildScheduleFromWords(
    tessWords(rawWords),
    Math.max(state.periodStarts?.length ?? 8, 8),
  );
  const plainRows = parsePlainSubjectsPerRow(text || "", 14);

  /** @type {Partial<typeof DAY_IDS[number]>[]} */
  const merged = [];
  const limit = Math.min(14, Math.max(wordRows.length, plainRows.length, 1));

  for (let i = 0; i < limit; i++) {
    const wRow = wordRows[i];
    const pRow = plainRows[i];
    const useWord = !!(wRow && DAY_IDS.some((id) => wRow[id]));
    const pick =
      useWord ? { ...wRow } : pRow && DAY_IDS.some((id) => pRow[id]) ? { ...pRow } : null;

    if (pick && DAY_IDS.some((id) => pick[id])) merged.push(pick);
  }

  const rowCount = merged.length;

  if (!periodsFromOcr) {
    while (state.periodStarts.length < Math.max(rowCount, 1)) state.periodStarts.push("09:00");
    if (overwriteSubjects && rowCount > 0) state.periodStarts.length = Math.min(14, rowCount);
  } else if (rowCount > state.periodStarts.length) {
    while (state.periodStarts.length < Math.min(rowCount, 14)) {
      state.periodStarts.push(state.periodStarts[state.periodStarts.length - 1] ?? "09:25");
    }
  }

  ensureScheduleRows(state);

  if (!rowCount) return { rowCount: 0, periodsFromOcr };

  merged.forEach((row, pi) => {
    DAY_IDS.forEach((id) => {
      const raw = typeof row[id] === "string" ? row[id] : "";
      const incoming = raw.trim().length ? skipSubject(raw) : "";
      const prev = state.schedule[id][pi]?.subject?.trim() ?? "";
      state.schedule[id][pi] = { subject: overwriteSubjects ? incoming || "" : incoming || prev || "" };
    });
  });

  return { rowCount, periodsFromOcr };
}
function firedKey(dateStr, suffix) {
  return `${FIRED_PREFIX}${dateStr}:${suffix}`;
}

function wasFired(dateStr, suffix) {
  return localStorage.getItem(firedKey(dateStr, suffix)) === "1";
}

function markFired(dateStr, suffix) {
  localStorage.setItem(firedKey(dateStr, suffix), "1");
}

/** @param {string} title @param {string} body */
async function notifyUser(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && reg.showNotification) {
      await reg.showNotification(title, { body, icon: "", badge: "", tag: `school-${Date.now()}` });
    } else {
      new Notification(title, { body });
    }
  } catch {
    try {
      new Notification(title, { body });
    } catch {
      /* ignore */
    }
  }
}

function ensureScheduleRows(state) {
  const n = state.periodStarts.length;
  for (const id of DAY_IDS) {
    if (!state.schedule[id]) state.schedule[id] = [];
    const row = state.schedule[id];
    while (row.length < n) row.push({ subject: "" });
    row.length = n;
  }
}

function renderPeriodTimes(container, state) {
  container.innerHTML = "";
  state.periodStarts.forEach((start, i) => {
    const wrap = document.createElement("div");
    wrap.className = "period-row";
    wrap.innerHTML = `<label class="num">${i + 1}교시</label>`;
    const input = document.createElement("input");
    input.type = "time";
    input.value = start;
    input.dataset.index = String(i);
    input.addEventListener("change", () => {
      state.periodStarts[i] = input.value;
    });
    wrap.appendChild(input);
    container.appendChild(wrap);
  });
}

/** @param {HTMLTableSectionElement} body @param {*} state */
function renderSchedule(body, state) {
  body.innerHTML = "";
  const n = state.periodStarts.length;
  for (let i = 0; i < n; i++) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = String(i + 1);
    tr.appendChild(th);
    for (const day of DAY_IDS) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "과목";
      inp.value = state.schedule[day][i]?.subject || "";
      inp.addEventListener("input", () => {
        state.schedule[day][i] = { ...state.schedule[day][i], subject: inp.value.trim() };
      });
      td.appendChild(inp);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function updateTodaySummary(el, state) {
  const wi = weekdayIndexMon0();
  if (wi < 0) {
    el.innerHTML = `<span class="muted">오늘은 주말이에요. 다음 평일에 알림이 다시 맞춰집니다.</span>`;
    return;
  }
  const dayId = DAY_IDS[wi];
  const label = DAY_LABELS[dayId];
  const firstIdx = state.periodStarts.findIndex((_, i) => {
    const sub = state.schedule[dayId][i]?.subject?.trim();
    return sub && sub.length > 0;
  });
  if (firstIdx < 0) {
    el.innerHTML = `<span class="muted">${label}요일 시간표가 비어 있어요. 과목을 입력해 주세요.</span>`;
    return;
  }
  const start = state.periodStarts[firstIdx];
  const sub = state.schedule[dayId][firstIdx].subject;
  const schoolAt = parseTodayTime(start);
  const remindAt = schoolAt - state.remindSchoolBeforeMin * 60 * 1000;
  const fmt = (ts) =>
    new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  el.innerHTML = `${label}요일 첫 수업: <strong>${sub}</strong> (${firstIdx + 1}교시, ${start} 시작)<br>
    등교 준비 알림 예정: <strong>${fmt(remindAt)}</strong> (${state.remindSchoolBeforeMin}분 전)`;
}

/** @param {*} state */
function tickAlarms(state) {
  if (typeof document !== "undefined" && document.getElementById("remindSchoolBeforeMin")) {
    const rs = document.getElementById("remindSchoolBeforeMin");
    const rp = document.getElementById("remindPeriodBeforeMin");
    const ep = document.getElementById("enablePeriodReminders");
    state.remindSchoolBeforeMin = Math.min(180, Math.max(5, Number(rs?.value) || state.remindSchoolBeforeMin));
    state.remindPeriodBeforeMin = Math.min(30, Math.max(1, Number(rp?.value) || state.remindPeriodBeforeMin));
    if (ep) state.enablePeriodReminders = ep.checked;
  }

  if (Notification.permission !== "granted") return;

  const wi = weekdayIndexMon0();
  if (wi < 0) return;

  const dayId = DAY_IDS[wi];
  const todayStr = dateKeyLocal();
  const now = Date.now();

  const firstTeachingIdx = state.periodStarts.findIndex((_, i) => {
    const sub = state.schedule[dayId][i]?.subject?.trim();
    return sub && sub.length > 0;
  });

  if (firstTeachingIdx >= 0) {
    const start = parseTodayTime(state.periodStarts[firstTeachingIdx]);
    const fireAt = start - state.remindSchoolBeforeMin * 60 * 1000;
    const suffix = `school-${firstTeachingIdx}`;
    if (now >= fireAt && now < start && !wasFired(todayStr, suffix)) {
      const sub = state.schedule[dayId][firstTeachingIdx].subject;
      markFired(todayStr, suffix);
      void notifyUser(
        "등교 준비 알림",
        `${DAY_LABELS[dayId]}요일 첫 수업 「${sub}」이(가) ${state.remindSchoolBeforeMin}분 뒤에 시작해요.`,
      );
    }
  }

  if (state.enablePeriodReminders) {
    const before = Math.max(1, Number(state.remindPeriodBeforeMin) || 5);
    state.periodStarts.forEach((hhmm, i) => {
      const sub = state.schedule[dayId][i]?.subject?.trim();
      if (!sub) return;
      const start = parseTodayTime(hhmm);
      const fireAt = start - before * 60 * 1000;
      const suffix = `period-${i}`;
      if (now >= fireAt && now < start && !wasFired(todayStr, suffix)) {
        markFired(todayStr, suffix);
        void notifyUser(`${i + 1}교시 준비`, `곧 「${sub}」 수업입니다 (${before}분 전).`);
      }
    });
  }
}

async function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch {
    /* localhost file:// 에서 실패 가능 */
  }
}

function bindImageUpload(state, fileInput, preview, clearBtn) {
  function showPreview(url) {
    preview.innerHTML = "";
    if (!url) {
      clearBtn.hidden = true;
      return;
    }
    const img = document.createElement("img");
    img.src = url;
    img.alt = "올린 시간표";
    preview.appendChild(img);
    clearBtn.hidden = false;
  }

  showPreview(state.timetableImageDataUrl || null);

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 1_200_000) {
      alert("이미지가 너무 큽니다. 1.2MB 이하로 줄여 주세요.");
      fileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      state.timetableImageDataUrl = result;
      showPreview(result);
      fileInput.value = "";
    };
    reader.readAsDataURL(file);
  });

  clearBtn.addEventListener("click", () => {
    state.timetableImageDataUrl = null;
    showPreview(null);
  });
}

function main() {
  const state = loadState();
  ensureScheduleRows(state);

  const periodTimesGrid = document.getElementById("periodTimesGrid");
  const scheduleBody = document.getElementById("scheduleBody");
  const todaySummary = document.getElementById("todaySummary");
  const notifyStatus = document.getElementById("notifyStatus");
  const saveStatus = document.getElementById("saveStatus");
  const remindSchoolBeforeMin = document.getElementById("remindSchoolBeforeMin");
  const enablePeriodReminders = document.getElementById("enablePeriodReminders");
  const remindPeriodBeforeMin = document.getElementById("remindPeriodBeforeMin");
  const periodRemindWrap = document.getElementById("periodRemindWrap");
  const imagePreview = document.getElementById("imagePreview");

  remindSchoolBeforeMin.value = String(state.remindSchoolBeforeMin);
  enablePeriodReminders.checked = state.enablePeriodReminders;
  remindPeriodBeforeMin.value = String(state.remindPeriodBeforeMin);
  periodRemindWrap.hidden = !state.enablePeriodReminders;

  renderPeriodTimes(periodTimesGrid, state);
  renderSchedule(scheduleBody, state);
  updateTodaySummary(todaySummary, state);

  scheduleBody.addEventListener("input", (e) => {
    if (e.target.matches?.("input[type=text]")) updateTodaySummary(todaySummary, state);
  });

  periodTimesGrid.addEventListener("change", (e) => {
    if (e.target.matches?.("input[type=time]")) updateTodaySummary(todaySummary, state);
  });

  function refreshDerived() {
    ensureScheduleRows(state);
    renderPeriodTimes(periodTimesGrid, state);
    renderSchedule(scheduleBody, state);
    updateTodaySummary(todaySummary, state);
  }

  document.getElementById("addPeriod").addEventListener("click", () => {
    state.periodStarts.push("09:00");
    ensureScheduleRows(state);
    refreshDerived();
  });

  document.getElementById("removePeriod").addEventListener("click", () => {
    if (state.periodStarts.length <= 1) return;
    state.periodStarts.pop();
    ensureScheduleRows(state);
    refreshDerived();
  });

  function syncAlarmFieldsToState() {
    state.remindSchoolBeforeMin = Math.min(
      180,
      Math.max(5, Number(remindSchoolBeforeMin.value) || state.remindSchoolBeforeMin),
    );
    remindSchoolBeforeMin.value = String(state.remindSchoolBeforeMin);
    state.enablePeriodReminders = enablePeriodReminders.checked;
    periodRemindWrap.hidden = !state.enablePeriodReminders;
    state.remindPeriodBeforeMin = Math.min(
      30,
      Math.max(1, Number(remindPeriodBeforeMin.value) || state.remindPeriodBeforeMin),
    );
    remindPeriodBeforeMin.value = String(state.remindPeriodBeforeMin);
    updateTodaySummary(todaySummary, state);
  }

  remindSchoolBeforeMin.addEventListener("input", syncAlarmFieldsToState);
  remindPeriodBeforeMin.addEventListener("input", syncAlarmFieldsToState);

  enablePeriodReminders.addEventListener("change", () => {
    periodRemindWrap.hidden = !enablePeriodReminders.checked;
    syncAlarmFieldsToState();
  });

  document.getElementById("btnRequestNotify").addEventListener("click", async () => {
    if (!("Notification" in window)) {
      notifyStatus.textContent = "이 브라우저는 알림을 지원하지 않아요.";
      return;
    }
    const perm = await Notification.requestPermission();
    notifyStatus.textContent =
      perm === "granted"
        ? "알림이 허용되었어요."
        : perm === "denied"
          ? "알림이 거절되었어요. 브라우저 설정에서 이 사이트 알림을 켜 주세요."
          : "아직 허용되지 않았어요.";
  });

  document.getElementById("btnNotifyTest").addEventListener("click", async () => {
    if (!("Notification" in window)) {
      alert("이 브라우저에서는 알림이 없습니다.");
      return;
    }
    if (Notification.permission !== "granted") {
      alert('먼저 "알림 허용하기"를 눌러 주세요.');
      return;
    }
    await notifyUser("학교 시간표 알리미", "테스트 알림이 도착했어요.");
  });

  document.getElementById("btnSave").addEventListener("click", () => {
    state.remindSchoolBeforeMin = Math.min(
      180,
      Math.max(5, Number(remindSchoolBeforeMin.value) || 60),
    );
    remindSchoolBeforeMin.value = String(state.remindSchoolBeforeMin);
    state.enablePeriodReminders = enablePeriodReminders.checked;
    state.remindPeriodBeforeMin = Math.min(
      30,
      Math.max(1, Number(remindPeriodBeforeMin.value) || 5),
    );
    remindPeriodBeforeMin.value = String(state.remindPeriodBeforeMin);
    ensureScheduleRows(state);
    saveState(state);
    refreshDerived();
    saveStatus.textContent = "저장했어요.";
    setTimeout(() => {
      saveStatus.textContent = "";
    }, 2500);
  });

  bindImageUpload(state, document.getElementById("timetableImage"), imagePreview, document.getElementById("clearImage"));

  void registerSw();

  tickAlarms(state);
  setInterval(() => tickAlarms(state), 45_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tickAlarms(state);
  });
}

main();
