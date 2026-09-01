/* AI Map + ตัวหาเส้น EMA
   โหลด data.json ที่ GitHub Actions สร้างไว้ แล้วกรอง/จัดอันดับในเบราว์เซอร์
   จึงเลื่อนแถบหรือกดปุ่มแล้วเห็นผลทันที ไม่ต้องรอเซิร์ฟเวอร์ */

(function () {
  "use strict";

  var VERSION = "15";          // เลขนี้ต้องตรงกับใน index.html
  var D = null, EMAS = [], PERIODS = [];
  var TREND_TH = { up: "ขาขึ้น", down: "ขาลง", flat: "ออกข้าง" };
  var PAGE_TITLE = {
    today: "เช้านี้", map: "AI Map", ema: "หุ้นที่ราคาใกล้เส้น EMA",
    top: "หุ้นโตแรง", watch: "หุ้นที่น่าจับตามอง",
    earn: "ผลประกอบการไตรมาส", cmp: "เทียบหุ้นในหมวดเดียวกัน",
    star: "หุ้นที่ติดดาวไว้"
  };
  var PERIOD_TH = { "1d": "1 วัน", "1w": "1 สัปดาห์", "1m": "1 เดือน",
                    "3m": "3 เดือน", "ytd": "ต้นปีถึงปัจจุบัน", "1y": "1 ปี" };
  // เส้นยาวมีน้ำหนักมากกว่า เพราะเป็นแนวรับ/ต้านที่คนมองกันเยอะกว่า
  var W = { 5: 1, 10: 1, 20: 1.5, 50: 2, 100: 2.5, 200: 3 };

  var st = {
    page: "map",
    tdScope: "all", tdCount: 10,
    period: "1m", mapShow: "all", topN: 10, expanded: {},
    q: "", sector: "", theme: "", sort: "score",
    tf: "d", tol: 1.5, minNear: 1, trend: "all", side: "both", pe: "all", lines: [],
    topPeriod: "1m", topDir: "up", topSector: "", topTheme: "",
    topCount: 10, topCap: "all",
    wSide: "all", wSector: "", wTheme: "", wSignal: "",
    eView: "cal", eOpen: {}, eSecOpen: {},
    eQuad: "all", eGrade: "all", eRecent: "all",
    eQ: "", eSector: "", eTheme: "", eSort: "score",
    cMode: "theme", cGroup: "", cView: "table", cSort: "score",
    sSort: "added", onlyStar: false
  };

  var byTicker = {};

  /* ───────────────── รายการที่ติดดาว ─────────────────

     เก็บในเบราว์เซอร์ของเครื่องนี้เท่านั้น (localStorage)
     เพราะเว็บเป็นไฟล์นิ่งบน GitHub Pages ไม่มีฐานข้อมูลและไม่มีระบบล็อกอิน
     จึงมีปุ่มส่งออก/นำเข้าไว้ย้ายข้อมูลข้ามเครื่อง

     เก็บอะไรบ้าง: วันที่กดดาว · ราคา ณ วันนั้น · เหตุผลที่พิมพ์ไว้
     ราคาตอนมาร์คสำคัญ เพราะทำให้ย้อนดูได้ว่าตั้งแต่สนใจมา ราคาไปทางไหน  */

  var STAR_KEY = "aimap.stars.v1";
  var stars = {};

  function loadStars() {
    try {
      var raw = window.localStorage.getItem(STAR_KEY);
      stars = raw ? JSON.parse(raw) : {};
      // ต้องเป็น object ธรรมดาเท่านั้น — array ก็นับเป็น object ใน JS จึงต้องกันด้วย
      if (typeof stars !== "object" || stars === null || Array.isArray(stars)) stars = {};
      // ตัดรายการที่รูปแบบไม่ถูกออก กันข้อมูลเสียทำให้หน้าพัง
      Object.keys(stars).forEach(function (k) {
        var v = stars[k];
        if (typeof v !== "object" || v === null || Array.isArray(v)) delete stars[k];
      });
    } catch (e) {
      stars = {};      // เบราว์เซอร์ปิด localStorage หรือข้อมูลเสีย
    }
  }

  function saveStars() {
    try {
      window.localStorage.setItem(STAR_KEY, JSON.stringify(stars));
      return true;
    } catch (e) {
      alert("บันทึกไม่ได้ — เบราว์เซอร์อาจปิดการเก็บข้อมูลไว้ " +
            "ลองปิดโหมดไม่ระบุตัวตน หรือใช้ปุ่มส่งออกเก็บไฟล์แทน");
      return false;
    }
  }

  function toggleStar(tk) {
    if (stars[tk]) {
      delete stars[tk];
    } else {
      var r = byTicker[tk];
      stars[tk] = {
        ts: (D && D.meta && D.meta.date) ? D.meta.date : "",
        iso: new Date().toISOString().slice(0, 10),
        px: r ? r.p : null,
        note: ""
      };
    }
    saveStars();
    refreshAll();
  }

  function starIcon(tk) {
    var on = !!stars[tk];
    return '<span class="star' + (on ? " on" : "") + '" data-star="' + esc(tk) +
      '" role="button" tabindex="0" title="' +
      (on ? "เอาออกจากรายการที่ติดดาว" : "เพิ่มเข้ารายการที่ติดดาว") +
      '">' + (on ? "★" : "☆") + "</span>";
  }

  function starCount() { return Object.keys(stars).length; }

  // ตัวกรอง "เฉพาะที่ติดดาว" ใช้ร่วมกันทุกหน้า เปิดที่หน้าใดก็มีผลทุกหน้า
  function passStar(tk) { return !st.onlyStar || !!stars[tk]; }

  function syncStarFilterButtons() {
    var n = starCount();
    document.querySelectorAll(".starfilter").forEach(function (b) {
      b.classList.toggle("on", st.onlyStar);
      b.disabled = n === 0 && !st.onlyStar;
      b.textContent = "★ เฉพาะที่ติดดาว" + (n ? " (" + n + ")" : "");
    });
  }

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

  var TH_M = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
              "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  function thDate(iso) {
    if (!iso) return "-";
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return iso;
    return (+p[2]) + " " + TH_M[(+p[1]) - 1] + " " + ((+p[0]) + 543);
  }

  // ขนาดเงินดอลลาร์เป็นภาษาไทย
  function money(v) {
    if (v == null) return "—";
    var a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + " ล้านล้าน";
    if (a >= 1e9) return (v / 1e9).toFixed(1) + " พันล้าน";
    if (a >= 1e6) return (v / 1e6).toFixed(0) + " ล้าน";
    return v.toLocaleString();
  }
  function num(v, d) { return v == null ? "—" : v.toFixed(d === undefined ? 2 : d); }
  function pctv(v, d) { return v == null ? "—" : (v * 100).toFixed(d === undefined ? 1 : d) + "%"; }

  // จัดขนาดบริษัทตามมูลค่าตลาด (เกณฑ์ที่ใช้กันทั่วไปในตลาดสหรัฐ)
  function capClass(mc) {
    if (mc == null) return "";
    if (mc >= 200e9) return "ขนาดใหญ่พิเศษ";
    if (mc >= 10e9) return "ขนาดใหญ่";
    if (mc >= 2e9) return "ขนาดกลาง";
    return "ขนาดเล็ก";
  }

  var REC_TH = {
    strong_buy: "แนะนำซื้อมาก", buy: "แนะนำซื้อ", hold: "ถือ",
    sell: "แนะนำขาย", underperform: "ต่ำกว่าตลาด", none: "—"
  };
  function cls(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }

  /* ───────────────── โหลดข้อมูล ───────────────── */

  var BT = null;          // ผลทดสอบย้อนหลัง โหลดแยก ไม่มีก็ไม่เป็นไร

  // ไฟล์นี้เป็นของเสริม ถ้าไม่มีก็ใช้งานได้ปกติ
  // ใช้ HEAD ตรวจก่อน จะได้ไม่มีข้อความ 404 ค้างใน console ของเบราว์เซอร์
  fetch("backtest.json?v=" + Date.now(), { method: "HEAD" })
    .then(function (r) {
      if (!r.ok) return null;
      return fetch("backtest.json?v=" + Date.now()).then(function (r2) {
        return r2.ok ? r2.json() : null;
      });
    })
    .then(function (d) {
      BT = d;
      if (BT && D) renderWatch();          // ถ้าข้อมูลหลักมาก่อน ให้วาดใหม่
    })
    .catch(function () { BT = null; });

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
      "อัปเดตล่าสุด " + esc(D.meta.generated) + " (เวลาไทย)" +
      ' <span class="ver">เวอร์ชัน ' + VERSION + "</span>";
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

    ["topSector", "topTheme", "wSector", "wTheme",
     "eSector", "eTheme"].forEach(function (id) {
      var el = $(id);
      var isSec = id.indexOf("Sector") >= 0;
      var src = isSec ? (D.meta.sectors || []) : (D.themes || []);
      src.forEach(function (x) {
        var v = isSec ? x : x.key;
        var t2 = isSec ? x : x.name;
        el.insertAdjacentHTML("beforeend",
          '<option value="' + esc(v) + '">' + esc(t2) + "</option>");
      });
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

    loadStars();
    wire();
    syncStarFilterButtons();
    updateTfNote();
    renderMap();
    renderEma();
    renderTop();
    renderWatch();
    renderEarn();
    renderCmp();
    renderStar();
    renderToday();
  }

  /* ───────────────── หน้าที่ 0: เช้านี้ ─────────────────

     รวมสิ่งที่ต้องดูทุกเช้าไว้หน้าเดียว ไม่ต้องเปิดข้ามแท็บ
     ทุกส่วนคำนวณจากข้อมูลชุดเดียวกับแท็บอื่น จึงตรงกันเสมอ    */

  function pctRank(v, arr) {
    // อยู่อันดับที่เท่าไหร่ในกลุ่ม คืนค่า 0-1 (1 = ดีสุดในกลุ่ม)
    if (v === null || v === undefined || arr.length < 2) return 0.5;
    var below = arr.filter(function (x) { return x < v; }).length;
    var same = arr.filter(function (x) { return x === v; }).length;
    return (below + same / 2) / arr.length;
  }

  var marketScore = null;     // คะแนนรวมเทียบกันทั้งตลาด

  function buildMarketScore() {
    var qi = PERIODS.indexOf("3m");
    var med = D.meta.sector_med || {};
    var items = D.rows.map(function (r) {
      var f = r.f || {};
      var mp = (med[r.g] || {}).pe;
      return {
        r: r, e: earnScore(f), r3: r.r[qi],
        cheap: (f.pe && mp) ? (mp / f.pe) : null
      };
    });
    var a3 = items.map(function (x) { return x.r3; })
                  .filter(function (v) { return v !== null && v !== undefined; });
    var ach = items.map(function (x) { return x.cheap; })
                   .filter(function (v) { return v !== null; });

    marketScore = {};
    items.forEach(function (x) {
      var mom = pctRank(x.r3, a3) * 25;
      var fun = x.e ? (x.e.score / 8) * 25 : 0;
      var val = x.cheap === null ? 0 : pctRank(x.cheap, ach) * 25;
      var tech = 0;
      if (x.r.d) {
        if (x.r.d[5] > 0) tech += 9;
        if (x.r.d[3] > 0) tech += 5;
        if (x.r.a) tech += 6;
        if (x.r.w && x.r.w.t === "up") tech += 5;
      }
      marketScore[x.r.s] = {
        score: Math.round((mom + fun + val + tech) * 10) / 10,
        parts: [
          { k: "โมเมนตัม", v: mom }, { k: "พื้นฐาน", v: fun },
          { k: "ราคาถูก", v: val }, { k: "เทคนิค", v: tech }
        ]
      };
    });
  }

  function tdPool() {
    var rows = D.rows;
    if (st.tdScope === "star") {
      rows = rows.filter(function (r) { return !!stars[r.s]; });
    } else if (st.tdScope === "theme") {
      var inTheme = {};
      (D.themes || []).forEach(function (t) {
        t.tickers.forEach(function (x) { inTheme[x] = 1; });
      });
      rows = rows.filter(function (r) { return inTheme[r.s]; });
    }
    return rows;
  }

  /* การ์ดสรุปที่ใช้ร่วมกันทุกส่วนในหน้านี้
     แสดงครบในใบเดียว: ราคา · วันนี้ · เส้นที่ชน · เกรดงบ · คะแนนรวม */
  function tdCard(r, extra) {
    var di = PERIODS.indexOf("1d"), mi = PERIODS.indexOf("1m");
    var chg = r.r[di], m1 = r.r[mi];
    var f = r.f || {};
    var ms = marketScore ? marketScore[r.s] : null;
    var e = earnScore(f);
    var tol = D.meta.near_tol || 1.5;

    var chips = "";
    if (r.d) {
      chips = '<div class="tdlines">' + EMAS.map(function (p, i) {
        var dv = r.d[i];
        var isNew = (r.nw || []).indexOf(p) >= 0;
        var hit = Math.abs(dv) <= tol;
        return '<span class="tdl' + (isNew ? " new" : hit ? " hit" : "") +
          '" title="EMA' + p + " ห่าง " + sign(dv) + '%">' + p + "</span>";
      }).join("") + "</div>";
    }

    var badges = "";
    if (r.t) badges += '<span class="b ' + (r.t === "up" ? "up" : r.t === "down" ? "down" : "") +
      '">' + (TREND_TH[r.t] || "") + "</span>";
    if (e) badges += '<span class="gbadge g' + e.grade + '">งบ ' + e.gradeTh + "</span>";
    if (r.tc) badges += '<span class="b sig">เทรนด์เปลี่ยนวันนี้ ' +
      (TREND_TH[r.tc] || r.tc) + " → " + (TREND_TH[r.t] || r.t) + "</span>";

    return '<div class="tdcard" data-tk="' + esc(r.s) + '" role="button" tabindex="0">' +
      '<div class="row1">' + starIcon(r.s) +
        '<span class="tk">' + esc(r.s) + "</span>" +
        '<span class="chg ' + ((chg || 0) >= 0 ? "p" : "n") + '">' +
          (chg === null || chg === undefined ? "—" : sign(chg) + "%") + "</span>" +
        '<span class="px">$' + r.p + "</span>" +
        (ms ? '<span class="tdscore" title="คะแนนรวมเทียบทั้งตลาด">' +
              ms.score.toFixed(0) + "</span>" : "") + "</div>" +
      '<div class="nm">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</div>" +
      (extra ? '<div class="tdextra">' + extra + "</div>" : "") +
      chips +
      '<div class="badges">' + badges + "</div>" +
      '<div class="tdfoot">1 เดือน ' +
        (m1 === null || m1 === undefined ? "—" : sign(m1) + "%") +
        (f.pe ? " · P/E " + num(f.pe, 1) : "") +
        (f.mc ? " · " + money(f.mc) : "") + "</div></div>";
  }

  function tdSection(title, why, list, extraFn) {
    if (!list.length) {
      return '<section class="tdsec"><div class="tdhead"><h2>' + title + "</h2>" +
        '<span class="tdwhy">' + why + "</span></div>" +
        '<p class="none">ไม่มีตัวที่เข้าเงื่อนไขในขอบเขตที่เลือก</p></section>';
    }
    return '<section class="tdsec"><div class="tdhead"><h2>' + title +
      ' <span class="tdn">' + list.length + "</span></h2>" +
      '<span class="tdwhy">' + why + "</span></div>" +
      '<div class="tdgrid">' +
      list.map(function (r) { return tdCard(r, extraFn ? extraFn(r) : ""); }).join("") +
      "</div></section>";
  }

  function renderToday() {
    if (!D) return;
    if (!marketScore) buildMarketScore();

    var pool = tdPool();
    var n = st.tdCount;
    var di = PERIODS.indexOf("1d");
    var tol = D.meta.near_tol || 1.5;

    // 1) ลงแรงวันนี้
    var down = pool.filter(function (r) {
      return r.r[di] !== null && r.r[di] !== undefined && r.r[di] < 0;
    }).sort(function (a, b) { return a.r[di] - b.r[di]; }).slice(0, n);

    // 2) เพิ่งมาถึงเส้นวันนี้
    var fresh = pool.filter(function (r) { return (r.nw || []).length; })
      .sort(function (a, b) {
        // เส้นยาวสำคัญกว่า แล้วค่อยดูว่าลงแรงกว่า
        var la = Math.max.apply(null, a.nw), lb = Math.max.apply(null, b.nw);
        return lb - la || (a.r[di] || 0) - (b.r[di] || 0);
      }).slice(0, n);

    // 3) คะแนนรวมสูงสุดทั้งตลาด
    var top = pool.slice().sort(function (a, b) {
      var sa = marketScore[a.s] ? marketScore[a.s].score : -1;
      var sb = marketScore[b.s] ? marketScore[b.s].score : -1;
      return sb - sa;
    }).slice(0, n);

    // 4) ที่ติดดาว
    var starred = D.rows.filter(function (r) { return !!stars[r.s]; })
      .sort(function (a, b) { return (a.r[di] || 0) - (b.r[di] || 0); });

    var html = "";
    html += tdSection("ลงแรงวันนี้",
      "เรียงจากลงหนักสุด · ตัวเลขในกล่องคือเส้น EMA ที่ราคาอยู่ในระยะ " +
      tol.toFixed(1) + "%", down);

    html += tdSection("เพิ่งมาถึงเส้นวันนี้",
      D.meta.prev_date
        ? "เมื่อวาน (" + thDate(D.meta.prev_date) + ") ยังไม่อยู่ในระยะ วันนี้เพิ่งเข้ามา · " +
          "เส้นสีเหลืองคือเส้นที่เพิ่งชน"
        : "ยังไม่มีข้อมูลของวันก่อนหน้าไว้เทียบ — รอบถัดไปจะเริ่มแสดงได้",
      fresh);

    html += tdSection("คะแนนรวมสูงสุดทั้งตลาด",
      "เทียบกันทั้ง " + D.meta.count + " ตัว · เลข 4 ด้านรวมเป็น 100 · " +
      "<b>อันดับสูงไม่ได้แปลว่าน่าซื้อ</b> เป็นแค่ตัวที่ตัวเลขดูดีที่สุด", top);

    if (starCount()) {
      html += tdSection("ที่ติดดาวไว้ วันนี้เป็นยังไง",
        "เรียงจากลงหนักสุด · ครบทุกตัวที่มาร์คไว้", starred);
    }

    $("todaySections").innerHTML = html;

    var scopeTh = { all: "ทั้งตลาด", theme: "เฉพาะหุ้นในธีม AI", star: "เฉพาะที่ติดดาว" };
    $("tdNote").innerHTML =
      "ข้อมูลปิดตลาดวันที่ <b>" + esc(D.meta.date) + "</b> · ขอบเขต <b>" +
      scopeTh[st.tdScope] + "</b> (" + pool.length + " ตัว)" +
      (D.meta.prev_date ? " · เทียบกับวันที่ " + thDate(D.meta.prev_date) : "") +
      (st.tdScope === "star" && !starCount()
        ? " — ยังไม่มีหุ้นที่ติดดาว กดรูปดาวบนการ์ดเพื่อเพิ่ม" : "");
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
        if (!passStar(m.r.s)) return false;
        return st.mapShow === "all" ? true
             : st.mapShow === "up" ? m.pct > 0 : m.pct < 0;
      });

      // เลือกตัวที่ "วิ่งแรง" = ขนาดการเปลี่ยนแปลงมากสุด ไม่ว่าขึ้นหรือลง
      // แล้วค่อยเรียงกลับจากบวกมากสุดลงไปหาลบมากสุดตอนแสดง
      var limit = st.expanded[g.t.key] ? 0 : st.topN;
      var hidden = 0;
      if (limit > 0 && show.length > limit) {
        var byMag = show.slice().sort(function (a, b) {
          return Math.abs(b.pct) - Math.abs(a.pct);
        }).slice(0, limit);
        hidden = show.length - byMag.length;
        byMag.sort(function (a, b) { return b.pct - a.pct; });
        show = byMag;
      }

      var cards = show.map(function (m) {
        return '<div class="card ' + cls(m.pct) + '" data-tk="' + esc(m.r.s) +
          '" role="button" tabindex="0">' +
          '<div class="row1">' + starIcon(m.r.s) +
            '<span class="tk">' + esc(m.r.s) + '</span>' +
            '<span class="pct">' + sign(m.pct) + '%</span></div>' +
          '<div class="row2"><span class="nm">' + esc(m.r.n) + '</span>' +
            '<span class="px">$' + m.r.p + '</span></div></div>';
      }).join("");

      var shownNote = hidden > 0
        ? '<span class="of">แสดง ' + show.length + " แรงสุด จาก " + g.total + " ตัว</span>"
        : '<span class="of">จาก ' + g.total + " ตัว</span>";

      return '<section class="group ' + (g.med > 0 ? "pos" : g.med < 0 ? "neg" : "") + '">' +
        '<div class="ghead"><div class="gtitle"><h2>' + esc(g.t.name) + '</h2>' +
          (g.t.desc ? '<span class="gdesc">' + esc(g.t.desc) + "</span>" : "") + '</div>' +
        '<div class="gstats"><span class="tally">' +
          '<b class="up">▲ ' + g.up + '</b> / <b class="down">▼ ' + g.down + '</b>' +
          ' ' + shownNote + '</span>' +
        '<span class="median ' + cls(g.med) + '">ค่ากลาง ' + sign(g.med) + '%</span>' +
        '</div></div>' +
        (cards ? '<div class="cards">' + cards + "</div>"
               : '<p class="none">ไม่มีตัวที่ตรงกับตัวกรองในกลุ่มนี้</p>') +
        (hidden > 0
          ? '<button class="more" data-more="' + esc(g.t.key) + '">ดูอีก ' +
            hidden + " ตัวในกลุ่มนี้</button>"
          : (st.expanded[g.t.key] && st.topN > 0
              ? '<button class="more" data-more="' + esc(g.t.key) +
                '">ย่อกลับเหลือ ' + st.topN + " ตัวที่แรงสุด</button>"
              : "")) +
        "</section>";
    }).join("") || '<p class="empty">ไม่มีข้อมูลกลุ่ม — ตรวจไฟล์ themes.yml</p>';
  }

  /* ───────────────── หน้าที่ 2: หาเส้น EMA ───────────────── */

  // คืนชุดระยะห่าง/เทรนด์ ตามไทม์เฟรมที่เลือก
  // รายวันเก็บไว้ที่ r.d · รายสัปดาห์อยู่ใน r.w.d
  function tfData(r) {
    if (st.tf === "w") {
      var w = r.w;
      return w ? { d: w.d, t: w.t, a: w.a, rb: null, sl: null } : null;
    }
    return r.d ? { d: r.d, t: r.t, a: r.a, rb: r.rb, sl: r.sl } : null;
  }

  function evaluate(r) {
    var X = tfData(r);
    if (!X) return null;
    var near = [], score = 0;
    for (var i = 0; i < EMAS.length; i++) {
      var p = EMAS[i], d = X.d[i];
      if (d === null || d === undefined) continue;   // เส้นนี้ข้อมูลไม่พอ
      if (st.lines.indexOf(p) < 0) continue;
      if (st.side === "above" && d < 0) continue;
      if (st.side === "below" && d > 0) continue;
      if (Math.abs(d) <= st.tol) {
        near.push(p);
        score += W[p] * (0.5 + 0.5 * (1 - Math.abs(d) / st.tol));
      }
    }
    if (!near.length) return null;

    if (X.a) score += 2;
    if (X.t === "up") score += 1;
    if (X.sl > 0) score += 0.5;

    var shortHit = near.some(function (p) { return p <= 20; });
    var longHit = near.some(function (p) { return p >= 50; });
    var sig;
    if (X.t === "up" && shortHit && near.length >= 2) sig = "ย่อเข้าหาเส้น (ขาขึ้น)";
    else if (X.t === "up" && longHit) sig = "ทดสอบแนวรับใหญ่";
    else if (X.t === "up") sig = "ย่อสั้น ๆ ในขาขึ้น";
    else if (X.t === "down" && longHit) sig = "เด้งชนแนวต้านใหญ่";
    else if (X.t === "down") sig = "เด้งชนเส้นสั้น (ขาลง)";
    else if (X.rb !== null && X.rb <= 3) sig = "เส้นบีบตัว (รอ breakout)";
    else sig = "ราคาชนเส้น";

    var nd = 999;
    near.forEach(function (p) {
      var v = Math.abs(X.d[EMAS.indexOf(p)]);
      if (v < nd) nd = v;
    });
    return { near: near, score: Math.round(score * 100) / 100, sig: sig, nd: nd, X: X };
  }

  // ช่วงค่า P/E ให้เลือก — ตัวที่ไม่มีค่า P/E มักเป็นบริษัทที่ยังขาดทุนอยู่
  var PE_RANGE = {
    "u20": [0, 20], "20-40": [20, 40], "40-70": [40, 70],
    "70-100": [70, 100], "o100": [100, Infinity]
  };

  function passPE(r) {
    if (st.pe === "all") return true;
    var v = (r.f || {}).pe;
    if (st.pe === "none") return v == null;
    if (v == null) return false;
    var b = PE_RANGE[st.pe];
    return b && v >= b[0] && v < b[1];
  }

  function updateTfNote() {
    var el = $("tfNote");
    if (!el) return;
    if (st.tf === "w") {
      el.innerHTML = "กราฟ<b>รายสัปดาห์</b> — หนึ่งแท่งคือหนึ่งสัปดาห์ " +
        "EMA200 จึงมองย้อนไปเกือบ 4 ปี · ข้อมูลถึงสัปดาห์ของวันที่ <b>" +
        thDate(D.meta.weekly_date) + "</b> (อัปเดตสัปดาห์ละครั้ง)";
    } else {
      el.innerHTML = "กราฟ<b>รายวัน</b> — หนึ่งแท่งคือหนึ่งวัน · อัปเดตทุกวันหลังตลาดปิด";
    }
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
      var X = tfData(r);
      if (!X) return;
      if (!passStar(r.s)) return;
      if (st.sector && r.g !== st.sector) return;
      if (themeSet && themeSet.indexOf(r.s) < 0) return;
      if (st.trend !== "all" && X.t !== st.trend) return;
      if (!passPE(r)) return;
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
      if (k === "pe") {
        var pa = (a.r.f || {}).pe, pb2 = (b.r.f || {}).pe;
        if (pa == null) return 1;              // ตัวที่ไม่มีค่าไปอยู่ท้าย
        if (pb2 == null) return -1;
        return pa - pb2;                       // ถูกสุดขึ้นก่อน
      }
      return b.ev.score - a.ev.score;
    });
    currentEma = out;

    var up = 0, multi = 0, big = 0;
    out.forEach(function (o) {
      if (o.ev.X.t === "up") up++;
      if (o.ev.near.length >= 3) multi++;
      if (o.ev.near.some(function (p) { return p >= 100; })) big++;
    });
    var pes = out.map(function (o) { return (o.r.f || {}).pe; })
                 .filter(function (v) { return v != null; });
    var medPe = pes.length ? median(pes).toFixed(1) : "—";

    $("stats").innerHTML = [
      ["เข้าเงื่อนไข", out.length], ["อยู่ในขาขึ้น", up],
      ["ชน 3 เส้นขึ้นไป", multi], ["ค่ากลาง P/E", medPe]
    ].map(function (x) {
      return '<div class="stat"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + "</div></div>";
    }).join("");

    var pool = st.tf === "w" ? (D.meta.weekly_count || 0) : D.meta.ema_count;
    $("count").textContent = "แสดง " + out.length + " จาก " + pool + " ตัว";
    $("emptyEma").hidden = out.length > 0;

    $("egrid").innerHTML = out.map(function (o) {
      var r = o.r, ev = o.ev, X = ev.X;
      var c = X.t === "up" ? "up" : X.t === "down" ? "down" : "";
      var chg = r.r[di] || 0;
      var pe = (r.f || {}).pe;
      var chips = EMAS.map(function (p, i) {
        var d = X.d[i];
        if (d === null || d === undefined) {
          return '<div class="e off"><div class="lb">' + p +
                 '</div><div class="dv">—</div></div>';
        }
        var k2 = ev.near.indexOf(p) >= 0 ? "hit" : (st.lines.indexOf(p) < 0 ? "off" : "");
        return '<div class="e ' + k2 + '"><div class="lb">' + p + '</div>' +
               '<div class="dv">' + sign(d) + "</div></div>";
      }).join("");
      return '<div class="ecard ' + c + '" data-tk="' + esc(r.s) +
        '" role="button" tabindex="0">' +
        '<div class="row1">' + starIcon(r.s) + '<span class="tk">' + esc(r.s) + '</span>' +
          '<span class="chg ' + (chg >= 0 ? "p" : "n") + '">' + sign(chg) + '%</span>' +
          '<span class="px">$' + r.p + '</span></div>' +
        '<div class="nm">' + esc(r.n) + '</div>' +
        '<div class="badges"><span class="b ' + c + '">' + (TREND_TH[X.t] || "") + '</span>' +
          '<span class="b sig">' + ev.sig + '</span>' +
          (r.g ? '<span class="b">' + esc(r.g) + "</span>" : "") + '</div>' +
        '<div class="emas">' + chips + '</div>' +
        '<div class="efoot"><span>คะแนน <b>' + ev.score + '</b></span>' +
          '<span>ชน ' + ev.near.length + ' เส้น</span>' +
          '<span>P/E ' + (pe == null ? "—" : num(pe, 1)) + "</span>" +
          (r.v ? "<span>" + fmtM(r.v) + "</span>" : "") + "</div></div>";
    }).join("");
  }

  /* ───────────────── หน้าที่ 3: หุ้นโตแรง ───────────────── */

  function renderTop() {
    if (!D) return;
    var pi = PERIODS.indexOf(st.topPeriod);
    var themeSet = null;
    if (st.topTheme) {
      var t = (D.themes || []).filter(function (x) { return x.key === st.topTheme; })[0];
      themeSet = t ? t.tickers : [];
    }

    var list = [];
    D.rows.forEach(function (r) {
      var pct = r.r[pi];
      if (pct === null || pct === undefined) return;   // ประวัติไม่ครบช่วงนี้
      if (!passStar(r.s)) return;
      if (st.topSector && r.g !== st.topSector) return;
      if (themeSet && themeSet.indexOf(r.s) < 0) return;
      var mc = (r.f || {}).mc;
      if (st.topCap === "big" && !(mc && mc >= 10e9)) return;
      if (st.topCap === "mid" && (mc == null || mc >= 10e9)) return;
      list.push({ r: r, pct: pct });
    });

    var eligible = list.length;
    list.sort(function (a, b) {
      return st.topDir === "up" ? b.pct - a.pct : a.pct - b.pct;
    });
    list = list.slice(0, st.topCount);

    $("topNote").innerHTML =
      "จัดอันดับจากหุ้น <b>" + eligible + "</b> ตัวที่มีประวัติราคาครบช่วง " +
      PERIOD_TH[st.topPeriod] +
      (st.topSector || st.topTheme || st.topCap !== "all" ? " (ตามตัวกรองที่เลือก)" : "") +
      " · คลิกแถวเพื่อดูรายละเอียด";

    if (!list.length) {
      $("toplist").innerHTML = '<p class="empty">ไม่มีหุ้นตรงเงื่อนไข</p>';
      return;
    }

    $("toplist").innerHTML = list.map(function (o, i) {
      var r = o.r, f = r.f || {};
      var c = o.pct > 0 ? "up" : o.pct < 0 ? "down" : "";
      var col = c === "up" ? "var(--up)" : c === "down" ? "var(--down)" : "var(--faint)";
      return '<div class="toprow ' + c + '" data-tk="' + esc(r.s) +
        '" role="button" tabindex="0">' +
        '<span class="rank">' + (i + 1) + "</span>" + starIcon(r.s) +
        '<span class="tinfo"><b>' + esc(r.s) + "</b>" +
          '<span class="tnm">' + esc(r.n) + "</span></span>" +
        '<svg class="tspark" viewBox="0 0 100 28" preserveAspectRatio="none">' +
          '<path d="' + sparkPath(r.h) + '" fill="none" stroke="' + col +
          '" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>' +
        '<span class="tcell tsec">' + esc(r.g || "-") + "</span>" +
        '<span class="tcell">$' + r.p + "</span>" +
        '<span class="tcell tpe">P/E ' + (f.pe == null ? "—" : num(f.pe, 1)) + "</span>" +
        '<span class="tcell tmc">' + (f.mc ? money(f.mc) : "—") + "</span>" +
        '<span class="tpct">' + sign(o.pct) + "%</span></div>";
    }).join("");
  }

  /* ───────────────── หน้าที่ 4: น่าจับตามอง ─────────────────

     ทุกสัญญาณคำนวณจากข้อมูลที่มีอยู่แล้ว ไม่ได้ดึงอะไรเพิ่ม
     แต่ละอันมีเงื่อนไขชัดเจนตรวจสอบย้อนได้ ไม่ใช่คะแนนลึกลับ
     จุดประสงค์คือชี้ว่า "ควรไปเปิดกราฟตัวไหนดู" ไม่ใช่บอกให้ซื้อหรือขาย  */

  var SIGNALS = [
    { k: "sup200", side: "up", name: "ทดสอบแนวรับ EMA200",
      why: "แนวรับใหญ่ที่คนมองกันมากที่สุด ราคามักเด้งหรือหลุดที่จุดนี้" },
    { k: "pullback", side: "up", name: "ย่อในขาขึ้นแข็งแรง",
      why: "เส้นเรียงสวยทุกเส้นแต่ราคาย่อมาแตะเส้นสั้น" },
    { k: "nearHi", side: "up", name: "ใกล้จุดสูงสุด 52 สัปดาห์",
      why: "ราคาใกล้ทำจุดสูงสุดใหม่ในรอบปี" },
    { k: "strong", side: "up", name: "แรงกว่าหมวดมาก",
      why: "ผลตอบแทน 1 เดือน สูงกว่าค่ากลางของหมวดเกิน 15 จุด" },
    { k: "bothTf", side: "up", name: "รายวันและรายสัปดาห์ตรงกัน",
      why: "ขาขึ้นทั้งสองไทม์เฟรม และชนเส้นทั้งคู่" },

    { k: "brk200", side: "down", name: "หลุดเส้น EMA200",
      why: "ราคาหลุดใต้แนวรับใหญ่ แต่โครงสร้างเส้นยังไม่พังทั้งหมด" },
    { k: "nearLo", side: "down", name: "ใกล้จุดต่ำสุด 52 สัปดาห์",
      why: "ราคาใกล้จุดต่ำสุดในรอบปี" },
    { k: "weak", side: "down", name: "อ่อนกว่าหมวดมาก",
      why: "ผลตอบแทน 1 เดือน ต่ำกว่าค่ากลางของหมวดเกิน 15 จุด" },
    { k: "res200", side: "down", name: "ชนแนวต้าน EMA200",
      why: "อยู่ในขาลงและราคาเด้งขึ้นมาชนเส้นใหญ่จากด้านล่าง" },

    { k: "squeeze", side: "watch", name: "เส้นบีบตัว",
      why: "เส้นทุกเส้นเบียดกัน มักตามด้วยการเคลื่อนไหวแรง แต่ยังไม่รู้ทิศ" },
    { k: "cheapUp", side: "watch", name: "P/E ต่ำกว่าหมวดแต่ยังขาขึ้น",
      why: "ราคาถูกกว่าเพื่อนในหมวดเกิน 30% ขณะที่แนวโน้มยังเป็นขาขึ้น" }
  ];
  var SIGMAP = {};
  SIGNALS.forEach(function (x) { SIGMAP[x.k] = x; });

  /* ป้ายบอกผลทดสอบย้อนหลังของสัญญาณนั้น

     ตัวเลขคือ "ส่วนต่างจากค่าเฉลี่ยหุ้นทั้งหมดในวันเดียวกัน"
     ถือต่ออีก 60 วันทำการ ไม่ใช่ผลตอบแทนดิบ
     +2% แปลว่าเคยทำได้ดีกว่าหุ้นทั่วไป 2 จุดโดยเฉลี่ย                */
  function btBadge(key) {
    if (!BT || !BT.signals || !BT.signals[key]) return "";
    var st2 = BT.signals[key]["h" + (BT.horizons ? BT.horizons[BT.horizons.length - 1] : 60)];
    if (!st2) return "";
    var cls = st2.n < (BT.min_samples || 100) ? "bt-none"
            : Math.abs(st2.tstat) < 2 ? "bt-none"
            : st2.excess_mean > 0 ? "bt-good" : "bt-bad";
    var txt = st2.n < (BT.min_samples || 100) ? "ตัวอย่างน้อย"
            : Math.abs(st2.tstat) < 2 ? "ไม่ต่างจากสุ่ม"
            : (st2.excess_mean > 0 ? "+" : "") + st2.excess_mean.toFixed(1) + "%";
    return ' <span class="btb ' + cls + '" title="ทดสอบย้อนหลัง ' +
      (BT.years || 3) + " ปี · พบ " + st2.n + " ครั้ง · ถือต่อ 60 วันทำการ · " +
      "ชนะตลาด " + st2.win_rate + '%">' + txt + "</span>";
  }

  var sectorRet = null;      // ค่ากลางผลตอบแทน 1 เดือน แยกตามหมวด

  function buildSectorRet() {
    var mi = PERIODS.indexOf("1m"), bucket = {};
    D.rows.forEach(function (r) {
      var v = r.r[mi];
      if (v === null || v === undefined || !r.g) return;
      (bucket[r.g] = bucket[r.g] || []).push(v);
    });
    sectorRet = {};
    Object.keys(bucket).forEach(function (g) {
      if (bucket[g].length >= 4) sectorRet[g] = median(bucket[g]);
    });
  }

  function watchSignals(r) {
    var out = [], d = r.d, w = r.w, f = r.f || {};
    var mi = PERIODS.indexOf("1m");
    var m1 = r.r[mi];
    var med = (D.meta.sector_med || {})[r.g] || {};
    var sret = sectorRet ? sectorRet[r.g] : undefined;

    function add(k, detail) { out.push({ k: k, detail: detail }); }

    if (d) {
      // ── ฝั่งบวก ──
      if (r.t === "up" && d[5] >= 0 && d[5] <= 2)
        add("sup200", "อยู่เหนือเส้น 200 เพียง " + num(d[5], 2) + "%");

      if (r.a && d.some(function (x, i) { return i <= 3 && Math.abs(x) <= 2; }))
        add("pullback", "เส้นเรียงสวยครบ และแตะเส้นสั้นในระยะ 2%");

      if (r.t === "down" && d[5] <= 0 && d[5] >= -2)
        add("res200", "อยู่ใต้เส้น 200 เพียง " + num(Math.abs(d[5]), 2) + "%");

      // หลุดเส้น 200 แต่ EMA50 ยังอยู่เหนือ EMA200 (โครงสร้างยังไม่พังหมด)
      if (d[5] < 0 && d[5] >= -4 && d[3] < d[5])
        add("brk200", "หลุดใต้เส้น 200 มา " + num(Math.abs(d[5]), 2) +
                      "% แต่เส้น 50 ยังอยู่เหนือเส้น 200");

      if (r.rb !== null && r.rb !== undefined && r.rb <= 3)
        add("squeeze", "กลุ่มเส้นกว้างแค่ " + num(r.rb, 2) + "% ของราคา");
    }

    if (f.hi && r.p >= f.hi * 0.97 && r.p <= f.hi * 1.02)
      add("nearHi", "ห่างจากจุดสูงสุด " + num((1 - r.p / f.hi) * 100, 1) + "%");
    if (f.lo && r.p <= f.lo * 1.03)
      add("nearLo", "ห่างจากจุดต่ำสุด " + num((r.p / f.lo - 1) * 100, 1) + "%");

    if (m1 !== null && m1 !== undefined && sret !== undefined) {
      if (m1 - sret >= 15)
        add("strong", "1 เดือน " + sign(m1) + "% · ค่ากลางหมวด " + sign(sret) + "%");
      if (sret - m1 >= 15)
        add("weak", "1 เดือน " + sign(m1) + "% · ค่ากลางหมวด " + sign(sret) + "%");
    }

    if (d && w && r.t === "up" && w.t === "up") {
      var nd = d.some(function (x) { return Math.abs(x) <= 2; });
      var nw = w.d.some(function (x) { return x !== null && Math.abs(x) <= 2; });
      if (nd && nw) add("bothTf", "ขาขึ้นทั้งรายวันและรายสัปดาห์ และชนเส้นทั้งคู่");
    }

    if (f.pe && med.pe && r.t === "up" && f.pe <= med.pe * 0.7)
      add("cheapUp", "P/E " + num(f.pe, 1) + " · ค่ากลางหมวด " + num(med.pe, 1));

    return out;
  }

  var currentWatch = [];

  function renderWatch() {
    if (!D) return;
    if (!sectorRet) buildSectorRet();

    var themeSet = null;
    if (st.wTheme) {
      var t = (D.themes || []).filter(function (x) { return x.key === st.wTheme; })[0];
      themeSet = t ? t.tickers : [];
    }

    var mi = PERIODS.indexOf("1m"), di = PERIODS.indexOf("1d");
    var out = [], counts = {};
    D.rows.forEach(function (r) {
      if (!passStar(r.s)) return;
      if (st.wSector && r.g !== st.wSector) return;
      if (themeSet && themeSet.indexOf(r.s) < 0) return;
      var sig = watchSignals(r);
      if (!sig.length) return;
      sig.forEach(function (x) { counts[x.k] = (counts[x.k] || 0) + 1; });
      if (st.wSignal && !sig.some(function (x) { return x.k === st.wSignal; })) return;
      if (st.wSide !== "all" &&
          !sig.some(function (x) { return SIGMAP[x.k].side === st.wSide; })) return;
      out.push({ r: r, sig: sig });
    });

    // เรียงจากตัวที่ติดหลายสัญญาณก่อน แล้วค่อยดูขนาดการเคลื่อนไหว
    out.sort(function (a, b) {
      return b.sig.length - a.sig.length ||
             Math.abs(b.r.r[mi] || 0) - Math.abs(a.r.r[mi] || 0);
    });
    currentWatch = out;

    // ปุ่มเลือกสัญญาณ สร้างครั้งเดียว
    var box = $("wSignal");
    if (box.dataset.built !== "1") {
      var html = '<button class="on" data-v="">ทั้งหมด</button>';
      SIGNALS.forEach(function (x) {
        html += '<button data-v="' + x.k + '" title="' + esc(x.why) + '">' +
                esc(x.name) + "</button>";
      });
      box.insertAdjacentHTML("beforeend", html);
      box.dataset.built = "1";
    }
    box.querySelectorAll("button[data-v]").forEach(function (bt) {
      var k = bt.dataset.v;
      if (!k) return;
      var n = counts[k] || 0;
      bt.disabled = n === 0;
      bt.style.opacity = n === 0 ? "0.35" : "";
      if (bt.dataset.base === undefined) bt.dataset.base = bt.textContent;
      bt.textContent = bt.dataset.base + " (" + n + ")";
    });

    $("wNote").innerHTML =
      "พบ <b>" + out.length + "</b> ตัวที่เข้าเงื่อนไขอย่างน้อยหนึ่งข้อ · " +
      "คำนวณจากราคาปิดวันที่ <b>" + esc(D.meta.date) + "</b> · " +
      "คลิกการ์ดเพื่อดูรายละเอียดหุ้น" +
      (BT ? "<br>ตัวเลขในวงเล็บข้างชื่อสัญญาณ = <b>ผลทดสอบย้อนหลัง " +
            (BT.years || 3) + " ปี</b> ว่าเคยดีกว่าหรือแย่กว่าค่าเฉลี่ยหุ้นทั้งหมดกี่จุด " +
            "เมื่อถือต่ออีก 60 วันทำการ (แตะป้ายเพื่อดูจำนวนครั้งที่พบ)"
          : "");

    $("wEmpty").hidden = out.length > 0;
    $("wgrid").innerHTML = out.map(function (o) {
      var r = o.r;
      var chg = r.r[di] || 0, m1 = r.r[mi];
      var ups = o.sig.filter(function (x) { return SIGMAP[x.k].side === "up"; }).length;
      var dns = o.sig.filter(function (x) { return SIGMAP[x.k].side === "down"; }).length;
      var cls = ups > dns ? "up" : dns > ups ? "down" : "";
      var tags = o.sig.map(function (x) {
        var S = SIGMAP[x.k];
        return '<div class="wsig ' + S.side + '" title="' + esc(S.why) + '">' +
          '<span class="wname">' + esc(S.name) + btBadge(x.k) + "</span>" +
          '<span class="wdetail">' + esc(x.detail) + "</span></div>";
      }).join("");
      return '<div class="wcard ' + cls + '" data-tk="' + esc(r.s) +
        '" role="button" tabindex="0">' +
        '<div class="row1">' + starIcon(r.s) + '<span class="tk">' + esc(r.s) + "</span>" +
          '<span class="chg ' + (chg >= 0 ? "p" : "n") + '">' + sign(chg) + "%</span>" +
          '<span class="px">$' + r.p + "</span></div>" +
        '<div class="nm">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</div>" +
        '<div class="wstats">1 เดือน <b class="' +
          (m1 > 0 ? "up" : m1 < 0 ? "down" : "") + '">' +
          (m1 === null || m1 === undefined ? "—" : sign(m1) + "%") + "</b>" +
          (r.f && r.f.pe ? " · P/E " + num(r.f.pe, 1) : "") + "</div>" +
        '<div class="wsigs">' + tags + "</div></div>";
    }).join("");
  }

  /* ───────────────── หน้าที่ 5: ผลประกอบการไตรมาส ─────────────────

     คะแนนงบคิดจากตัวเลขที่บริษัทรายงานแล้ว 4 อย่าง อย่างละ 0-2 คะแนน
     ทุกเกณฑ์เขียนไว้ตรง ๆ ตรวจย้อนได้ ไม่ใช่สูตรลับ

     สิ่งที่ทำไม่ได้และไม่ได้ทำ: เปรียบเทียบว่าผลออกมาดีกว่าหรือแย่กว่าที่
     นักวิเคราะห์คาด (EPS surprise) เพราะต้องดึงข้อมูลเพิ่มทีละตัว        */

  function earnScore(f) {
    if (!f) return null;
    var parts = [], total = 0, n = 0;

    function grade(label, val, good, ok, fmt) {
      if (val === null || val === undefined) return;
      var p = val >= good ? 2 : val >= ok ? 1 : 0;
      total += p; n++;
      parts.push({ label: label, val: fmt(val), p: p });
    }

    var pc = function (v) { return (v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; };
    var pn = function (v) { return (v * 100).toFixed(1) + "%"; };

    grade("รายได้เติบโต", f.rg, 0.15, 0.03, pc);
    // กำไรรายไตรมาสสะท้อนภาพล่าสุดกว่า ถ้าไม่มีค่อยใช้รายปี
    var eg = (f.eqg !== undefined && f.eqg !== null) ? f.eqg : f.eg;
    grade("กำไรเติบโต", eg, 0.15, 0.0, pc);
    grade("อัตรากำไรสุทธิ", f.pm, 0.15, 0.05, pn);
    grade("ROE", f.roe, 0.15, 0.07, pn);

    if (n < 2) return null;                 // ข้อมูลน้อยเกินจะให้เกรด

    var score = total / n * 4;              // ปรับให้เต็ม 8 เสมอ
    var g = score >= 6 ? "A" : score >= 4.5 ? "B" : score >= 3 ? "C" : "D";
    var GT = { A: "ดีมาก", B: "ดี", C: "ปานกลาง", D: "อ่อน" };
    return { score: Math.round(score * 10) / 10, grade: g, gradeTh: GT[g],
             parts: parts, used: n };
  }

  function daysSince(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  /* ปฏิทินประกาศงบ — จัดกลุ่มตามว่าจะประกาศเมื่อไหร่

     เรียงจากใกล้ที่สุดขึ้นก่อน เพื่อให้เห็นทันทีว่าวันนี้มีตัวไหนประกาศ
     ตัวที่เลยกำหนดแล้ว (Yahoo ยังไม่อัปเดต) แยกไปท้ายสุด
     เพื่อไม่ให้บังของที่กำลังจะเกิดขึ้นจริง                              */

  var EARN_BUCKETS = [
    { k: "today", icon: "📢", name: "ประกาศวันนี้",
      why: "บริษัทรายงานผลประกอบการวันนี้" },
    { k: "week", icon: "📅", name: "ภายในสัปดาห์นี้",
      why: "อีก 1–7 วันข้างหน้า" },
    { k: "month", icon: "🗓", name: "ภายในเดือนนี้",
      why: "อีก 8–31 วันข้างหน้า" },
    { k: "later", icon: "⏳", name: "อีกนาน",
      why: "เกิน 31 วันข้างหน้า" },
    { k: "done", icon: "✓", name: "รายงานแล้ว ข้อมูลอัปเดตเรียบร้อย",
      why: "งบชุดล่าสุดถูกดึงมาแล้ว ไม่ต้องรออะไร" },
    { k: "late", icon: "⚠️", name: "เลยวันประกาศแล้ว แต่ข้อมูลยังไม่อัปเดต",
      why: "บริษัทรายงานงบไปแล้ว แต่ Yahoo ยังไม่ส่งงบชุดใหม่มาให้ " +
           "ตัวเลขที่แสดงจึงยังเป็นไตรมาสก่อน ควรเช็กที่แหล่งอื่นก่อนใช้" }
  ];

  function daysUntil(iso) {
    if (!iso) return null;
    var t = Date.parse(String(iso).slice(0, 10) + "T00:00:00");
    if (isNaN(t)) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((t - today.getTime()) / 86400000);
  }

  function earnBucket(f) {
    // จัดกลุ่มตามวันที่ประกาศเป็นหลัก
    // ตัวที่ไตรมาสเก่าแต่ยังไม่ถึงวันประกาศ ยังอยู่กลุ่มตามวันปกติ
    // แล้วติดป้ายเตือนบนแถวแทน ไม่งั้นจะบังข้อมูลว่ามันกำลังจะประกาศเร็ว ๆ นี้
    var d = daysUntil(f.ed);
    if (d === null) return "done";
    if (d < 0 || f.edold) return "late";   // เลยวันประกาศแล้วแต่ข้อมูลยังเป็นชุดเก่า
    if (d === 0) return "today";
    if (d <= 7) return "week";
    if (d <= 31) return "month";
    return "later";
  }

  var currentEarn = [];

  function renderEarn() {
    if (!D) return;
    var q = st.eQ.toLowerCase();
    var themeSet = null;
    if (st.eTheme) {
      var t = (D.themes || []).filter(function (x) { return x.key === st.eTheme; })[0];
      themeSet = t ? t.tickers : [];
    }
    var qi = PERIODS.indexOf("3m"), di = PERIODS.indexOf("1d");

    var all = [], out = [];
    D.rows.forEach(function (r) {
      var e = earnScore(r.f);
      if (!e) return;
      var p3 = r.r[qi];
      var quad = null;
      if (p3 !== null && p3 !== undefined) {
        var good = e.grade === "A" || e.grade === "B";
        quad = good ? (p3 < 0 ? "gd" : "gu") : (p3 > 0 ? "bu" : "bd");
      }
      var item = { r: r, e: e, p3: p3, quad: quad, age: daysSince((r.f || {}).mrq) };
      all.push(item);

      if (!passStar(r.s)) return;
      if (st.eSector && r.g !== st.eSector) return;
      if (themeSet && themeSet.indexOf(r.s) < 0) return;
      if (q && (r.s + " " + r.n + " " + r.g).toLowerCase().indexOf(q) < 0) return;
      if (st.eGrade !== "all" && e.grade !== st.eGrade) return;
      if (st.eQuad !== "all" && quad !== st.eQuad) return;
      if (st.eRecent !== "all") {
        if (item.age === null || item.age > Number(st.eRecent)) return;
      }
      out.push(item);
    });

    var k = st.eSort;
    out.sort(function (a, b) {
      if (k === "gap") {
        // งบดีแต่ราคาลงมากสุดขึ้นก่อน
        var ga = a.e.score - (a.p3 === null ? 0 : a.p3) / 5;
        var gb = b.e.score - (b.p3 === null ? 0 : b.p3) / 5;
        return gb - ga;
      }
      if (k === "rg") return ((b.r.f || {}).rg || -9) - ((a.r.f || {}).rg || -9);
      if (k === "eg") {
        var ea = (a.r.f || {}).eqg, eb = (b.r.f || {}).eqg;
        if (ea === undefined || ea === null) ea = (a.r.f || {}).eg;
        if (eb === undefined || eb === null) eb = (b.r.f || {}).eg;
        return (eb === null || eb === undefined ? -9 : eb) -
               (ea === null || ea === undefined ? -9 : ea);
      }
      if (k === "recent") return (a.age === null ? 9999 : a.age) -
                                 (b.age === null ? 9999 : b.age);
      return b.e.score - a.e.score;
    });
    currentEarn = out;

    var cnt = { gd: 0, gu: 0, bu: 0, bd: 0 };
    all.forEach(function (x) { if (x.quad) cnt[x.quad]++; });
    $("eStats").innerHTML = [
      ["งบดี ราคาลง", cnt.gd], ["งบดี ราคาขึ้น", cnt.gu],
      ["งบแย่ ราคาขึ้น", cnt.bu], ["งบแย่ ราคาลง", cnt.bd]
    ].map(function (x) {
      return '<div class="stat"><div class="k">' + x[0] + '</div><div class="v">' +
             x[1] + "</div></div>";
    }).join("");

    $("eNote").innerHTML =
      "แสดง <b>" + out.length + "</b> จาก <b>" + all.length +
      "</b> ตัวที่มีตัวเลขงบพอให้เกรด · เทียบราคา 3 เดือน · " +
      "ตัวเลขเป็นผลประกอบการที่รายงานแล้ว ไม่ใช่การคาดการณ์";

    $("eEmpty").hidden = out.length > 0;
    var QT = { gd: ["งบดี ราคาลง", "gd"], gu: ["งบดี ราคาขึ้น", "gu"],
               bu: ["งบแย่ ราคาขึ้น", "bu"], bd: ["งบแย่ ราคาลง", "bd"] };

    var isCal = st.eView === "cal";
    $("eQuadLine").hidden = isCal;
    $("earnlist").className = isCal ? "ecallist" : "egrid2";
    if (isCal) { renderEarnCalendar(out, QT); return; }

    $("earnlist").innerHTML = out.map(function (o) {
      var r = o.r, e = o.e, f = r.f || {};
      var chg = r.r[di] || 0;
      var bars = e.parts.map(function (p) {
        return '<div class="ebar p' + p.p + '"><span class="ek">' + p.label +
               '</span><span class="ev">' + p.val + "</span></div>";
      }).join("");
      var qd = o.quad ? QT[o.quad] : null;
      return '<div class="ecard2 g' + e.grade + '" data-tk="' + esc(r.s) +
        '" role="button" tabindex="0">' +
        '<div class="row1">' + starIcon(r.s) + '<span class="tk">' + esc(r.s) + "</span>" +
          '<span class="chg ' + (chg >= 0 ? "p" : "n") + '">' + sign(chg) + "%</span>" +
          '<span class="px">$' + r.p + "</span></div>" +
        '<div class="nm">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</div>" +
        '<div class="egrade"><span class="gbadge g' + e.grade + '">งบ ' + e.gradeTh +
          " " + e.score.toFixed(1) + "/8</span>" +
          (qd ? '<span class="qbadge ' + qd[1] + '">' + qd[0] + "</span>" : "") +
          '<span class="p3">3 เดือน ' +
          (o.p3 === null || o.p3 === undefined ? "—" : sign(o.p3) + "%") + "</span></div>" +
        '<div class="ebars">' + bars + "</div>" +
        (f.edold || f.qold
          ? '<div class="staleq">' +
            (f.edold
              ? "เลยวันประกาศงบมา " + f.edold + " วันแล้ว — ตัวเลขที่แสดงยังเป็นงบไตรมาสก่อน"
              : "ไตรมาสล่าสุดเก่ากว่า " + f.qold + " วัน อาจมีงบใหม่ที่ยังไม่ได้ดึง") +
            "</div>"
          : "") +
        '<div class="efoot2">' +
          (f.mrq ? "งบไตรมาสถึง " + thDate(f.mrq) +
                   (o.age !== null ? " (" + o.age + " วันก่อน)" : "") : "ไม่ทราบไตรมาส") +
          (f.ed ? " · ประกาศงบครั้งหน้า " + thDate(f.ed) : "") +
        "</div></div>";
    }).join("");
  }

  /* แถวย่อในมุมมองปฏิทิน — สั้น 2 บรรทัด กดเพื่อกางดูรายละเอียด */
  function earnRow(o, QT) {
    var r = o.r, e = o.e, f = r.f || {};
    var di = PERIODS.indexOf("1d");
    var chg = r.r[di] || 0;
    var qd = o.quad ? QT[o.quad] : null;
    var d = daysUntil(f.ed);
    var when = f.ed
      ? (d === 0 ? "วันนี้" : d > 0 ? "อีก " + d + " วัน" : "เลยมา " + (-d) + " วัน")
      : "ไม่ทราบวัน";
    var open = !!st.eOpen[r.s];

    var detail = "";
    if (open) {
      detail = '<div class="erdetail">' +
        '<div class="ebars">' + e.parts.map(function (pp) {
          return '<div class="ebar p' + pp.p + '"><span class="ek">' + pp.label +
                 '</span><span class="ev">' + pp.val + "</span></div>";
        }).join("") + "</div>" +
        (f.edold || f.qold
          ? '<div class="staleq">' +
            (f.edold
              ? "เลยวันประกาศงบมา " + f.edold + " วันแล้ว — ตัวเลขด้านบนยังเป็นงบไตรมาสก่อน"
              : "ไตรมาสล่าสุดเก่ากว่า " + f.qold + " วัน อาจมีงบใหม่ที่ยังไม่ได้ดึง") +
            "</div>"
          : "") +
        '<div class="efoot2">' +
          (f.mrq ? "งบไตรมาสถึง " + thDate(f.mrq) +
                   (o.age !== null ? " (" + o.age + " วันก่อน)" : "") : "ไม่ทราบไตรมาส") +
          (f.ed ? " · ประกาศงบครั้งหน้า " + thDate(f.ed) : "") +
          " · คลิกชื่อหุ้นเพื่อดูรายละเอียดเต็ม" +
        "</div></div>";
    }

    return '<div class="erow' + (open ? " open" : "") + '">' +
      '<div class="erhead" data-eopen="' + esc(r.s) + '" role="button" tabindex="0">' +
        starIcon(r.s) +
        '<span class="erwhen' + (d === 0 ? " now" : d < 0 ? " late" : "") + '">' +
          when + "</span>" +
        '<span class="tk" data-tk="' + esc(r.s) + '" role="button" tabindex="0">' +
          esc(r.s) + "</span>" +
        '<span class="ernm">' + esc(r.n) + "</span>" +
        '<span class="chg ' + (chg >= 0 ? "p" : "n") + '">' + sign(chg) + "%</span>" +
        '<span class="px">$' + r.p + "</span>" +
        '<span class="gbadge g' + e.grade + '">' + e.gradeTh + " " + e.score.toFixed(1) +
          "</span>" +
        (qd ? '<span class="qbadge ' + qd[1] + '">' + qd[0] + "</span>" : "") +
        (f.qold && !f.edold
          ? '<span class="qwarn" title="ไตรมาสล่าสุดเก่ากว่า ' + f.qold +
            ' วัน อาจมีงบใหม่ที่ยังไม่ได้ดึง">งบเก่า</span>' : "") +
        '<span class="er3">3 เดือน ' +
          (o.p3 === null || o.p3 === undefined ? "—" : sign(o.p3) + "%") + "</span>" +
        '<span class="ercar">' + (open ? "▲" : "▼") + "</span>" +
      "</div>" + detail + "</div>";
  }

  function renderEarnCalendar(out, QT) {
    var groups = {};
    out.forEach(function (o) {
      var k = earnBucket(o.r.f || {});
      (groups[k] = groups[k] || []).push(o);
    });

    var html = EARN_BUCKETS.map(function (B) {
      var list = groups[B.k] || [];
      if (!list.length) return "";
      // เรียงตามวันที่ประกาศ ใกล้สุดขึ้นก่อน · กลุ่มเลยกำหนดเรียงจากเลยมานานสุด
      list.sort(function (a, b) {
        var da = daysUntil((a.r.f || {}).ed), db = daysUntil((b.r.f || {}).ed);
        if (da === null && db === null) return b.e.score - a.e.score;
        if (da === null) return 1;
        if (db === null) return -1;
        return B.k === "late" ? da - db : da - db;
      });
      // กลุ่มที่ใกล้จะประกาศกางไว้เลย ส่วนกลุ่มใหญ่ที่ยังอีกนานย่อไว้ก่อน
      // ไม่งั้นหน้าจะยาวเป็นหมื่นพิกเซลจนหาอะไรไม่เจอ
      var alwaysOpen = (B.k === "today" || B.k === "week");
      var opened = alwaysOpen || st.eSecOpen[B.k];
      var LIMIT = 10;
      var show = opened ? list : list.slice(0, LIMIT);
      var hidden = list.length - show.length;

      return '<section class="ecal"><div class="ecalhead">' +
        '<h2><span class="ecicon">' + B.icon + "</span>" + B.name +
        ' <span class="tdn">' + list.length + "</span></h2>" +
        '<span class="tdwhy">' + B.why + "</span></div>" +
        '<div class="erows">' +
        show.map(function (o) { return earnRow(o, QT); }).join("") +
        "</div>" +
        (hidden > 0
          ? '<button class="more" data-esec="' + B.k + '">ดูอีก ' + hidden +
            " ตัวในกลุ่มนี้</button>"
          : (opened && !alwaysOpen && list.length > LIMIT
              ? '<button class="more" data-esec="' + B.k + '">ย่อกลับเหลือ ' +
                LIMIT + " ตัว</button>"
              : "")) +
        "</section>";
    }).join("");

    $("earnlist").innerHTML = html ||
      '<p class="empty">ไม่มีหุ้นตรงเงื่อนไข</p>';
  }

  /* ───────────────── หน้าที่ 6: เทียบในหมวด ─────────────────

     สองมุมมองในหน้าเดียว
       1) ตารางเทียบ — เห็นสมาชิกทุกตัวเรียงกัน ไฮไลต์ผู้นำ "แต่ละด้านแยกกัน"
          จุดประสงค์คือให้เห็นว่าต้องแลกอะไร ไม่มีผู้ชนะรวม
       2) อันดับรวม — รวม 4 ด้านเป็นคะแนนเดียว เทียบกันเฉพาะในกลุ่ม
          พร้อมกางที่มาของคะแนนทุกด้าน และเตือนข้อจำกัดไว้ด้านบน

     ย้ำ: ทุกอย่างคำนวณจากข้อมูลย้อนหลัง ไม่เคยทดสอบว่าทำนายได้จริง     */


  function cmpMembers() {
    var list = [];
    if (st.cMode === "theme") {
      var t = (D.themes || []).filter(function (x) { return x.key === st.cGroup; })[0];
      if (!t) return { name: "", rows: [] };
      var by = {};
      D.rows.forEach(function (r) { by[r.s] = r; });
      t.tickers.forEach(function (tk) { if (by[tk]) list.push(by[tk]); });
      return { name: t.name, rows: list };
    }
    D.rows.forEach(function (r) { if (r.g === st.cGroup) list.push(r); });
    return { name: st.cGroup, rows: list };
  }

  function cmpCompute(rows) {
    var i3 = PERIODS.indexOf("3m"), i1 = PERIODS.indexOf("1y"),
        id = PERIODS.indexOf("1d");
    var med = (D.meta.sector_med || {});

    var items = rows.map(function (r) {
      var f = r.f || {};
      var e = earnScore(f);
      // ความถูก: P/E ต่ำกว่าค่ากลางหมวดของตัวเอง = ดี
      var mp = (med[r.g] || {}).pe;
      var cheap = (f.pe && mp) ? (mp / f.pe) : null;     // >1 = ถูกกว่าหมวด
      return {
        r: r, f: f, e: e,
        r3: r.r[i3], r1y: r.r[i1], d1: r.r[id],
        pe: f.pe === undefined ? null : f.pe,
        rg: f.rg === undefined ? null : f.rg,
        pm: f.pm === undefined ? null : f.pm,
        mc: f.mc === undefined ? null : f.mc,
        cheap: cheap
      };
    });

    // คะแนน 4 ด้าน ด้านละ 25 เทียบกันเฉพาะในกลุ่มนี้
    var a3 = items.map(function (x) { return x.r3; })
                  .filter(function (v) { return v !== null && v !== undefined; });
    var ach = items.map(function (x) { return x.cheap; })
                   .filter(function (v) { return v !== null; });

    items.forEach(function (x) {
      var mom = pctRank(x.r3, a3) * 25;
      var fun = x.e ? (x.e.score / 8) * 25 : 0;
      var val = x.cheap === null ? 0 : pctRank(x.cheap, ach) * 25;

      // เทรนด์เทคนิค: อยู่เหนือเส้นยาว + เส้นเรียงสวย + รายสัปดาห์หนุน
      var tech = 0;
      if (x.r.d) {
        if (x.r.d[5] > 0) tech += 9;          // เหนือ EMA200
        if (x.r.d[3] > 0) tech += 5;          // เหนือ EMA50
        if (x.r.a) tech += 6;                 // เส้นเรียงสวย
        if (x.r.w && x.r.w.t === "up") tech += 5;   // รายสัปดาห์เป็นขาขึ้น
      }
      x.parts = [
        { k: "โมเมนตัมราคา", v: mom, max: 25, note: "อันดับผลตอบแทน 3 เดือนในกลุ่ม" },
        { k: "พื้นฐาน", v: fun, max: 25, note: x.e ? "เกรดงบ " + x.e.gradeTh : "ไม่มีข้อมูลงบ" },
        { k: "ความถูกเทียบหมวด", v: val, max: 25,
          note: x.pe ? "P/E " + num(x.pe, 1) : "ไม่มีค่า P/E" },
        { k: "เทรนด์เทคนิค", v: tech, max: 25, note: "ตำแหน่งเทียบเส้น EMA" }
      ];
      x.score = Math.round((mom + fun + val + tech) * 10) / 10;
    });

    return items;
  }

  function renderCmp() {
    if (!D) return;

    // เติมตัวเลือกกลุ่มตามโหมด
    var sel = $("cGroup");
    var opts = st.cMode === "theme"
      ? (D.themes || []).map(function (t) { return [t.key, t.name]; })
      : (D.meta.sectors || []).map(function (g) { return [g, g]; });
    var want = opts.map(function (o) { return o[0]; }).join("|");
    if (sel.dataset.sig !== want) {
      sel.innerHTML = opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + "</option>";
      }).join("");
      sel.dataset.sig = want;
      if (!opts.some(function (o) { return o[0] === st.cGroup; })) {
        st.cGroup = opts.length ? opts[0][0] : "";
      }
      sel.value = st.cGroup;
    }

    var g = cmpMembers();
    var items = cmpCompute(g.rows);

    var isRank = st.cView === "rank";
    $("cWarn").hidden = !isRank;
    $("rgrid").hidden = !isRank;
    $("ctable").parentElement.hidden = isRank;
    $("cSortLine").hidden = false;

    if (!items.length) {
      $("cEmpty").hidden = false;
      $("ctable").innerHTML = "";
      $("rgrid").innerHTML = "";
      $("cLeaders").innerHTML = "";
      $("cNote").textContent = "";
      return;
    }
    $("cEmpty").hidden = true;

    // ── ผู้นำแต่ละด้าน ──
    function best(key, dir, fmt) {
      var pool = items.filter(function (x) {
        return x[key] !== null && x[key] !== undefined;
      });
      if (!pool.length) return null;
      pool.sort(function (a, b) { return dir * (b[key] - a[key]); });
      return { tk: pool[0].r.s, val: fmt(pool[0][key]) };
    }
    var leaders = [
      ["ผลตอบแทน 3 เดือนดีสุด", best("r3", 1, function (v) { return sign(v) + "%"; })],
      ["ผลตอบแทน 1 ปีดีสุด", best("r1y", 1, function (v) { return sign(v) + "%"; })],
      ["รายได้โตเร็วสุด", best("rg", 1, function (v) { return sign(v * 100) + "%"; })],
      ["อัตรากำไรสูงสุด", best("pm", 1, function (v) { return (v * 100).toFixed(1) + "%"; })],
      ["P/E ถูกสุด", best("pe", -1, function (v) { return num(v, 1) + " เท่า"; })],
      ["ขนาดใหญ่สุด", best("mc", 1, function (v) { return money(v); })]
    ].filter(function (x) { return x[1]; });

    $("cLeaders").innerHTML =
      '<div class="ldwrap"><div class="ldhead">ผู้นำแต่ละด้านในกลุ่ม ' + esc(g.name) +
      " (" + items.length + " ตัว)</div><div class=\"ldgrid\">" +
      leaders.map(function (x) {
        return '<button class="ldcell" data-tk="' + esc(x[1].tk) + '">' +
          '<span class="ldk">' + x[0] + "</span>" +
          '<span class="ldv"><b>' + esc(x[1].tk) + "</b> " + x[1].val + "</span></button>";
      }).join("") + "</div>" +
      '<p class="ldnote">หุ้นตัวเดียวมักไม่ได้นำทุกด้าน — ' +
      "ดูว่าตัวที่นำด้านหนึ่งต้องแลกกับอะไรในด้านอื่น</p></div>";

    // ── เรียงลำดับ ──
    var k = st.cSort;
    function num0(v) { return (v === null || v === undefined) ? -1e9 : v; }
    items.sort(function (a, b) {
      if (k === "sym") return a.r.s.localeCompare(b.r.s);
      if (k === "r3") return num0(b.r3) - num0(a.r3);
      if (k === "r1y") return num0(b.r1y) - num0(a.r1y);
      if (k === "pe") {
        var pa = a.pe === null ? 1e9 : a.pe, pb2 = b.pe === null ? 1e9 : b.pe;
        return pa - pb2;
      }
      if (k === "grade") return (b.e ? b.e.score : -1) - (a.e ? a.e.score : -1);
      if (k === "rg") return num0(b.rg) - num0(a.rg);
      if (k === "mc") return num0(b.mc) - num0(a.mc);
      return b.score - a.score;
    });

    $("cNote").innerHTML = isRank
      ? "คะแนนเทียบกันเฉพาะใน <b>" + esc(g.name) + "</b> · เปลี่ยนกลุ่มแล้วคะแนนเปลี่ยนตาม"
      : "ป้าย <b>ดีสุด</b> คือผู้นำด้านนั้นของกลุ่มนี้ · คลิกแถวเพื่อดูรายละเอียดหุ้น";

    if (isRank) { renderRankCards(items); return; }

    // ── ตารางเทียบ ──
    var bestOf = {};
    [["r3", 1], ["r1y", 1], ["rg", 1], ["pm", 1], ["mc", 1], ["pe", -1],
     ["score", 1]].forEach(function (x) {
      var pool = items.filter(function (i) {
        return i[x[0]] !== null && i[x[0]] !== undefined;
      });
      if (!pool.length) return;
      var b2 = pool.reduce(function (m, i) {
        return (x[1] * (i[x[0]] - m[x[0]]) > 0) ? i : m;
      });
      bestOf[x[0]] = b2.r.s;
    });
    var bestGrade = items.filter(function (i) { return i.e; })
      .sort(function (a, b) { return b.e.score - a.e.score; })[0];

    var head = ["หุ้น", "ราคา", "วันนี้", "3 เดือน", "1 ปี", "P/E", "เกรดงบ",
                "รายได้โต", "กำไรสุทธิ", "มูลค่า", "เทียบเส้น"];
    var html = "<thead><tr>" + head.map(function (h) {
      return "<th>" + h + "</th>";
    }).join("") + "</tr></thead><tbody>";

    html += items.map(function (x) {
      var r = x.r, f = x.f;
      function cell(v, key, cls) {
        var b2 = bestOf[key] === r.s ? ' <span class="bestb">ดีสุด</span>' : "";
        return '<td class="' + (cls || "") + '">' + v + b2 + "</td>";
      }
      var trend = r.d
        ? (r.d[5] > 0 ? '<span class="up">เหนือ 200</span>'
                      : '<span class="down">ใต้ 200</span>') +
          (r.a ? ' <span class="up">เรียงสวย</span>' : "")
        : "—";
      return '<tr data-tk="' + esc(r.s) + '">' +
        '<td class="csym">' + starIcon(r.s) + '<b>' + esc(r.s) + "</b>" +
        "<span>" + esc(r.n) + "</span></td>" +
        "<td>$" + r.p + "</td>" +
        '<td class="' + (x.d1 >= 0 ? "up" : "down") + '">' + sign(x.d1 || 0) + "%</td>" +
        cell(x.r3 === null ? "—" : sign(x.r3) + "%", "r3", x.r3 > 0 ? "up" : "down") +
        cell(x.r1y === null ? "—" : sign(x.r1y) + "%", "r1y", x.r1y > 0 ? "up" : "down") +
        cell(x.pe === null ? "—" : num(x.pe, 1), "pe") +
        '<td>' + (x.e ? '<span class="gbadge g' + x.e.grade + '">' + x.e.gradeTh + "</span>" +
          (bestGrade && bestGrade.r.s === r.s ? ' <span class="bestb">ดีสุด</span>' : "")
          : "—") + "</td>" +
        cell(x.rg === null ? "—" : sign(x.rg * 100) + "%", "rg") +
        cell(x.pm === null ? "—" : (x.pm * 100).toFixed(1) + "%", "pm") +
        cell(x.mc === null ? "—" : money(x.mc), "mc") +
        "<td>" + trend + "</td></tr>";
    }).join("") + "</tbody>";

    $("ctable").innerHTML = html;
  }

  function renderRankCards(items) {
    $("rgrid").innerHTML = items.map(function (x, i) {
      var r = x.r;
      var bars = x.parts.map(function (p) {
        var w = Math.max(0, Math.min(100, p.v / p.max * 100));
        return '<div class="pbrow"><span class="pbk">' + p.k + "</span>" +
          '<span class="pbbar"><i style="width:' + w.toFixed(0) + '%"></i></span>' +
          '<span class="pbv">' + p.v.toFixed(0) + "</span>" +
          '<span class="pbn">' + esc(p.note) + "</span></div>";
      }).join("");
      return '<div class="rcard" data-tk="' + esc(r.s) +
        '" role="button" tabindex="0">' +
        '<div class="row1"><span class="rrank">' + (i + 1) + "</span>" + starIcon(r.s) +
          '<span class="tk">' + esc(r.s) + "</span>" +
          '<span class="px">$' + r.p + "</span>" +
          '<span class="rscore">' + x.score.toFixed(0) + '<small>/100</small></span></div>' +
        '<div class="nm">' + esc(r.n) + "</div>" +
        '<div class="pbars">' + bars + "</div></div>";
    }).join("");
  }

  /* ───────────────── หน้าที่ 7: ที่ติดดาว ───────────────── */

  function renderStar() {
    if (!D) return;
    var tks = Object.keys(stars);
    $("starEmpty").hidden = tks.length > 0;
    $("starTab").textContent = "ที่ติดดาว" + (tks.length ? " (" + tks.length + ")" : "");

    if (!tks.length) {
      $("starlist").innerHTML = "";
      $("sNote").textContent = "";
      return;
    }

    var di = PERIODS.indexOf("1d"), mi = PERIODS.indexOf("1m");
    var items = tks.map(function (tk) {
      var r = byTicker[tk], st2 = stars[tk];
      var since = null;
      if (r && st2.px) since = (r.p / st2.px - 1) * 100;
      return { tk: tk, r: r, s: st2, since: since };
    });

    var k = st.sSort;
    items.sort(function (a, b) {
      if (k === "sym") return a.tk.localeCompare(b.tk);
      if (k === "since") return (b.since === null ? -1e9 : b.since) -
                                (a.since === null ? -1e9 : a.since);
      if (k === "d1") {
        var av = a.r ? (a.r.r[di] || 0) : -1e9, bv = b.r ? (b.r.r[di] || 0) : -1e9;
        return bv - av;
      }
      return (b.s.iso || "").localeCompare(a.s.iso || "");   // ใหม่สุดก่อน
    });

    var up = items.filter(function (x) { return x.since !== null && x.since > 0; }).length;
    var dn = items.filter(function (x) { return x.since !== null && x.since < 0; }).length;
    $("sNote").innerHTML =
      "มี <b>" + items.length + "</b> ตัว · ตั้งแต่กดดาว บวก <b class='up'>" + up +
      "</b> ลบ <b class='down'>" + dn + "</b> · " +
      "ราคาเทียบกับวันที่กด ไม่ใช่ราคาที่ซื้อจริง";

    $("starlist").innerHTML = items.map(function (x) {
      var r = x.r, st2 = x.s;
      if (!r) {
        return '<div class="scard gone"><div class="row1">' + starIcon(x.tk) +
          '<span class="tk">' + esc(x.tk) + "</span>" +
          '<span class="sgone">ไม่มีข้อมูลแล้ว (อาจหลุดจากดัชนี)</span></div>' +
          '<div class="snote"><textarea data-note="' + esc(x.tk) +
          '" rows="2" placeholder="เหตุผลที่สนใจ…">' + esc(st2.note || "") +
          "</textarea></div></div>";
      }
      var chg = r.r[di] || 0, m1 = r.r[mi];
      var sc = x.since === null ? "" : (x.since > 0 ? "up" : x.since < 0 ? "down" : "");
      var f = r.f || {};
      return '<div class="scard ' + sc + '">' +
        '<div class="row1">' + starIcon(x.tk) +
          '<span class="tk" data-tk="' + esc(x.tk) + '" role="button" tabindex="0">' +
            esc(x.tk) + "</span>" +
          '<span class="chg ' + (chg >= 0 ? "p" : "n") + '">' + sign(chg) + "%</span>" +
          '<span class="px">$' + r.p + "</span></div>" +
        '<div class="nm">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</div>" +
        '<div class="smeta">' +
          "<span>กดดาว " + thDate(st2.iso) +
            (st2.px ? " ที่ $" + num(st2.px, 2) : "") + "</span>" +
          (x.since === null ? ""
            : '<span class="ssince ' + sc + '">ตั้งแต่นั้น ' + sign(x.since) + "%</span>") +
          '<span>1 เดือน ' + (m1 === null || m1 === undefined ? "—" : sign(m1) + "%") + "</span>" +
          (f.pe ? "<span>P/E " + num(f.pe, 1) + "</span>" : "") +
        "</div>" +
        '<div class="snote"><textarea data-note="' + esc(x.tk) +
          '" rows="2" placeholder="เหตุผลที่สนใจ… (พิมพ์แล้วบันทึกเอง)">' +
          esc(st2.note || "") + "</textarea></div></div>";
    }).join("");
  }

  function exportStars() {
    var payload = { app: "ai-map", version: 1,
                    exported: new Date().toISOString(), stars: stars };
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)],
             { type: "application/json" }));
    a.download = "หุ้นที่ติดดาว-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importStars(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var d = JSON.parse(fr.result);
        var incoming = d && d.stars ? d.stars : d;
        if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
          throw new Error("รูปแบบไม่ถูก");
        }
        var added = 0, kept = 0;
        Object.keys(incoming).forEach(function (tk) {
          if (stars[tk]) { kept++; return; }         // ของเดิมไม่ทับ
          var v = incoming[tk] || {};
          stars[tk] = { ts: v.ts || "", iso: v.iso || "", px: v.px || null,
                        note: typeof v.note === "string" ? v.note : "" };
          added++;
        });
        saveStars();
        refreshAll();
        alert("นำเข้าสำเร็จ เพิ่มใหม่ " + added + " ตัว" +
              (kept ? " · มีอยู่แล้ว " + kept + " ตัว (ไม่ทับของเดิม)" : ""));
      } catch (e) {
        alert("ไฟล์ไม่ถูกต้อง — ต้องเป็นไฟล์ที่ส่งออกจากหน้านี้เท่านั้น");
      }
    };
    fr.readAsText(file);
  }

  /* วาดใหม่ทุกหน้าที่มีปุ่มดาว เพื่อให้สถานะดาวตรงกันทั้งเว็บ */
  function refreshAll() {
    syncStarFilterButtons();
    renderToday();
    renderMap();
    renderEma();
    renderTop();
    renderWatch();
    renderEarn();
    renderCmp();
    renderStar();
  }

  /* ───────────────── หน้าต่างรายละเอียด ───────────────── */

  /* สร้างส่วน "ข้อมูลพื้นฐานบริษัท" ในหน้าต่างรายละเอียด

     แนวคิด: ตัวเลขอย่าง P/E ดูตัวเดียวไม่มีความหมาย ต้องเทียบกับอะไรสักอย่าง
     จึงเทียบกับค่ากลางของหุ้นในหมวดธุรกิจเดียวกันที่คำนวณจากข้อมูลชุดนี้เอง
     เพราะแต่ละหมวดมีระดับ P/E ต่างกันมาก (เทคฯ สูงกว่าธนาคารเป็นเท่าตัวโดยปกติ) */
  function buildFundamentals(r) {
    var f = r.f;
    if (!f) {
      return "<h3>ข้อมูลพื้นฐานบริษัท</h3>" +
        '<p class="mnote">ยังไม่มีข้อมูลของหุ้นตัวนี้ — ระบบทยอยเก็บวันละ 180 ตัว ' +
        "ผ่านไปสองสามวันจะครบเอง</p>";
    }

    var med = (D.meta.sector_med || {})[r.g] || {};

    // ข้อมูลถูกซ่อนไว้เพราะราคาเปลี่ยนกระโดด (มักเกิดตอนหุ้นแตกพาร์)
    // ข้อมูลจำลองค้างอยู่ในชุดข้อมูลจริง = ผู้ใช้เผลออัปไฟล์ตัวอย่างทับ
    // (ถ้าทั้งชุดเป็นโหมดทดลองอยู่แล้ว ไม่ต้องเตือนซ้ำ เพราะมีป้ายบอกอยู่ด้านบน)
    if (f.dm && !D.meta.demo) {
      return "<h3>ข้อมูลพื้นฐานบริษัท</h3>" +
        '<div class="demowarn">ตัวเลขพื้นฐานของหุ้นตัวนี้ยังเป็น<b>ข้อมูลจำลอง</b> ' +
        "ไม่ใช่ของจริง — ให้กด Run workflow ซ้ำจนกว่าจะดึงของจริงมาทับครบ</div>";
    }

    var recheck = f.recheck
      ? '<div class="verdict">อัตราส่วนราคาถูกซ่อนไว้ชั่วคราว เพราะราคาเปลี่ยนไปมาก' +
        "จากตอนที่เก็บข้อมูล (มักเกิดตอนหุ้นแตกพาร์) ระบบจะดึงใหม่ให้ในรอบถัดไป</div>"
      : "";

    // แถวเทียบกับค่ากลางหมวด
    function cmpRow(label, val, medv, fmt, hint) {
      if (val == null) return "";
      var right = "";
      if (medv != null && medv > 0 && val > 0) {
        var diff = (val / medv - 1) * 100;
        var cls2 = diff > 15 ? "down" : diff < -15 ? "up" : "";
        var word = diff > 15 ? "สูงกว่าหมวด" : diff < -15 ? "ต่ำกว่าหมวด" : "ใกล้เคียงหมวด";
        right = '<span class="cmp ' + cls2 + '">' + word + " " +
                Math.abs(diff).toFixed(0) + "%</span>" +
                '<span class="medv">ค่ากลางหมวด ' + fmt(medv) + "</span>";
      }
      return '<div class="frow"><div class="fk">' + label +
             (hint ? '<span class="fh">' + hint + "</span>" : "") + "</div>" +
             '<div class="fv">' + fmt(val) + "</div>" +
             '<div class="fc">' + right + "</div></div>";
    }

    var valuation =
      cmpRow("P/E", f.pe, med.pe, function (v) { return num(v, 1) + " เท่า"; },
             f.eps ? "= " + r.p + " ÷ " + num(f.eps, 2) : "ราคาเป็นกี่เท่าของกำไรต่อหุ้น") +
      cmpRow("P/E คาดการณ์", f.fpe, null, function (v) { return num(v, 1) + " เท่า"; },
             "คิดจากกำไรที่นักวิเคราะห์คาดปีหน้า") +
      cmpRow("P/BV", f.pb, med.pb, function (v) { return num(v, 2) + " เท่า"; },
             "ราคาเป็นกี่เท่าของมูลค่าทางบัญชี") +
      cmpRow("P/S", f.ps, med.ps, function (v) { return num(v, 2) + " เท่า"; },
             "ราคาเป็นกี่เท่าของรายได้");

    if (!valuation) valuation = '<p class="mnote">ไม่มีข้อมูลอัตราส่วนราคา</p>';

    // สรุปว่าแพงหรือถูกเทียบเพื่อนในหมวด
    var verdict = "";
    if (f.pe != null && med.pe) {
      var d = (f.pe / med.pe - 1) * 100;
      var t = d > 25 ? ["แพงกว่าค่ากลางของหมวดพอสมควร", "down"]
            : d > 10 ? ["สูงกว่าค่ากลางของหมวดเล็กน้อย", ""]
            : d < -25 ? ["ถูกกว่าค่ากลางของหมวดพอสมควร", "up"]
            : d < -10 ? ["ต่ำกว่าค่ากลางของหมวดเล็กน้อย", ""]
            : ["อยู่ในระดับใกล้เคียงค่ากลางของหมวด", ""];
      verdict = '<div class="verdict ' + t[1] + '">P/E ' + num(f.pe, 1) +
        " เท่า · " + t[0] + " (" + esc(r.g) + " ค่ากลาง " + num(med.pe, 1) + ")</div>";
    } else if (f.pe == null && !f.recheck) {
      // ไม่มี P/E และไม่ใช่เพราะรอดึงใหม่ = บริษัทขาดทุนจริง
      verdict = '<div class="verdict">ไม่มีค่า P/E — มักหมายถึงบริษัทยังขาดทุนอยู่ ' +
                "จึงคำนวณอัตราส่วนนี้ไม่ได้</div>";
    }

    // ตัวเลขสุขภาพกิจการ
    var health = [
      ["มูลค่าบริษัท", money(f.mc), capClass(f.mc)],
      ["กำไรต่อหุ้น", f.eps == null ? "—" : "$" + num(f.eps, 2), ""],
      ["ROE", pctv(f.roe), "ผลตอบแทนต่อส่วนผู้ถือหุ้น"],
      ["อัตรากำไรสุทธิ", pctv(f.pm), ""],
      ["รายได้เติบโต", f.rg == null ? "—" : (f.rg > 0 ? "+" : "") + pctv(f.rg), "เทียบปีก่อน"],
      ["กำไรเติบโต", f.eg == null ? "—" : (f.eg > 0 ? "+" : "") + pctv(f.eg), "เทียบปีก่อน"],
      ["หนี้สินต่อทุน", f.de == null ? "—" : num(f.de, 0) + "%", ""],
      ["ปันผล", f.dy == null ? "—" : pctv(f.dy, 2), "ต่อปี"],
      ["ความผันผวน", f.beta == null ? "—" : num(f.beta, 2), "เทียบตลาดรวม (1.0 = เท่าตลาด)"],
      ["พนักงาน", f.emp == null ? "—" : Math.round(f.emp).toLocaleString() + " คน", ""]
    ].filter(function (x) { return x[1] !== "—"; })
     .map(function (x) {
       return '<div class="pcell"><div class="k">' + x[0] +
         (x[2] ? '<span class="fh">' + x[2] + "</span>" : "") + "</div>" +
         '<div class="v sm">' + x[1] + "</div></div>";
     }).join("");

    // ตำแหน่งราคาในรอบ 52 สัปดาห์
    // ตรวจซ้ำอีกชั้นก่อนแสดง: ราคาต้องอยู่ในช่วงสูงสุด/ต่ำสุดเสมอ
    // ถ้าอยู่นอกช่วงแปลว่าข้อมูลเก่าใช้ไม่ได้ ไม่ต้องแสดงดีกว่าแสดงผิด
    var range = "";
    var rangeOK = f.hi && f.lo && f.hi > f.lo &&
                  r.p >= f.lo * 0.95 && r.p <= f.hi * 1.05;
    if (rangeOK) {
      var pos = Math.max(0, Math.min(100, (r.p - f.lo) / (f.hi - f.lo) * 100));
      var fromHi = (r.p / f.hi - 1) * 100;
      range = "<h3>ช่วงราคา 52 สัปดาห์</h3>" +
        '<div class="range"><div class="bar"><div class="dot" style="left:' +
          pos.toFixed(1) + '%"></div></div>' +
        '<div class="rends"><span>ต่ำสุด $' + num(f.lo, 2) + "</span>" +
          '<span>สูงสุด $' + num(f.hi, 2) + "</span></div></div>" +
        '<p class="mnote">ราคาปัจจุบันอยู่ที่ ' + pos.toFixed(0) +
        "% ของช่วง · ห่างจากจุดสูงสุด " + num(Math.abs(fromHi), 1) + "%</p>";
    }

    // มุมมองนักวิเคราะห์
    var analyst = "";
    if (f.tgt && f.tgt < r.p * 3 && f.tgt > r.p * 0.3) {
      var up = (f.tgt / r.p - 1) * 100;
      analyst = "<h3>มุมมองนักวิเคราะห์</h3>" +
        '<div class="pgrid wide"><div class="pcell"><div class="k">ราคาเป้าหมายเฉลี่ย</div>' +
          '<div class="v sm">$' + num(f.tgt, 2) + "</div></div>" +
        '<div class="pcell"><div class="k">ห่างจากราคาปัจจุบัน</div>' +
          '<div class="v sm ' + (up > 0 ? "up" : "down") + '">' + sign(up) + "%</div></div>" +
        (f.rec ? '<div class="pcell"><div class="k">คำแนะนำรวม</div>' +
          '<div class="v sm">' + (REC_TH[f.rec] || esc(f.rec)) + "</div></div>" : "") +
        (f.na ? '<div class="pcell"><div class="k">จำนวนนักวิเคราะห์</div>' +
          '<div class="v sm">' + Math.round(f.na) + " ราย</div></div>" : "") +
        "</div>" +
        '<p class="mnote">เป็นความเห็นของนักวิเคราะห์ ไม่ใช่การรับประกัน ' +
        "ราคาเป้าหมายมักถูกปรับตามราคาตลาดอยู่เสมอ</p>";
    }

    // บอกที่มาของตัวเลขให้ชัด ผู้ใช้จะได้รู้ว่าข้อมูลสดแค่ไหน
    var src = '<b>อัตราส่วนทั้งหมดคำนวณจากราคาปิด $' + r.p +
              " ของวันที่ " + esc(D.meta.date) + "</b>" +
              " — ถ้าเทียบกับเว็บอื่นที่แสดงราคาระหว่างวัน ตัวเลขจะต่างกันตามราคาที่ต่างกัน";
    if (f.fts) {
      src += "<br>กำไรต่อหุ้นและตัวเลขกิจการดึงเมื่อ " + thDate(f.fts) +
             " (เปลี่ยนแค่ตอนประกาศงบ)";
    }

    return "<h3>ราคาแพงหรือถูก</h3>" + recheck + verdict +
      '<div class="ftable">' + valuation + "</div>" +
      (src ? '<p class="mnote">' + src + "</p>" : "") +
      '<p class="mnote">ตัวเลขพวกนี้ดูตัวเดียวตัดสินไม่ได้ ต้องดูคู่กับการเติบโตและคุณภาพกิจการ · ' +
      "แต่ละหมวดธุรกิจมีระดับปกติต่างกันมาก จึงเทียบกับค่ากลางของหมวดเดียวกัน</p>" +
      (function () {
        var e = earnScore(f);
        if (!e) return "";
        return "<h3>คะแนนผลประกอบการไตรมาสล่าสุด</h3>" +
          '<div class="verdict">งบ<b> ' + e.gradeTh + " </b>· " + e.score.toFixed(1) +
          " เต็ม 8 คะแนน (คิดจาก " + e.used + " ตัวชี้วัด)</div>" +
          '<div class="ebars">' + e.parts.map(function (p) {
            return '<div class="ebar p' + p.p + '"><span class="ek">' + p.label +
                   '</span><span class="ev">' + p.val + "</span></div>";
          }).join("") + "</div>" +
          (f.edold || f.qold
            ? '<div class="staleq">' +
              (f.edold
                ? "เลยวันประกาศงบมา " + f.edold +
                  " วันแล้ว ตัวเลขด้านบนยังเป็นงบไตรมาสก่อน · ระบบจัดคิวดึงงบใหม่ให้แล้ว"
                : "ไตรมาสล่าสุดเก่ากว่า " + f.qold + " วัน อาจมีงบใหม่ที่ยังไม่ได้ดึง") +
              "</div>"
            : "") +
          (f.mrq ? '<p class="mnote">งบไตรมาสถึงวันที่ ' + thDate(f.mrq) +
                   (f.ed ? " · ประกาศงบครั้งหน้า " + thDate(f.ed) : "") + "</p>" : "");
      })() +
      (health ? "<h3>ตัวเลขกิจการ</h3><div class='pgrid wide'>" + health + "</div>" : "") +
      range + analyst;
  }

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

    function emaSection(title, dd, tt, aa, note) {
      if (!dd) return "";
      return "<h3>" + title + '</h3><div class="emas big">' +
        EMAS.map(function (p, i) {
          var d = dd[i];
          if (d === null || d === undefined) {
            return '<div class="e off"><div class="lb">EMA ' + p +
                   '</div><div class="dv">—</div></div>';
          }
          var hit = Math.abs(d) <= st.tol;
          return '<div class="e ' + (hit ? "hit" : "") + '"><div class="lb">EMA ' + p +
                 '</div><div class="dv">' + sign(d) + "%</div></div>";
        }).join("") + "</div>" +
        '<p class="mnote">' + note +
        (tt ? ' · เทรนด์ <b>' + (TREND_TH[tt] || "-") + "</b>" : "") +
        (aa ? " · เส้นเรียงสวย 5&gt;10&gt;20&gt;50&gt;100&gt;200" : "") + "</p>";
    }

    var emaBlock =
      emaSection("ระยะห่างจากเส้น EMA — รายวัน", r.d, r.t, r.a,
                 "ช่องไฮไลต์ = อยู่ในระยะ " + st.tol.toFixed(1) + "% ที่ตั้งไว้ในหน้าหาเส้น EMA") +
      (r.w ? emaSection("ระยะห่างจากเส้น EMA — รายสัปดาห์", r.w.d, r.w.t, r.w.a,
                        "ข้อมูลถึงสัปดาห์ของวันที่ " + thDate(D.meta.weekly_date) +
                        " · มีข้อมูล " + r.w.n + " สัปดาห์" +
                        (r.w.d.some(function (x) { return x === null; })
                          ? " (เส้นที่ขึ้น — คือข้อมูลยังไม่พอ)" : ""))
            : (D.meta.weekly_count
                ? '<h3>ระยะห่างจากเส้น EMA — รายสัปดาห์</h3>' +
                  '<p class="mnote">ยังไม่มีข้อมูลรายสัปดาห์ของหุ้นตัวนี้</p>'
                : ""));

    var themes = (D.themes || []).filter(function (t) {
      return t.tickers.indexOf(tk) >= 0;
    }).map(function (t) { return '<span class="b">' + esc(t.name) + "</span>"; }).join("");

    var fundBlock = buildFundamentals(r);

    // เตือนให้เห็นชัดในหน้าต่างด้วย ไม่ใช่แค่ป้ายมุมบนที่อาจถูกบัง
    var demoWarn = D.meta.demo
      ? '<div class="demowarn">ตัวเลขทั้งหมดในหน้านี้เป็น<b>ข้อมูลจำลอง</b> ' +
        "ไม่ใช่ราคาจริง — ใช้ดูหน้าตาเท่านั้น</div>"
      : "";

    $("modalBody").innerHTML = demoWarn +
      '<div class="mhead"><h2>' + esc(r.s) + '</h2>' +
        '<span class="mprice">$' + r.p + "</span></div>" +
      '<p class="mname">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</p>" +
      '<svg class="mspark" viewBox="0 0 100 28" preserveAspectRatio="none">' +
        '<path d="' + sparkPath(r.h) + '" fill="none" stroke="' + col +
        '" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>' +
      '<p class="mnote">ราคา 60 วันทำการล่าสุด</p>' +
      "<h3>ผลตอบแทนแต่ละช่วง</h3><div class='pgrid'>" + perf + "</div>" +
      emaBlock + fundBlock +
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
        var TITLE = PAGE_TITLE;
        ["today", "map", "ema", "top", "watch", "earn", "cmp", "star"]
          .forEach(function (k) {
          var pg = $("page" + k.charAt(0).toUpperCase() + k.slice(1));
          var ft = $("foot" + k.charAt(0).toUpperCase() + k.slice(1));
          if (pg) pg.hidden = (k !== st.page);
          if (ft) ft.hidden = (k !== st.page);
        });
        $("pageTitle").textContent = TITLE[st.page] || "AI Map";
        window.scrollTo(0, 0);
      });
    });

    seg("tdScope", "tdScope", null, renderToday);
    seg("tdCount", "tdCount", Number, renderToday);
    seg("period", "period", null, renderMap);
    seg("mapShow", "mapShow", null, renderMap);
    seg("topN", "topN", Number, function () {
      st.expanded = {};                     // เปลี่ยนจำนวนแล้วย่อทุกกล่องกลับ
      renderMap();
    });
    seg("minNear", "minNear", Number, renderEma);
    seg("trend", "trend", null, renderEma);
    seg("side", "side", null, renderEma);
    seg("tf", "tf", null, function () {
      updateTfNote();
      renderEma();
    });
    seg("peRange", "pe", null, renderEma);
    seg("topPeriod", "topPeriod", null, renderTop);
    seg("topDir", "topDir", null, renderTop);
    seg("topCount", "topCount", Number, renderTop);
    seg("topCap", "topCap", null, renderTop);
    $("topSector").addEventListener("change", function (e) {
      st.topSector = e.target.value; renderTop();
    });
    $("topTheme").addEventListener("change", function (e) {
      st.topTheme = e.target.value; renderTop();
    });
    seg("wSide", "wSide", null, renderWatch);
    seg("wSignal", "wSignal", null, renderWatch);
    $("wSector").addEventListener("change", function (e) {
      st.wSector = e.target.value; renderWatch();
    });
    $("wTheme").addEventListener("change", function (e) {
      st.wTheme = e.target.value; renderWatch();
    });
    seg("eView", "eView", null, function () { st.eOpen = {}; renderEarn(); });
    seg("eQuad", "eQuad", null, renderEarn);
    seg("eGrade", "eGrade", null, renderEarn);
    seg("eRecent", "eRecent", null, renderEarn);
    $("eQ").addEventListener("input", function (e) {
      st.eQ = e.target.value.trim(); later(renderEarn);
    });
    ["eSector", "eTheme", "eSort"].forEach(function (id) {
      $(id).addEventListener("change", function (e) {
        st[id] = e.target.value; renderEarn();
      });
    });
    seg("cMode", "cMode", null, function () { st.cGroup = ""; renderCmp(); });
    seg("cView", "cView", null, renderCmp);
    $("cGroup").addEventListener("change", function (e) {
      st.cGroup = e.target.value; renderCmp();
    });
    $("cSort").addEventListener("change", function (e) {
      st.cSort = e.target.value; renderCmp();
    });
    seg("sSort", "sSort", null, renderStar);
    document.addEventListener("click", function (e) {
      var b = e.target.closest(".starfilter");
      if (!b) return;
      st.onlyStar = !st.onlyStar;
      syncStarFilterButtons();
      refreshAll();
    });
    $("sExport").addEventListener("click", exportStars);
    $("sImport").addEventListener("click", function () { $("sFile").click(); });
    $("sFile").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) importStars(e.target.files[0]);
      e.target.value = "";
    });
    // บันทึกเหตุผลอัตโนมัติเมื่อพิมพ์เสร็จแล้วคลิกออก
    document.addEventListener("change", function (e) {
      var t = e.target;
      if (t && t.dataset && t.dataset.note !== undefined) {
        var tk = t.dataset.note;
        if (stars[tk]) { stars[tk].note = t.value; saveStars(); }
      }
    });

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
      // ดาวต้องตรวจก่อนการ์ด ไม่งั้นจะไปเปิดหน้าต่างรายละเอียดแทน
      var sBtn = e.target.closest("[data-star]");
      if (sBtn) {
        e.stopPropagation();
        toggleStar(sBtn.dataset.star);
        return;
      }
      var es = e.target.closest("[data-esec]");
      if (es) {
        var sk = es.dataset.esec;
        st.eSecOpen[sk] = !st.eSecOpen[sk];
        renderEarn();
        return;
      }
      var eo = e.target.closest("[data-eopen]");
      if (eo && !e.target.closest("[data-tk]")) {
        var key = eo.dataset.eopen;
        st.eOpen[key] = !st.eOpen[key];
        renderEarn();
        return;
      }
      var m = e.target.closest("[data-more]");
      if (m) {
        var k = m.dataset.more;
        st.expanded[k] = !st.expanded[k];
        renderMap();
        return;
      }
      var c = e.target.closest("[data-tk]");
      if (c) openStock(c.dataset.tk);
    });
    $("modalClose").addEventListener("click", closeModal);
    $("modal").addEventListener("click", function (e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
      if (e.key === "Enter" || e.key === " ") {
        var el = document.activeElement;
        if (el && el.dataset && el.dataset.star) {
          e.preventDefault();
          toggleStar(el.dataset.star);
        } else if (el && el.dataset && el.dataset.tk && el.tagName !== "TEXTAREA") {
          e.preventDefault();
          openStock(el.dataset.tk);
        }
      }
    });

    $("csv").addEventListener("click", function () {
      var di = PERIODS.indexOf("1d");
      var tfw = st.tf === "w" ? "รายสัปดาห์" : "รายวัน";
      var head = ["ชื่อย่อ", "ชื่อบริษัท", "หมวดธุรกิจ", "ราคา", "เปลี่ยนแปลงวันนี้%",
                  "ไทม์เฟรม", "เทรนด์", "สัญญาณ", "คะแนน", "ชนเส้น"]
                 .concat(EMAS.map(function (p) { return "ห่าง" + p; }));
      var lines = [head.join(",")];
      currentEma.forEach(function (o) {
        var r = o.r;
        var XX = o.ev.X;
        lines.push([r.s, '"' + (r.n || "").replace(/"/g, "") + '"', '"' + r.g + '"',
                    r.p, r.r[di], tfw, TREND_TH[XX.t] || XX.t || "-",
                    '"' + o.ev.sig + '"', o.ev.score,
                    '"' + o.ev.near.join("/") + '"']
                   .concat(XX.d.map(function (x) { return x === null ? "" : x; })).join(","));
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")],
               { type: "text/csv;charset=utf-8" }));
      a.download = "หุ้นใกล้เส้น-EMA-" + (st.tf === "w" ? "รายสัปดาห์" : "รายวัน") + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
})();
