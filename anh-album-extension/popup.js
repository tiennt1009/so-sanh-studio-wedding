const $ = (id) => document.getElementById(id);

// Các studio đã có thư mục; danh sách tự dài thêm sau mỗi lần tải.
const DEFAULT_STUDIOS = ["pixel-photography", "simplevows-studio", "semia-studio", "chapter-wedding-studio", "1989-wedding-studio", "seria-wedding"];

const slugFull = (s) =>
  (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .toLowerCase();
const slug = (s) => slugFull(s).slice(0, 60).replace(/-+$/, "");

const LOOKS_STUDIO = /studio|wedding|bridal|photo|vows/i;
const has = (text, word) => `-${text}-`.includes(`-${word}-`);

// Studio đã biết có tên nằm trong chuỗi này (chấp nhận thiếu chữ "studio" ở cuối).
function findKnown(text, known) {
  return known
    .flatMap((k) => {
      const short = k.replace(/-studio$/, "");
      return (short !== k && short.length >= 8 ? [k, short] : [k]).map((word) => ({ studio: k, word }));
    })
    .filter((x) => has(text, x.word))
    .sort((a, b) => LOOKS_STUDIO.test(b.studio) - LOOKS_STUDIO.test(a.studio) || b.word.length - a.word.length)[0];
}

// Đoán { studio, album } từ tiêu đề tab Facebook. Thứ tự tin cậy:
// 1) studio đã biết có tên trong tiêu đề, 2) người đăng / phần tiêu đề trông giống tên studio, 3) người đăng.
// (Người đăng có thể là cá nhân, ví dụ thợ chụp, nên không được đứng trên tên studio.)
function guessNames(title, author, known) {
  const parts = (title || "")
    .replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Facebook\s*$/i, "").replace(/^Facebook$/i, "")
    .split(/\s+[-|–]\s+/).filter((p) => slugFull(p));
  const full = parts.map(slugFull).join("-");
  const hit = findKnown(full, known) || (author ? findKnown(slugFull(author), known) : undefined);

  let studio, word; // word = đoạn tên studio cần bỏ khỏi tên bộ ảnh
  if (hit) ({ studio, word } = hit);
  else {
    const ends = parts.length > 1 ? [parts.length - 1, 0] : [];
    const keyword = ends.find((i) => parts[i].length <= 45 && LOOKS_STUDIO.test(parts[i]));
    let name;
    if (author && LOOKS_STUDIO.test(author)) name = author;
    else if (keyword !== undefined) name = parts[keyword];
    else name = author || (parts.length > 1 ? parts[parts.length - 1] : "");
    studio = slug(name) || "facebook";
    word = slugFull(name);
  }

  // Nếu một phần tiêu đề chỉ là tên studio (thêm vài chữ) thì bỏ cả phần đó, không thì chỉ cắt đúng đoạn tên.
  const at = parts.length > 1 && word
    ? parts.findIndex((p) => has(slugFull(p), word) && slugFull(p).length <= word.length + 12)
    : -1;
  let album = at >= 0 ? parts.filter((_, i) => i !== at).map(slugFull).join("-") : full;
  if (at < 0 && word) {
    for (const w of [studio, word]) album = `-${album}-`.replace(`-${w}-`, "-").replace(/^-+|-+$/g, "");
  }
  return { studio, album: slug(album) };
}

// Chạy trong trang Facebook: tên trang đăng bài, lấy từ nhãn các nút "... bài viết của X".
function readAuthor() {
  const count = new Map();
  for (const el of document.querySelectorAll("[aria-label]")) {
    const m = el.getAttribute("aria-label").normalize("NFC").match(/(?:bài viết của|post by)\s+(.+)$/i);
    const r = m && el.getBoundingClientRect();
    if (!r || r.width <= 1 || r.height <= 1) continue;
    // Chỉ tính nút đang thật sự nhìn thấy, bỏ bài khác nằm phía sau trình xem ảnh.
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && (el.contains(top) || top.contains(el))) count.set(m[1].trim(), (count.get(m[1].trim()) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

// Hiển thị trạng thái lưu trong background. Nếu việc đang chạy mà lâu không cập nhật thì coi như đã dừng.
function render(st) {
  if (!st) return;
  $("status").textContent = st.text;
  const stale = st.busy && Date.now() - (st.at || 0) > 30000;
  $("go").disabled = !!st.busy && !stale;
}

const today = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let saved = [];
  // Khoá mới "studioList": bỏ qua các tên đoán sai đã lỡ lưu ở bản trước.
  try { saved = (await chrome.storage.local.get("studioList")).studioList || []; } catch {}
  const known = [...new Set([...DEFAULT_STUDIOS, ...saved])];
  $("studios").replaceChildren(...known.map((k) => new Option(k, k)));

  let host = "";
  try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
  let names = { studio: slug(host), album: slug(tab.title) };
  if (/(^|\.)facebook\.com$/.test(host)) {
    let author = "";
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readAuthor });
      author = res?.result || "";
    } catch {}
    names = guessNames(tab.title, author, known);
  }
  $("studio").value = names.studio;
  $("album").value = names.album || `bai-viet-${today()}`;

  const hint = () => {
    $("hint").textContent = known.includes(slug($("studio").value)) ? "" : "⚠ Studio mới, kiểm tra lại tên trước khi tải.";
  };
  $("studio").addEventListener("input", hint);
  hint();

  // Trạng thái lần chạy gần nhất (kể cả khi popup vừa được mở lại).
  try { render((await chrome.storage.local.get("status")).status); } catch {}
  chrome.storage.onChanged.addListener((c) => { if (c.status) render(c.status.newValue); });

  $("go").addEventListener("click", async () => {
    const minSize = parseInt($("min").value, 10) || 700;
    // Luôn là <studio>/<bộ ảnh>: mỗi ô chỉ tạo đúng một cấp thư mục.
    const studio = slug($("studio").value) || "khac";
    const album = slug($("album").value) || `bai-viet-${today()}`;
    $("go").disabled = true;
    $("status").textContent = "Đang bắt đầu...";
    try { await chrome.storage.local.set({ studioList: [...new Set([...saved, studio])] }); } catch {}
    // Việc gom + tải chạy trong background, nên đóng popup vẫn tiếp tục.
    await chrome.runtime.sendMessage({ type: "collect", tabId: tab.id, minSize, folder: `${studio}/${album}` });
  });
}
init();
