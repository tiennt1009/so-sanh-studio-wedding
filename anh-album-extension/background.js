// Giữ tên file / thư mục do extension đặt, kể cả khi extension khác muốn đổi tên lượt tải.
const pending = new Map(); // url -> filename

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const name = pending.get(item.url) || pending.get(item.finalUrl);
  if (item.byExtensionId === chrome.runtime.id && name) {
    pending.delete(item.url);
    suggest({ filename: name, conflictAction: "uniquify" });
  } else {
    suggest();
  }
});

async function setStatus(text, busy) {
  try {
    await chrome.storage.local.set({ status: { text, busy, at: Date.now() } });
  } catch {}
}

// Chạy trong trang: gom URL ảnh lớn. Hàm phải tự chứa mọi thứ (được tiêm vào trang).
async function collectInPage(minSize) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = location.hostname;

  /* ---------- Facebook: mở trình xem ảnh và bấm "ảnh tiếp theo" ---------- */
  if (/(^|\.)facebook\.com$/.test(host)) {
    const fbid = () => new URLSearchParams(location.search).get("fbid");
    const visibleRect = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight ? r : null;
    };
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    const VC = 'img[data-visualcompletion="media-vc-image"]';
    let hasVC = false; // trang có đánh dấu ảnh của trình xem thì chỉ lấy ảnh đó
    // Ảnh đang hiện trong trình xem = ảnh lớn nhất trên màn hình (bỏ ảnh tải sẵn đang ẩn).
    const viewerImg = () => {
      let list = [...document.querySelectorAll(VC)];
      if (list.length) hasVC = true;
      else if (!hasVC) list = [...document.querySelectorAll("img")].filter((i) => i.naturalWidth >= minSize);
      return list.filter((i) => i.naturalWidth > 0 && visibleRect(i)).sort((a, b) => area(b) - area(a))[0];
    };
    const srcOf = (i) => i && (i.currentSrc || i.src);
    const fileOf = (i) => (srcOf(i) || "").split("?")[0].split("/").pop();
    // Chờ đến khi trình xem hiện một ảnh khác. Dựa vào ảnh, không dựa vào địa chỉ trang.
    const waitChange = async (file, ms) => {
      for (let t = 0; t < ms / 200; t++) {
        await sleep(200);
        const i = viewerImg();
        if (i && fileOf(i) !== file) return true;
      }
      return false;
    };
    const labelOf = (el) => (el.getAttribute("aria-label") || "").normalize("NFC");
    // Mọi nút "tiếp" nằm ngang tầm ảnh; trang có thể có nhiều nút tên giống nhau nên phải thử từng cái.
    const nextButtons = () => {
      const img = viewerImg();
      const ir = img && img.getBoundingClientRect();
      const rank = (el) => (/photo|ảnh/i.test(labelOf(el)) ? 1 : 0);
      return [...document.querySelectorAll("[aria-label]")]
        .filter((el) => {
          if (!/next|tiếp theo|ảnh tiếp|ảnh sau/i.test(labelOf(el))) return false;
          const r = visibleRect(el);
          if (!r) return false;
          if (!ir) return true;
          const cy = r.top + r.height / 2;
          return cy >= ir.top && cy <= ir.bottom;
        })
        .sort((a, b) => rank(b) - rank(a));
    };
    // Bấm giống chuột thật (đủ chuỗi pointer/mouse), vì nút của Facebook có thể bỏ qua click() trơn.
    const realClick = (el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const target = hit && el.contains(hit) ? hit : el;
      for (const type of ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const Ev = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        target.dispatchEvent(new Ev(type, {
          bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0,
          buttons: type.endsWith("down") ? 1 : 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
        }));
      }
    };
    const pressRight = () => {
      const target = viewerImg() || document.body;
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
      }
    };
    // Chuyển sang ảnh sau: thử các nút, cuối cùng thử phím mũi tên. Cách nào được thì lần sau dùng trước.
    let preferred = null;
    const advance = async (file) => {
      const tries = nextButtons().slice(0, 3).map((b) => ({ key: labelOf(b), go: () => realClick(b) }));
      tries.push({ key: "phím →", go: pressRight });
      tries.sort((a, b) => (b.key === preferred) - (a.key === preferred));
      for (const way of tries) {
        way.go();
        if (await waitChange(file, 5000)) { preferred = way.key; return true; }
      }
      return false;
    };
    // Bảng nhắc trên trang khi cần người dùng tự bấm.
    let banner = null;
    const showBanner = (n) => {
      if (!banner) {
        banner = document.createElement("div");
        banner.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#b5543a;color:#fff;font:600 15px/1.5 system-ui,sans-serif;padding:10px 18px;border-radius:10px;text-align:center;white-space:pre-line";
        document.documentElement.appendChild(banner);
      }
      banner.textContent = `Hãy tự bấm mũi tên → để qua từng ảnh. Đã lấy ${n} ảnh.\nXong thì dừng lại 20 giây (hoặc đi hết vòng), ảnh sẽ tự tải về.`;
    };

    // Chưa ở trình xem ảnh: bấm ảnh đầu tiên của bài.
    if (!/^\/photo/.test(location.pathname) || !fbid()) {
      const scope = document.querySelector('[role="dialog"] a[href*="/photo"] img')
        ? document.querySelector('[role="dialog"]')
        : document;
      const first = [...scope.querySelectorAll('a[href*="/photo"], a[href*="photo.php"]')].find((a) => a.querySelector("img"));
      if (!first) return { error: "Không thấy ảnh nào trong bài. Hãy mở link bài viết riêng (không phải bảng tin)." };
      first.click();
      for (let t = 0; t < 50 && !(fbid() && viewerImg()); t++) await sleep(200);
    }
    if (!fbid()) return { error: "Không mở được trình xem ảnh. Hãy tự bấm vào ảnh đầu tiên rồi chạy lại." };

    const urls = [];
    const files = new Set(); // tên file ảnh, vì cùng một ảnh có thể có nhiều URL khác tham số
    let manual = false;
    let note = "";
    window.__acCount = 0;
    window.__acManual = false;
    for (let t = 0; t < 40 && !viewerImg(); t++) await sleep(200);
    for (let k = 0; k < 300; k++) {
      const img = viewerImg();
      if (!img) break;
      const file = fileOf(img);
      if (files.has(file)) break; // đã vòng lại ảnh cũ
      files.add(file);
      urls.push(srcOf(img));
      window.__acCount = urls.length;
      if (!manual) {
        if (await advance(file)) { await sleep(500); continue; }
        if (urls.length > 1) break; // trước đó tự chuyển được: đây là ảnh cuối
        // Không tự chuyển được ngay từ ảnh đầu: để người dùng bấm, extension ghi lại.
        manual = true;
        window.__acManual = true;
      }
      showBanner(urls.length);
      if (!(await waitChange(file, 20000))) break;
      await sleep(500);
    }
    banner?.remove();
    window.__acManual = false;
    if (!urls.length) note = "Không thấy ảnh trong trình xem. Hãy bấm mở ảnh đầu tiên rồi chạy lại.";
    else if (manual && urls.length === 1) note = "Chỉ lấy được 1 ảnh vì không thấy chuyển sang ảnh khác.";
    return { urls, note };
  }

  /* ---------- Website thường: cuộn hết trang rồi gom ảnh lớn ---------- */
  const step = Math.max(400, Math.floor(innerHeight * 0.8));
  let y = 0;
  for (let i = 0; i < 400; i++) {
    window.scrollTo(0, y);
    await sleep(300);
    const h = document.documentElement.scrollHeight;
    if (y + innerHeight >= h) {
      await sleep(900);
      if (document.documentElement.scrollHeight <= h) break;
    }
    y += step;
  }
  await sleep(500);
  window.scrollTo(0, 0);

  const found = new Map();
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const add = (url, size) => {
    if (!url || url.startsWith("data:")) return;
    if (!size || size < minSize) return; // bỏ ảnh chưa tải hoặc ảnh nhỏ (logo, icon)
    let abs;
    try { abs = new URL(url, location.href); } catch { return; }
    if (!/^https?:$/.test(abs.protocol)) return;
    const path = abs.pathname;
    if (/logo|favicon|sprite|icon|emoji|rsrc\.php/i.test(path)) return;
    if (/\.(svg|gif)$/i.test(path)) return;
    const ids = path.match(uuidRe);
    const key = ids && ids.length ? ids[ids.length - 1] : abs.origin + path;
    const prev = found.get(key);
    if (!prev || size > prev.size) found.set(key, { url: abs.href, size });
  };
  for (const img of document.images) {
    const size = Math.max(img.naturalWidth, img.naturalHeight);
    add(img.currentSrc || img.src, size);
    if (img.srcset) {
      for (const part of img.srcset.split(",")) {
        const [u, d] = part.trim().split(/\s+/);
        const w = parseInt(d, 10);
        if (Number.isFinite(w) && /w$/.test(d)) add(u, w);
      }
    }
  }
  return { urls: [...found.values()].map((x) => x.url) };
}

