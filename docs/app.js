
/* AI Map + ตัวหาเส้น EMA
   โหลด data.json ที่ GitHub Actions สร้างไว้ แล้วกรอง/จัดอันดับในเบราว์เซอร์
   จึงเลื่อนแถบหรือกดปุ่มแล้วเห็นผลทันที ไม่ต้องรอเซิร์ฟเวอร์ */

(function () {
  "use strict";

  var D = null, EMAS = [], PERIODS = [];
  var TREND_TH = { up: "ขาขึ้น", down: "ขาลง", flat: "ออกข้าง" };
  var PERIOD_TH = { "1d": "1 วัน", "1w": "1 สัปดาห์", "1m": "1 เดือน",
                    "3m": "3 เดือน", "ytd": "ต้นปีถึงปัจจุบัน", "1y": "1 ปี" };
  // เส้นยาวมีน้ำหนักมากกว่า เพราะเป็นแนวรับ/ต้านที่คนมองกันเยอะกว่า
  var W = { 5: 1, 10: 1, 20: 1.5, 50: 2, 100: 2.5, 200: 3 };

  var st = {
    page: "map",
    period: "1m", mapShow: "all",
    q: "", sector: "", theme: "", sort: "score",
    tol: 1.5, minNear: 1, trend: "all", side: "both", lines: []
  };

  var byTicker = {};

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function fmtM(v) {
    if (!v) return "";
    return v >= 1000 ? (v / 1000).toFixed(1) + " พันล้าน" : Math.round(v) + " ล้าน";
  }
  function sign(v) { return (v > 0 ? "+" : "") + v.toFixed(2); }
  function cls(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }

  /* ───────────────── โหลดข้อมูล ───────────────── */

  fetch("data.json?v=" + Date.now())
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(init)
    .catch(function (e) {
      $("meta").innerHTML = "โหลดข้อมูลไม่สำเร็จ (" + esc(e.message) + ") — " +
        "ถ้าเพิ่งอัปโค้ดขึ้น GitHub ให้ไปที่แท็บ Actions แล้วกด Run workflow ก่อนหนึ่งครั้ง";
    });

  function init(data) {
    D = data;
    EMAS = D.meta.emas;
    PERIODS = D.meta.periods;
    st.lines = EMAS.slice();

    D.rows.forEach(function (r) { byTicker[r.s] = r; });

    $("meta").innerHTML =
      "ข้อมูลปิดตลาดวันที่ <b>" + esc(D.meta.date) + "</b> · " +
      "หุ้น <b>" + D.meta.count + "</b> ตัว · " +
      "อัปเดตล่าสุด " + esc(D.meta.generated) + " (เวลาไทย)";
    if (D.meta.demo) $("demoBadge").hidden = false;

    var sel = $("sector");
    (D.meta.sectors || []).forEach(function (s) {
      sel.insertAdjacentHTML("beforeend",
        '<option value="' + esc(s) + '">' + esc(s) + "</option>");
    });
    var tsel = $("theme");
    (D.themes || []).forEach(function (t) {
      tsel.insertAdjacentHTML("beforeend",
        '<option value="' + esc(t.key) + '">' + esc(t.name) + "</option>");
    });

    var box = $("lines");
    EMAS.forEach(function (p) {
      var b = document.createElement("button");
      b.textContent = p;
      b.className = "on";
      b.addEventListener("click", function () {
        var i = st.lines.indexOf(p);
        if (i >= 0) {
          if (st.lines.length === 1) return;   // ต้องเหลืออย่างน้อย 1 เส้น
          st.lines.splice(i, 1); b.classList.remove("on");
        } else { st.lines.push(p); b.classList.add("on"); }
        renderEma();
      });
      box.appendChild(b);
    });

    wire();
    renderMap();
    renderEma();
  }

  /* ───────────────── หน้าที่ 1: AI Map ───────────────── */

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function sparkPath(h) {
    var step = h.length > 1 ? 100 / (h.length - 1) : 100, out = "";
    for (var i = 0; i < h.length; i++) {
      out += (i ? "L" : "M") + (i * step).toFixed(1) + " " +
             (26 - h[i] * 0.24).toFixed(1) + " ";
    }
    return out.trim();
  }

  function renderMap() {
    if (!D) return;
    var pi = PERIODS.indexOf(st.period);

    var groups = (D.themes || []).map(function (t) {
      var members = [];
      t.tickers.forEach(function (tk) {
        var r = byTicker[tk];
        if (!r) return;
        var pct = r.r[pi];
        if (pct === null || pct === undefined) return;   // ประวัติไม่ครบช่วงนี้
        members.push({ r: r, pct: pct });
      });
      members.sort(function (a, b) { return b.pct - a.pct; });

      var pcts = members.map(function (m) { return m.pct; });
      return {
        t: t, members: members,
        med: median(pcts),
        up: pcts.filter(function (x) { return x > 0; }).length,
        down: pcts.filter(function (x) { return x < 0; }).length,
        total: pcts.length
      };
    }).filter(function (g) { return g.total > 0; });

    // เรียงกล่องตามค่ากลาง กลุ่มแรงสุดอยู่บนสุด
    groups.sort(function (a, b) { return b.med - a.med || a.t.order - b.t.order; });

    $("groups").innerHTML = groups.map(function (g) {
      // ตัวกรองบวก/ลบซ่อนแค่การ์ด ค่าสรุปยังคิดจากสมาชิกทั้งหมดเสมอ
      var show = g.members.filter(function (m) {
        return st.mapShow === "all" ? true
             : st.mapShow === "up" ? m.pct > 0 : m.pct < 0;
      });

      var cards = show.map(function (m) {
        return '<button class="card ' + cls(m.pct) + '" data-tk="' + esc(m.r.s) + '">' +
          '<div class="row1"><span class="tk">' + esc(m.r.s) + '</span>' +
            '<span class="pct">' + sign(m.pct) + '%</span></div>' +
          '<div class="row2"><span class="nm">' + esc(m.r.n) + '</span>' +
            '<span class="px">$' + m.r.p + '</span></div></button>';
      }).join("");

      return '<section class="group ' + (g.med > 0 ? "pos" : g.med < 0 ? "neg" : "") + '">' +
        '<div class="ghead"><div class="gtitle"><h2>' + esc(g.t.name) + '</h2>' +
          (g.t.desc ? '<span class="gdesc">' + esc(g.t.desc) + "</span>" : "") + '</div>' +
        '<div class="gstats"><span class="tally">' +
          '<b class="up">▲ ' + g.up + '</b> / <b class="down">▼ ' + g.down + '</b>' +
          ' <span class="of">จาก ' + g.total + ' ตัว</span></span>' +
        '<span class="median ' + cls(g.med) + '">ค่ากลาง ' + sign(g.med) + '%</span>' +
        '</div></div>' +
        (cards ? '<div class="cards">' + cards + "</div>"
               : '<p class="none">ไม่มีตัวที่ตรงกับตัวกรองในกลุ่มนี้</p>') +
        "</section>";
    }).join("") || '<p class="empty">ไม่มีข้อมูลกลุ่ม — ตรวจไฟล์ themes.yml</p>';
  }

  /* ───────────────── หน้าที่ 2: หาเส้น EMA ───────────────── */

  function evaluate(r) {
    if (!r.d) return null;
    var near = [], score = 0;
    for (var i = 0; i < EMAS.length; i++) {
      var p = EMAS[i], d = r.d[i];
      if (st.lines.indexOf(p) < 0) continue;
      if (st.side === "above" && d < 0) continue;
      if (st.side === "below" && d > 0) continue;
      if (Math.abs(d) <= st.tol) {
        near.push(p);
        score += W[p] * (0.5 + 0.5 * (1 - Math.abs(d) / st.tol));
      }
    }
    if (!near.length) return null;

    if (r.a) score += 2;
    if (r.t === "up") score += 1;
    if (r.sl > 0) score += 0.5;

    var shortHit = near.some(function (p) { return p <= 20; });
    var longHit = near.some(function (p) { return p >= 50; });
    var sig;
    if (r.t === "up" && shortHit && near.length >= 2) sig = "ย่อเข้าหาเส้น (ขาขึ้น)";
    else if (r.t === "up" && longHit) sig = "ทดสอบแนวรับใหญ่";
    else if (r.t === "up") sig = "ย่อสั้น ๆ ในขาขึ้น";
    else if (r.t === "down" && longHit) sig = "เด้งชนแนวต้านใหญ่";
    else if (r.t === "down") sig = "เด้งชนเส้นสั้น (ขาลง)";
    else if (r.rb <= 3) sig = "เส้นบีบตัว (รอ breakout)";
    else sig = "ราคาชนเส้น";

    var nd = 999;
    near.forEach(function (p) {
      var v = Math.abs(r.d[EMAS.indexOf(p)]);
      if (v < nd) nd = v;
    });
    return { near: near, score: Math.round(score * 100) / 100, sig: sig, nd: nd };
  }

  var currentEma = [];

  function renderEma() {
    if (!D) return;
    $("tolOut").textContent = st.tol.toFixed(1) + "%";
    var q = st.q.toLowerCase();
    var themeSet = null;
    if (st.theme) {
      var t = (D.themes || []).filter(function (x) { return x.key === st.theme; })[0];
      themeSet = t ? t.tickers : [];
    }

    var out = [];
    D.rows.forEach(function (r) {
      if (!r.d) return;
      if (st.sector && r.g !== st.sector) return;
      if (themeSet && themeSet.indexOf(r.s) < 0) return;
      if (st.trend !== "all" && r.t !== st.trend) return;
      if (q && (r.s + " " + r.n + " " + r.g).toLowerCase().indexOf(q) < 0) return;
      var ev = evaluate(r);
      if (!ev || ev.near.length < st.minNear) return;
      out.push({ r: r, ev: ev });
    });

    var k = st.sort, di = PERIODS.indexOf("1d");
    out.sort(function (a, b) {
      if (k === "sym") return a.r.s.localeCompare(b.r.s);
      if (k === "near") return b.ev.near.length - a.ev.near.length || b.ev.score - a.ev.score;
      if (k === "dist") return a.ev.nd - b.ev.nd;
      if (k === "chg") return (b.r.r[di] || 0) - (a.r.r[di] || 0);
      if (k === "vol") return (b.r.v || 0) - (a.r.v || 0);
      return b.ev.score - a.ev.score;
    });
    currentEma = out;

    var up = 0, multi = 0, big = 0;
    out.forEach(function (o) {
      if (o.r.t === "up") up++;
      if (o.ev.near.length >= 3) multi++;
      if (o.ev.near.some(function (p) { return p >= 100; })) big++;
    });
    $("stats").innerHTML = [
      ["เข้าเงื่อนไข", out.length], ["อยู่ในขาขึ้น", up],
      ["ชน 3 เส้นขึ้นไป", multi], ["ชนเส้น 100/200", big]
    ].map(function (x) {
      return '<div class="stat"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + "</div></div>";
    }).join("");

    $("count").textContent = "แสดง " + out.length + " จาก " + D.meta.ema_count + " ตัว";
    $("emptyEma").hidden = out.length > 0;

    $("egrid").innerHTML = out.map(function (o) {
      var r = o.r, ev = o.ev, c = r.t === "up" ? "up" : r.t === "down" ? "down" : "";
      var chg = r.r[di] || 0;
      var chips = EMAS.map(function (p, i) {
        var d = r.d[i];
        var k2 = ev.near.indexOf(p) >= 0 ? "hit" : (st.lines.indexOf(p) < 0 ? "off" : "");
        return '<div class="e ' + k2 + '"><div class="lb">' + p + '</div>' +
               '<div class="dv">' + sign(d) + "</div></div>";
      }).join("");
      return '<button class="ecard ' + c + '" data-tk="' + esc(r.s) + '">' +
        '<div class="row1"><span class="tk">' + esc(r.s) + '</span>' +
          '<span class="chg ' + (chg >= 0 ? "p" : "n") + '">' + sign(chg) + '%</span>' +
          '<span class="px">$' + r.p + '</span></div>' +
        '<div class="nm">' + esc(r.n) + '</div>' +
        '<div class="badges"><span class="b ' + c + '">' + (TREND_TH[r.t] || "") + '</span>' +
          '<span class="b sig">' + ev.sig + '</span>' +
          (r.g ? '<span class="b">' + esc(r.g) + "</span>" : "") + '</div>' +
        '<div class="emas">' + chips + '</div>' +
        '<div class="efoot"><span>คะแนน <b>' + ev.score + '</b></span>' +
          '<span>ชน ' + ev.near.length + ' เส้น</span>' +
          (r.v ? "<span>" + fmtM(r.v) + "</span>" : "") + "</div></button>";
    }).join("");
  }

  /* ───────────────── หน้าต่างรายละเอียด ───────────────── */

  function openStock(tk) {
    var r = byTicker[tk];
    if (!r) return;
    var col = r.t === "up" ? "var(--up)" : r.t === "down" ? "var(--down)" : "var(--faint)";

    var perf = PERIODS.map(function (p, i) {
      var v = r.r[i];
      return '<div class="pcell"><div class="k">' + PERIOD_TH[p] + '</div>' +
             '<div class="v ' + (v === null ? "" : cls(v)) + '">' +
             (v === null ? "—" : sign(v) + "%") + "</div></div>";
    }).join("");

    var emaBlock = "";
    if (r.d) {
      emaBlock = '<h3>ระยะห่างจากเส้น EMA</h3><div class="emas big">' +
        EMAS.map(function (p, i) {
          var d = r.d[i], hit = Math.abs(d) <= st.tol;
          return '<div class="e ' + (hit ? "hit" : "") + '"><div class="lb">EMA ' + p + '</div>' +
                 '<div class="dv">' + sign(d) + "%</div></div>";
        }).join("") + "</div>" +
        '<p class="mnote">ช่องไฮไลต์ = อยู่ในระยะ ' + st.tol.toFixed(1) + '% ที่ตั้งไว้ในหน้าหาเส้น EMA · ' +
        'เทรนด์ <b>' + (TREND_TH[r.t] || "-") + '</b>' +
        (r.a ? ' · เส้นเรียงสวย 5&gt;10&gt;20&gt;50&gt;100&gt;200' : "") + "</p>";
    }

    var themes = (D.themes || []).filter(function (t) {
      return t.tickers.indexOf(tk) >= 0;
    }).map(function (t) { return '<span class="b">' + esc(t.name) + "</span>"; }).join("");

    $("modalBody").innerHTML =
      '<div class="mhead"><h2>' + esc(r.s) + '</h2>' +
        '<span class="mprice">$' + r.p + "</span></div>" +
      '<p class="mname">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</p>" +
      '<svg class="mspark" viewBox="0 0 100 28" preserveAspectRatio="none">' +
        '<path d="' + sparkPath(r.h) + '" fill="none" stroke="' + col +
        '" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>' +
      '<p class="mnote">ราคา 60 วันทำการล่าสุด</p>' +
      "<h3>ผลตอบแทนแต่ละช่วง</h3><div class='pgrid'>" + perf + "</div>" +
      emaBlock +
      (themes ? "<h3>ธีมที่สังกัด</h3><div class='badges'>" + themes + "</div>" : "") +
      (r.v ? '<p class="mnote">มูลค่าซื้อขายเฉลี่ย 20 วัน ' + fmtM(r.v) + " ดอลลาร์</p>" : "");

    $("modal").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    $("modal").hidden = true;
    document.body.style.overflow = "";
  }

  /* ───────────────── การควบคุม ───────────────── */

  function seg(id, key, cast, cb) {
    $(id).addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || !b.dataset.v) return;
      this.querySelectorAll("button[data-v]").forEach(function (x) {
        x.classList.remove("on");
      });
      b.classList.add("on");
      st[key] = cast ? cast(b.dataset.v) : b.dataset.v;
      cb();
    });
  }

  function wire() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("on"); });
        t.classList.add("on");
        st.page = t.dataset.page;
        var isMap = st.page === "map";
        $("pageMap").hidden = !isMap;
        $("pageEma").hidden = isMap;
        $("footMap").hidden = !isMap;
        $("footEma").hidden = isMap;
        $("pageTitle").textContent = isMap ? "AI Map" : "หุ้นที่ราคาใกล้เส้น EMA";
        window.scrollTo(0, 0);
      });
    });

    seg("period", "period", null, renderMap);
    seg("mapShow", "mapShow", null, renderMap);
    seg("minNear", "minNear", Number, renderEma);
    seg("trend", "trend", null, renderEma);
    seg("side", "side", null, renderEma);

    var timer;
    function later(fn) { clearTimeout(timer); timer = setTimeout(fn, 50); }

    $("q").addEventListener("input", function (e) {
      st.q = e.target.value.trim(); later(renderEma);
    });
    $("sector").addEventListener("change", function (e) { st.sector = e.target.value; renderEma(); });
    $("theme").addEventListener("change", function (e) { st.theme = e.target.value; renderEma(); });
    $("sort").addEventListener("change", function (e) { st.sort = e.target.value; renderEma(); });
    $("tol").addEventListener("input", function (e) {
      st.tol = parseFloat(e.target.value);
      $("tolOut").textContent = st.tol.toFixed(1) + "%";
      later(renderEma);
    });

    document.addEventListener("click", function (e) {
      var c = e.target.closest("[data-tk]");
      if (c) openStock(c.dataset.tk);
    });
    $("modalClose").addEventListener("click", closeModal);
    $("modal").addEventListener("click", function (e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });

    $("csv").addEventListener("click", function () {
      var di = PERIODS.indexOf("1d");
      var head = ["ชื่อย่อ", "ชื่อบริษัท", "หมวดธุรกิจ", "ราคา", "เปลี่ยนแปลงวันนี้%",
                  "เทรนด์", "สัญญาณ", "คะแนน", "ชนเส้น"]
                 .concat(EMAS.map(function (p) { return "ห่าง" + p; }));
      var lines = [head.join(",")];
      currentEma.forEach(function (o) {
        var r = o.r;
        lines.push([r.s, '"' + (r.n || "").replace(/"/g, "") + '"', '"' + r.g + '"',
                    r.p, r.r[di], TREND_TH[r.t] || r.t, '"' + o.ev.sig + '"',
                    o.ev.score, '"' + o.ev.near.join("/") + '"'].concat(r.d).join(","));
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")],
               { type: "text/csv;charset=utf-8" }));
      a.download = "หุ้นใกล้เส้น-EMA.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
})();
