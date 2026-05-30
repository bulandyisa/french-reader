"use strict";

// BASE = всё до /reader/. Локально это "/", на GitHub Pages — "/<repo>/".
const BASE = location.pathname.replace(/\/reader\/.*$/, "/") || "/";

const $ = (id) => document.getElementById(id);
const els = {
  book: $("book"), prev: $("prev"), next: $("next"),
  pagenum: $("pagenum"), pagetotal: $("pagetotal"),
  zoom: $("zoom"), trstate: $("trstate"),
  pages: $("pages"), hint: $("hint"),
  popup: $("popup"),
  popWord: $("pop-word"), popSentence: $("pop-sentence"), popClose: $("popclose"),
};

let books = [];
let cur = null;          // current book {id, title, pages:[...]}
let vocab = {};          // word -> ru
let pageData = [];       // per-page: {ocr, tr, wordSentence} | "loading" | null
let pageBlocks = [];     // per-page DOM .page-block
let pageVisible = [];    // per-page IntersectionObserver ratio
let pageIdx = 0;         // index of currently-most-visible page

const TOKEN_RE = /\p{L}[\p{L}'’\-]*/gu;
function tokensOf(text) {
  const out = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0].split(/['’]/).pop().replace(/^-+|-+$/g, "");
    if (t.length >= 2) out.push(t);
  }
  return out;
}
function gloss(text) {
  for (const t of tokensOf(text)) if (vocab[t]) return vocab[t];
  return null;
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}

// Грузим ocr/tr страницы, как только она приближается к окну просмотра.
const loadObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) ensurePageData(+e.target.dataset.idx);
  }
}, { rootMargin: "600px 0px" });

// Следим за тем, какая страница сейчас «текущая» (наибольшая видимая часть).
const posObserver = new IntersectionObserver((entries) => {
  for (const e of entries) pageVisible[+e.target.dataset.idx] = e.intersectionRatio;
  let best = pageIdx, bestRatio = -1;
  for (let i = 0; i < pageVisible.length; i++) {
    if (pageVisible[i] > bestRatio) { bestRatio = pageVisible[i]; best = i; }
  }
  if (best !== pageIdx) {
    pageIdx = best;
    if (document.activeElement !== els.pagenum) els.pagenum.value = pageIdx + 1;
    if (cur) localStorage.setItem("page:" + cur.id, String(pageIdx));
    updateTrBadge();
  }
}, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });

async function loadBooks() {
  books = (await getJSON(`${BASE}api/books`)) || [];
  els.book.innerHTML = "";
  if (!books.length) {
    const o = document.createElement("option");
    o.textContent = "Нет обработанных учебников";
    els.book.appendChild(o);
    return;
  }
  for (const b of books) {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = `${b.title}  (${b.pages.length} стр., переведено ${b.translated})`;
    els.book.appendChild(o);
  }
  const saved = localStorage.getItem("book");
  const start = books.find(b => b.id === saved) || books[0];
  els.book.value = start.id;
  await selectBook(start.id);
}

