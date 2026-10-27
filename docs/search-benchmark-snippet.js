// Bộ kiểm tra xếp hạng tìm kiếm (chạy trong Console của trang dict, sau khi TERMS đã nạp). Mục tiêu: tìm bằng chính tên (Hán/Việt/Anh/pinyin) phải ra mục đó ĐẦU TIÊN.
// Cách dùng: dán vào Console; đợi window.__bench.done === true; xem window.__bench.res (n/top1/top3) và window.__bench.fails.
(() => { window.__bench = { done: false, res: {}, fails: [], progress: 0 };
  state.group1 = 'all'; state.group2 = null; state.tab = 'vocab'; state.user = null;
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pool = TERMS.filter((t) => t.hz && t.vi && t.group1 !== 'Từ ghép Y Khoa'); const sample = []; const used = new Set();
  while (sample.length < 120) { const t = pool[Math.floor(rnd() * pool.length)]; if (!used.has(t.id)) { used.add(t.id); sample.push(t); } }
  const kinds = { hz: (t) => t.hz, vi: (t) => t.vi, en: (t) => t.en, py: (t) => t.py }; const n2 = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const jobs = []; Object.keys(kinds).forEach((k) => sample.forEach((t) => jobs.push([k, t]))); let i = 0; const t0 = performance.now();
  Object.keys(kinds).forEach((k) => { window.__bench.res[k] = { n: 0, top1: 0, top3: 0, miss: 0 }; });
  const step = () => { const end = Math.min(i + 8, jobs.length);
    for (; i < end; i++) { const [k, t] = jobs[i]; const q = kinds[k](t); if (!q || String(q).length < 2) continue; state.searchQuery = q; let list; try { list = getFiltered(); } catch (e) { continue; }
      const R = window.__bench.res[k]; R.n++; const idx = list.findIndex((x) => x.id === t.id); const same = (x) => x && x.hz === t.hz && n2(x.vi) === n2(t.vi);
      const ok1 = idx === 0 || same(list[0]); const ok3 = (idx >= 0 && idx < 3) || list.slice(0, 3).some(same); if (ok1) R.top1++; if (ok3) R.top3++; if (idx < 0) R.miss++;
      if (!ok1 && window.__bench.fails.length < 60) window.__bench.fails.push({ k, q: String(q).slice(0, 28), want: t.hz + '|' + t.vi, got: list[0] ? list[0].hz + '|' + list[0].vi : '-', pos: idx }); }
    window.__bench.progress = i / jobs.length; if (i < jobs.length) setTimeout(step, 0); else { window.__bench.done = true; window.__bench.ms = Math.round(performance.now() - t0); state.searchQuery = ''; } };
  setTimeout(step, 0); })();