// Đếm ảnh đang gom (đọc từ trang) để hiện tiến độ.
function readCount() {
  return { n: window.__acCount ?? 0, manual: !!window.__acManual };
}

// Chạy toàn bộ việc gom + tải trong background: đóng popup cũng không làm hỏng.
async function runCollect({ tabId, minSize, folder }) {
  let poll = null;
  try {
    await setStatus("Đang gom ảnh... (đừng đóng hay chuyển tab trang Facebook)", true);
    poll = setInterval(async () => {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: readCount });
        const { n = 0, manual = false } = r?.result ?? {};
        if (!poll) return; // đã gom xong, không ghi đè trạng thái cuối
        await setStatus(
          manual
            ? `Hãy tự bấm mũi tên → trên Facebook qua từng ảnh. Đã lấy ${n} ảnh.`
            : `Đang gom ảnh... đã thấy ${n} ảnh (đừng chuyển tab trang Facebook)`,
          true
        );
      } catch {}
    }, 1500);

    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectInPage,
      args: [minSize],
    });
    clearInterval(poll); poll = null;

    const out = res?.result || {};
    if (out.error) return await setStatus(out.error, false);
    const urls = out.urls || [];
    if (!urls.length) return await setStatus("Không tìm thấy ảnh nào. Thử giảm cạnh dài tối thiểu.", false);

    const items = urls.map((url, i) => {
      let ext = "jpg";
      const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|avif)$/i);
      if (m) ext = m[1].toLowerCase().replace("jpeg", "jpg");
      return { url, filename: `Anh-cuoi/${folder}/${String(i + 1).padStart(2, "0")}.${ext}` };
    });
    await setStatus(`Đang tải ${items.length} ảnh...`, true);
    let ok = 0;
    for (const { url, filename } of items) {
      pending.set(url, filename);
      try {
        await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
        ok++;
      } catch {
        pending.delete(url);
      }
    }
    await setStatus(`Xong: ${ok}/${urls.length} ảnh trong Anh-cuoi/${folder}/${out.note ? "\n" + out.note : ""}`, false);
  } catch (e) {
    await setStatus("Lỗi: " + e.message, false);
  } finally {
    if (poll) clearInterval(poll);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "collect") return;
  runCollect(msg); // không await: popup có thể đã đóng
  reply({ started: true });
  return false;
});
