"use strict";
// BASE = всё до /reader/. Локально это "/", на GitHub Pages — "/<repo>/".
const BASE = location.pathname.replace(/\/reader\/.*$/, "/") || "/";

const $ = (id) => document.getElementById(id);
const els = {
  book: $("book"), prev: $("prev"), next: $("next"),
  pagenum: $("pagenum"), pagetotal: $("pagetotal"),
  zoom: $("zoom"), trstate: $("trstate"), wrap: $("pagewrap"), img: $("page"),
  overlay: $("overlay"), hint: $("hint"), popup: $("popup"),
  popWord: $("pop-word"), popSentence: $("pop-sentence"), popClose: $("popclose"),
};

let books = [];
let cur = null;          // current book {id, title, pages:[...]}
let vocab = {};          // word -> ru
let pageIdx = 0;         // 0-based index into cur.pages
let ocr = null;          // current page ocr json
let tr = null;           // current page tr json (or null)
let wordSentence = {};   // word index -> sentence id

// Tokenize like scripts/process.py: runs of letters (any script) with internal
// apostrophes/hyphens, then drop a French elision prefix (l', d', qu'...).
// A clicked OCR word like "français(e)." -> ["français"] -> vocab key "français".
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
  const start = books.find((b) => b.id === saved) || books[0];
  els.book.value = start.id;
  await selectBook(start.id);
}

async function selectBook(id) {
  cur = books.find((b) => b.id === id);
  if (!cur) return;
  localStorage.setItem("book", id);
  vocab = (await getJSON(`${BASE}books/${id}/vocab.json`)) || {};
  const hp = /[#&]p=(\d+)/.exec(location.hash);
  const savedPage = hp ? parseInt(hp[1], 10) - 1 : parseInt(localStorage.getItem("page:" + id) || "0", 10);
  pageIdx = Math.min(Math.max(0, savedPage), cur.pages.length - 1);
  await loadPage();
}

async function loadPage() {
  hidePopup();
  const stem = cur.pages[pageIdx];               // e.g. "p0001"
  const base = `${BASE}books/${cur.id}/pages/${stem}`;
  els.img.src = `${base}.webp`;
  ocr = await getJSON(`${base}.ocr.json`);
  tr = await getJSON(`${base}.tr.json`);
  localStorage.setItem("page:" + cur.id, String(pageIdx));

  els.pagenum.value = pageIdx + 1;
  els.pagetotal.textContent = cur.pages.length;
  els.hint.style.display = "none";
  const hasSent = tr && tr.sentences && Object.keys(tr.sentences).length > 0;
  if (hasSent) {
    els.trstate.textContent = "слова + предложения";
    els.trstate.className = "badge";
  } else if (Object.keys(vocab).length > 0) {
    els.trstate.textContent = "словарь слов";
    els.trstate.className = "badge";
  } else {
    els.trstate.textContent = "без перевода";
    els.trstate.className = "badge warn";
  }

  // map word -> sentence
  wordSentence = {};
  if (ocr) for (const s of ocr.sentences) for (const wi of s.words) wordSentence[wi] = s.id;

  renderOverlay();
  maybeAutoClick();
}

// Deep-link / test hook: #click=<wordIndex> opens that word's popup on load.
function maybeAutoClick() {
  const m = /[#&]click=(\d+)/.exec(location.hash);
  if (!m || !ocr) return;
  const i = parseInt(m[1], 10);
  const w = ocr.words.find((x) => x.i === i);
  const el = els.overlay.querySelector(`.word[data-i="${i}"]`);
  if (w && el) requestAnimationFrame(() => onWord(w, el));
}

function renderOverlay() {
  els.overlay.innerHTML = "";
  if (!ocr) return;
  const W = ocr.width, H = ocr.height;
  for (const w of ocr.words) {
    const d = document.createElement("div");
    d.className = "word" + (gloss(w.text) ? " has-tr" : "");
    d.style.left = (w.x / W * 100) + "%";
    d.style.top = (w.y / H * 100) + "%";
    d.style.width = (w.w / W * 100) + "%";
    d.style.height = (w.h / H * 100) + "%";
    d.dataset.i = w.i;
    d.addEventListener("click", (e) => { e.stopPropagation(); onWord(w, d); });
    els.overlay.appendChild(d);
  }
}

function phraseFor(i) {
  if (!tr || !tr.phrases) return null;
  for (const p of tr.phrases) if (p.words.includes(i)) return p;
  return null;
}

function onWord(w, el) {
  document.querySelectorAll(".word.active").forEach((n) => n.classList.remove("active"));
  el.classList.add("active");

  // word / phrase line
  const ph = phraseFor(w.i);
  let html;
  if (ph) {
    const span = ph.words.map((j) => ocr.words[j] && ocr.words[j].text).filter(Boolean).join(" ");
    html = `<span class="fr">${esc(span)}</span> — <span class="ru">${esc(ph.ru)}</span>`;
  } else {
    const g = gloss(w.text);
    html = g
      ? `<span class="fr">${esc(w.text)}</span> — <span class="ru">${esc(g)}</span>`
      : `<span class="fr">${esc(w.text)}</span> <span class="miss">— нет в словаре</span>`;
  }
  els.popWord.innerHTML = html;

  // sentence line
  const sid = wordSentence[w.i];
  const sObj = ocr.sentences.find((s) => s.id === sid);
  const ru = tr && tr.sentences ? tr.sentences[String(sid)] : null;
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
  if (r.bottom + ph + 12 > window.innerHeight)             // not enough room below
    top = window.scrollY + r.top - ph - 6;
  els.popup.style.left = Math.max(8, left) + "px";
  els.popup.style.top = Math.max(8, top) + "px";
}

function hidePopup() {
  els.popup.classList.add("hidden");
  document.querySelectorAll(".word.active").forEach((n) => n.classList.remove("active"));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function go(delta) {
  if (!cur) return;
  const n = pageIdx + delta;
  if (n < 0 || n >= cur.pages.length) return;
  pageIdx = n;
  loadPage();
}

// Jump to a 1-based page number typed into the box (clamped to range).
function goToInput() {
  if (!cur) return;
  const n = parseInt(els.pagenum.value, 10);
  if (Number.isNaN(n)) { els.pagenum.value = pageIdx + 1; return; }
  const target = Math.min(Math.max(1, n), cur.pages.length) - 1;
  if (target === pageIdx) { els.pagenum.value = pageIdx + 1; return; }  // nothing to do
  pageIdx = target;
  loadPage();
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
els.overlay.addEventListener("click", hidePopup);
els.zoom.addEventListener("input", (e) => { els.wrap.style.width = e.target.value + "%"; });
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") go(-1);
  else if (e.key === "ArrowRight") go(1);
  else if (e.key === "Escape") hidePopup();
});

loadBooks();