async function selectBook(id) {
  cur = books.find(b => b.id === id);
  if (!cur) return;
  localStorage.setItem("book", id);
  vocab = (await getJSON(`${BASE}books/${id}/vocab.json`)) || {};
  buildPages();
  els.pagetotal.textContent = cur.pages.length;
  els.hint.style.display = "none";

  const hp = /[#&]p=(\d+)/.exec(location.hash);
  const saved = hp ? (parseInt(hp[1], 10) - 1)
                   : parseInt(localStorage.getItem("page:" + id) || "0", 10);
  const idx = Math.min(Math.max(0, saved), cur.pages.length - 1);
  pageIdx = idx;
  els.pagenum.value = idx + 1;
  scrollToPage(idx, "instant");
  updateTrBadge();
  maybeAutoClick();
}

function buildPages() {
  loadObserver.disconnect();
  posObserver.disconnect();
  els.pages.innerHTML = "";
  pageBlocks = [];
  pageData = new Array(cur.pages.length).fill(null);
  pageVisible = new Array(cur.pages.length).fill(0);
  for (let i = 0; i < cur.pages.length; i++) {
    const stem = cur.pages[i];
    const block = document.createElement("div");
    block.className = "page-block";
    block.dataset.idx = i;
    const img = document.createElement("img");
    img.className = "page";
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = `Страница ${i + 1}`;
    img.src = `${BASE}books/${cur.id}/pages/${stem}.webp`;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    block.appendChild(img);
    block.appendChild(overlay);
    els.pages.appendChild(block);
    pageBlocks.push(block);
    loadObserver.observe(block);
    posObserver.observe(block);
  }
}

async function ensurePageData(idx) {
  if (pageData[idx] != null || !cur) return;
  pageData[idx] = "loading";
  const stem = cur.pages[idx];
  const base = `${BASE}books/${cur.id}/pages/${stem}`;
  const [ocr, tr] = await Promise.all([
    getJSON(`${base}.ocr.json`),
    getJSON(`${base}.tr.json`),
  ]);
  const wordSentence = {};
  if (ocr) for (const s of ocr.sentences) for (const wi of s.words) wordSentence[wi] = s.id;
  pageData[idx] = { ocr, tr, wordSentence };
  const block = pageBlocks[idx];
  if (ocr && block) {
    block.style.aspectRatio = `${ocr.width} / ${ocr.height}`;
    renderOverlayFor(idx);
  }
  if (idx === pageIdx) updateTrBadge();
}

function renderOverlayFor(idx) {
  const data = pageData[idx];
  if (!data || typeof data !== "object" || !data.ocr) return;
  const block = pageBlocks[idx];
  const overlay = block.querySelector(".overlay");
  overlay.innerHTML = "";
  const W = data.ocr.width, H = data.ocr.height;
  for (const w of data.ocr.words) {
    const d = document.createElement("div");
    d.className = "word" + (gloss(w.text) ? " has-tr" : "");
    d.style.left = (w.x / W * 100) + "%";
    d.style.top = (w.y / H * 100) + "%";
    d.style.width = (w.w / W * 100) + "%";
    d.style.height = (w.h / H * 100) + "%";
    d.dataset.i = w.i;
    d.addEventListener("click", (e) => { e.stopPropagation(); onWord(idx, w, d); });
    overlay.appendChild(d);
  }
}

function updateTrBadge() {
  const data = pageData[pageIdx];
  const hasSent = data && typeof data === "object" && data.tr
    && data.tr.sentences && Object.keys(data.tr.sentences).length > 0;
  if (hasSent) {
    els.trstate.textContent = "слова + предложения"; els.trstate.className = "badge";
  } else if (Object.keys(vocab).length > 0) {
    els.trstate.textContent = "словарь слов"; els.trstate.className = "badge";
  } else {
    els.trstate.textContent = "без перевода"; els.trstate.className = "badge warn";
  }
}

function phraseFor(idx, i) {
  const data = pageData[idx];
  const tr = data && typeof data === "object" ? data.tr : null;
  if (!tr || !tr.phrases) return null;
  for (const p of tr.phrases) if (p.words.includes(i)) return p;
  return null;
}

function onWord(idx, w, el) {
  document.querySelectorAll(".word.active").forEach(n => n.classList.remove("active"));
  el.classList.add("active");
  const data = pageData[idx];
  const ph = phraseFor(idx, w.i);
  let html;
  if (ph) {
    const span = ph.words.map(j => data.ocr.words[j] && data.ocr.words[j].text).filter(Boolean).join(" ");
    html = `<span class="fr">${esc(span)}</span> — <span class="ru">${esc(ph.ru)}</span>`;
  } else {
    const g = gloss(w.text);
    html = g
      ? `<span class="fr">${esc(w.text)}</span> — <span class="ru">${esc(g)}</span>`
      : `<span class="fr">${esc(w.text)}</span> <span class="miss">— нет в словаре</span>`;
  }
  els.popWord.innerHTML = html;
  const sid = data.wordSentence[w.i];
  const sObj = data.ocr.sentences.find(s => s.id === sid);
  const ru = data.tr && data.tr.sentences ? data.tr.sentences[String(sid)] : null;
  if (sObj && (ru || sObj.text)) {
    els.popSentence.style.display = "";
    els.popSentence.innerHTML =
      `<span class="label">${ru ? "Предложение" : "Предложение (оригинал)"}</span>` +
      (sObj.text ? `<div class="fr">${esc(sObj.text)}</div>` : "") +
      (ru ? `<div>${esc(ru)}</div>` : "");
  } else {
    els.popSentence.style.display = "none";
  }
  showPopupAt(el);
}

function showPopupAt(el) {
  const r = el.getBoundingClientRect();
  els.popup.classList.remove("hidden");
  const pw = els.popup.offsetWidth, ph = els.popup.offsetHeight;
  let left = window.scrollX + r.left;
  let top = window.scrollY + r.bottom + 6;
  if (left + pw > window.scrollX + window.innerWidth - 8)
    left = window.scrollX + window.innerWidth - pw - 8;
  if (r.bottom + ph + 12 > window.innerHeight)
    top = window.scrollY + r.top - ph - 6;
  els.popup.style.left = Math.max(8, left) + "px";
  els.popup.style.top = Math.max(8, top) + "px";
}
function hidePopup() {
  els.popup.classList.add("hidden");
  document.querySelectorAll(".word.active").forEach(n => n.classList.remove("active"));
}

function headerHeight() { return document.getElementById("bar").offsetHeight; }
function scrollToPage(idx, behavior = "smooth") {
  if (!pageBlocks[idx]) return;
  hidePopup();
  const top = pageBlocks[idx].getBoundingClientRect().top + window.scrollY - headerHeight() - 8;
  window.scrollTo({ top, behavior });
}
function go(delta) {
  if (!cur) return;
  const n = pageIdx + delta;
  if (n < 0 || n >= cur.pages.length) return;
  scrollToPage(n);
}
function goToInput() {
  if (!cur) return;
  const n = parseInt(els.pagenum.value, 10);
  if (Number.isNaN(n)) { els.pagenum.value = pageIdx + 1; return; }
  const target = Math.min(Math.max(1, n), cur.pages.length) - 1;
  els.pagenum.value = target + 1;
  scrollToPage(target);
}

// Deep-link / test hook: #click=<wordIndex> открывает попап того слова.
function maybeAutoClick() {
  const m = /[#&]click=(\d+)/.exec(location.hash);
  if (!m) return;
  const wi = parseInt(m[1], 10);
  const tryClick = () => {
    const data = pageData[pageIdx];
    if (!data || typeof data !== "object" || !data.ocr) return false;
    const w = data.ocr.words.find(x => x.i === wi);
    const el = pageBlocks[pageIdx].querySelector(`.word[data-i="${wi}"]`);
    if (w && el) { onWord(pageIdx, w, el); return true; }
    return false;
  };
  if (tryClick()) return;
  const start = Date.now();
  const t = setInterval(() => {
    if (tryClick() || Date.now() - start > 5000) clearInterval(t);
  }, 100);
}

// events
els.book.addEventListener("change", (e) => selectBook(e.target.value));
els.prev.addEventListener("click", () => go(-1));
els.next.addEventListener("click", () => go(1));
els.pagenum.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { goToInput(); els.pagenum.blur(); }
  else if (e.key === "Escape") { els.pagenum.value = pageIdx + 1; els.pagenum.blur(); }
});
els.pagenum.addEventListener("focus", () => els.pagenum.select());
els.pagenum.addEventListener("blur", goToInput);
els.popClose.addEventListener("click", hidePopup);
els.zoom.addEventListener("input", (e) => {
  document.documentElement.style.setProperty("--page-width", e.target.value + "%");
});
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  if (e.key === "PageUp") { e.preventDefault(); go(-1); }
  else if (e.key === "PageDown") { e.preventDefault(); go(1); }
  else if (e.key === "Escape") hidePopup();
});
document.addEventListener("click", (e) => {
  // клик мимо попапа и мимо слова — скрыть попап
  if (els.popup.contains(e.target)) return;
  if (e.target.classList && e.target.classList.contains("word")) return;
  hidePopup();
});

loadBooks();
