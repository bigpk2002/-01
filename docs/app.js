/* AI Map + ตัวหาเส้น EMA
   โหลด data.json ที่ GitHub Actions สร้างไว้ แล้วกรอง/จัดอันดับในเบราว์เซอร์
   จึงเลื่อนแถบหรือกดปุ่มแล้วเห็นผลทันที ไม่ต้องรอเซิร์ฟเวอร์ */

(function () {
  "use strict";

  var VERSION = "21";          // เลขนี้ต้องตรงกับใน index.html
  var D = null, EMAS = [], PERIODS = [];
  var TREND_TH = { up: "ขาขึ้น", down: "ขาลง", flat: "ออกข้าง" };
  var PAGE_TITLE = {
    today: "เช้านี้", map: "AI Map", ema: "หุ้นที่ราคาใกล้เส้น EMA",
    top: "หุ้นโตแรง", buzz: "หุ้นที่เพิ่งเข้ากระแส",
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
    bzSig: "all", bzDir: "all", bzN: 10,
    idx: "all", tf: "d", tol: 1.5, minNear: 1, trend: "all", side: "both", pe: "all", lines: [],
    topPeriod: "1m", topDir: "up", topSector: "", topTheme: "",
    topCount: 10, topCap: "all",
    eView: "cal", eOpen: {}, eSecOpen: {},
    eQuad: "all", eGrade: "all", eRecent: "all",
    eQ: "", eSector: "", eTheme: "", eSort: "score",
    cMode: "theme", cGroup: "", cView: "table", cSort: "score",
    sSort: "added", onlyStar: false,
    capTol: 1.5, capN: 20, emaSub: "find"
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
      if (BT && D) renderCap();            // ถ้าข้อมูลหลักมาก่อน ให้วาดใหม่
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

    ["topSector", "topTheme",
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
    renderBuzz();
    renderEarn();
    renderCmp();
    renderStar();
    renderToday();
    renderCap();
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

  /* ดัชนีที่หุ้นตัวนี้สังกัด — เก็บเป็นเลขเดียวเพื่อลดขนาดไฟล์
     1 = S&P 500 · 2 = Nasdaq 100 · 3 = ทั้งสองดัชนี · 0 = เพิ่มเองใน themes.yml */
  var IX_TH = { 1: "S&P 500", 2: "Nasdaq 100", 3: "S&P 500 + Nasdaq 100",
                0: "เพิ่มเอง" };

  function passIdx(r) {
    if (st.idx === "all") return true;
    var v = r.ix || 0;
    if (st.idx === "sp") return (v & 1) === 1;        // อยู่ใน S&P 500 (จะอยู่ NDX ด้วยก็ได้)
    if (st.idx === "ndx") return (v & 2) === 2;       // อยู่ใน Nasdaq 100
    if (st.idx === "both") return v === 3;
    if (st.idx === "extra") return v === 0;
    return true;
  }

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
      if (!passIdx(r)) return;
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

  /* ───────────────── หน้าที่ 4: เพิ่งเข้ากระแส ─────────────────

     หาหุ้นที่ "เพิ่งเปลี่ยนสถานะ" ไม่ใช่ตัวที่ดังอยู่แล้ว
     ทุกสัญญาณคำนวณจากตัวเลขที่มีอยู่ ไม่ต้องพึ่งข่าว

     ข้อจำกัดที่ต้องยอมรับ: เราเห็นหลังตลาดปิด ไม่ได้เห็นก่อนใคร
     แต่เห็นครบทุกตัวพร้อมกัน ซึ่งการอ่านข่าวทีละข่าวทำไม่ได้        */

  // เกณฑ์วอลุ่มพุ่ง — ตั้งตายตัวไว้ที่ 2 เท่า
  // เดิมให้ผู้ใช้ปรับได้ 1.2–4 เท่า แต่กลายเป็นภาระต้องมานั่งเลือกทุกครั้ง
  // 2 เท่าเป็นจุดที่คนใช้กันทั่วไปว่า "ผิดปกติ" จึงตั้งไว้เลย
  var BZ_VOL = 2.0;

  var BZ = {
    vol:  { name: "วอลุ่มพุ่ง",       icon: "📊" },
    bo:   { name: "หลุดกรอบราคา",     icon: "🚀" },
    tc:   { name: "เทรนด์เปลี่ยน",    icon: "🔄" },
    nw:   { name: "เพิ่งมาถึงเส้น",   icon: "🎯" }
  };

  function buzzOf(r) {
    var out = [], di = PERIODS.indexOf("1d");
    var chg = r.r[di];

    if (r.vr !== undefined && r.vr >= BZ_VOL) {
      out.push({ k: "vol", detail: "วอลุ่ม " + num(r.vr, 2) + " เท่าของค่าเฉลี่ย 20 วัน",
                 // วอลุ่มไม่บอกทิศทางเอง ใช้ราคาวันนี้เป็นตัวชี้
                 side: (chg || 0) >= 0 ? "up" : "down" });
    }
    if (r.bo === 1) {
      out.push({ k: "bo", detail: "ทำจุดสูงสุดใหม่ในรอบ 3 เดือน", side: "up" });
    } else if (r.bo === -1) {
      out.push({ k: "bo", detail: "ทำจุดต่ำสุดใหม่ในรอบ 3 เดือน", side: "down" });
    }
    if (r.tc) {
      out.push({ k: "tc",
                 detail: "จาก " + (TREND_TH[r.tc] || r.tc) + " เป็น " + (TREND_TH[r.t] || r.t),
                 side: r.t === "up" ? "up" : r.t === "down" ? "down" : "flat" });
    }
    if ((r.nw || []).length) {
      out.push({ k: "nw", detail: "เพิ่งเข้าระยะเส้น " + r.nw.join(" · "),
                 side: (chg || 0) >= 0 ? "up" : "down" });
    }
    return out;
  }

  function renderBuzz() {
    if (!D) return;
    var di = PERIODS.indexOf("1d"), mi = PERIODS.indexOf("1m");

    var all = [], out = [];
    D.rows.forEach(function (r) {
      var sig = buzzOf(r);
      if (!sig.length) return;
      all.push({ r: r, sig: sig });

      if (!passStar(r.s)) return;
      if (st.bzSig !== "all" && !sig.some(function (x) { return x.k === st.bzSig; })) return;
      if (st.bzDir !== "all" && !sig.some(function (x) { return x.side === st.bzDir; })) return;
      out.push({ r: r, sig: sig });
    });

    // เรียงจากตัวที่ติดหลายสัญญาณก่อน แล้วดูวอลุ่มที่พุ่งแรงกว่า
    out.sort(function (a, b) {
      return b.sig.length - a.sig.length ||
             (b.r.vr || 0) - (a.r.vr || 0) ||
             Math.abs(b.r.r[di] || 0) - Math.abs(a.r.r[di] || 0);
    });

    var shown = out.slice(0, st.bzN);
    $("bzEmpty").hidden = out.length > 0;

    var byKind = {};
    all.forEach(function (o) {
      o.sig.forEach(function (x) { byKind[x.k] = (byKind[x.k] || 0) + 1; });
    });
    var parts = Object.keys(BZ).filter(function (k) { return byKind[k]; })
      .map(function (k) { return BZ[k].icon + " " + BZ[k].name + " " + byKind[k]; });

    $("bzNote").innerHTML =
      "วันนี้มี <b>" + all.length + "</b> ตัวที่เพิ่งเปลี่ยนสถานะ" +
      (parts.length ? " — " + parts.join(" · ") : "") +
      "<br>ข้อมูลปิดตลาดวันที่ <b>" + esc(D.meta.date) + "</b>" +
      (D.meta.prev_date ? " เทียบกับ " + thDate(D.meta.prev_date) : "") +
      " · เรียงจากตัวที่ติดหลายสัญญาณก่อน";

    $("buzzlist").innerHTML = shown.map(function (o) {
      var r = o.r, f = r.f || {};
      var chg = r.r[di], m1 = r.r[mi];
      var ups = o.sig.filter(function (x) { return x.side === "up"; }).length;
      var dns = o.sig.filter(function (x) { return x.side === "down"; }).length;
      var cls = ups > dns ? "up" : dns > ups ? "down" : "";

      var tags = o.sig.map(function (x) {
        return '<div class="bzsig ' + x.side + '">' +
          '<span class="bzname">' + BZ[x.k].icon + " " + BZ[x.k].name + "</span>" +
          '<span class="bzdetail">' + esc(x.detail) + "</span></div>";
      }).join("");

      return '<div class="bzcard ' + cls + '" data-tk="' + esc(r.s) +
        '" role="button" tabindex="0">' +
        '<div class="row1">' + starIcon(r.s) +
          '<span class="tk">' + esc(r.s) + "</span>" +
          '<span class="chg ' + ((chg || 0) >= 0 ? "p" : "n") + '">' +
            (chg === null || chg === undefined ? "—" : sign(chg) + "%") + "</span>" +
          '<span class="px">$' + r.p + "</span>" +
          (r.vr !== undefined
            ? '<span class="bzvr' + (r.vr >= BZ_VOL ? " hot" : "") + '">×' +
              num(r.vr, 1) + "</span>" : "") + "</div>" +
        '<div class="nm">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</div>" +
        '<div class="bzsigs">' + tags + "</div>" +
        '<div class="efoot"><span>1 เดือน ' +
          (m1 === null || m1 === undefined ? "—" : sign(m1) + "%") + "</span>" +
          (f.pe ? "<span>P/E " + num(f.pe, 1) + "</span>" : "") +
          (f.mc ? "<span>" + money(f.mc) + "</span>" : "") + "</div></div>";
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

  /* ───────── รายละเอียดผลประกอบการ แบบอธิบายเป็นภาษาคน ─────────

     เดิมกางออกมาเห็นแค่ตัวเลข 4 ตัวลอย ๆ ไม่ได้บอกว่ามันแปลว่าอะไร
     ตอนนี้แบ่งเป็น 4 ส่วน แต่ละตัวเลขมีคำอธิบายว่าหมายความว่าอะไร

     ส่วน "ตลาดคาดหวังอะไร" ใช้ P/E คาดการณ์เทียบ P/E ปัจจุบัน
     ซึ่งเป็นการอ่านความคาดหวังของตลาดโดยตรง ไม่ใช่การเดา
     ถ้า P/E คาดการณ์ต่ำกว่าปัจจุบัน แปลว่าตลาดคาดว่ากำไรจะโตขึ้น
     (เพราะ P/E = ราคา ÷ กำไร ถ้ากำไรโต ตัวหารใหญ่ขึ้น P/E ก็ลด)     */

  var REC_TH = {
    strongbuy: "แนะนำซื้อมาก", buy: "แนะนำซื้อ", hold: "แนะนำถือ",
    underperform: "แนะนำลดน้ำหนัก", sell: "แนะนำขาย",
    strong_buy: "แนะนำซื้อมาก", none: "ไม่มีคำแนะนำ"
  };

  /* กล่องตัวเลขหนึ่งช่อง พร้อมคำอธิบายว่าหมายความว่าอะไร */
  function metric(label, value, meaning, tone) {
    return '<div class="mx' + (tone ? " " + tone : "") + '">' +
      '<div class="mxl">' + label + "</div>" +
      '<div class="mxv">' + value + "</div>" +
      (meaning ? '<div class="mxm">' + meaning + "</div>" : "") + "</div>";
  }

  function earnDetail(o) {
    var r = o.r, f = r.f || {}, e = o.e;
    var med = (D.meta.sector_med || {})[r.g] || {};
    var pc = function (v) { return (v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; };
    var out = "";

    /* ── 1. งบไตรมาสล่าสุดบอกอะไร ── */
    var rows1 = "";
    if (f.rg !== undefined) {
      rows1 += metric("รายได้เติบโต", pc(f.rg),
        f.rg >= 0.15 ? "โตเร็ว — ขายได้มากขึ้นชัดเจนเทียบปีก่อน"
        : f.rg >= 0.03 ? "โตพอประมาณ"
        : f.rg >= 0 ? "โตช้ามาก เกือบทรงตัว"
        : "รายได้หดตัวจากปีก่อน",
        f.rg >= 0.15 ? "good" : f.rg < 0 ? "bad" : "");
    }
    var eg = (f.eqg !== undefined && f.eqg !== null) ? f.eqg : f.eg;
    if (eg !== undefined && eg !== null) {
      rows1 += metric("กำไรเติบโต", pc(eg),
        eg >= 0.15 ? "กำไรโตเร็วกว่ารายได้ = คุมต้นทุนได้ดี"
        : eg >= 0 ? "กำไรยังโต แต่ไม่หวือหวา"
        : "กำไรลดลงจากปีก่อน",
        eg >= 0.15 ? "good" : eg < 0 ? "bad" : "");
    }
    if (f.pm !== undefined) {
      rows1 += metric("อัตรากำไรสุทธิ", (f.pm * 100).toFixed(1) + "%",
        "ขายได้ 100 บาท เหลือกำไรสุทธิ " + (f.pm * 100).toFixed(1) + " บาท" +
        (f.pm >= 0.2 ? " — สูงมาก" : f.pm < 0.05 ? " — บางมาก" : ""),
        f.pm >= 0.2 ? "good" : f.pm < 0.05 ? "bad" : "");
    }
    if (f.roe !== undefined) {
      rows1 += metric("ROE", (f.roe * 100).toFixed(1) + "%",
        "ทุกเงิน 100 บาทของผู้ถือหุ้น สร้างกำไรได้ " +
        (f.roe * 100).toFixed(0) + " บาทต่อปี",
        f.roe >= 0.15 ? "good" : f.roe < 0.07 ? "bad" : "");
    }
    if (rows1) {
      out += '<h4>งบไตรมาสล่าสุดบอกอะไร</h4>' +
        (e ? '<p class="exp">รวมแล้วได้เกรด <b>' + e.gradeTh + "</b> " +
             e.score.toFixed(1) + " เต็ม 8 คะแนน</p>" : "") +
        '<div class="mxgrid">' + rows1 + "</div>";
    }

    /* ── 2. ตลาดคาดหวังอะไร ── */
    var rows2 = "";
    if (f.pe && f.fpe) {
      var chg = (f.fpe / f.pe - 1) * 100;
      var grow = f.fpe < f.pe;
      rows2 += metric("P/E ปัจจุบัน → คาดการณ์",
        num(f.pe, 1) + " → " + num(f.fpe, 1) + " เท่า",
        grow
          ? "ตลาดคาดว่า<b>กำไรจะโตขึ้น</b> ปีหน้าราว " +
            num((f.pe / f.fpe - 1) * 100, 0) + "% จึงยอมจ่าย P/E สูงตอนนี้"
          : "ตลาดคาดว่า<b>กำไรจะลดลง</b> ปีหน้า จึงมองว่าราคานี้แพงกว่าที่เห็น",
        grow ? "good" : "bad");
    }
    if (f.tgt) {
      var up = (f.tgt / r.p - 1) * 100;
      rows2 += metric("ราคาเป้าหมายนักวิเคราะห์", "$" + num(f.tgt, 2),
        (up >= 0 ? "สูงกว่า" : "ต่ำกว่า") + "ราคาตอนนี้ " +
        num(Math.abs(up), 1) + "%" +
        (f.na ? " · จาก " + f.na + " สำนัก" : ""),
        up >= 10 ? "good" : up <= -10 ? "bad" : "");
    }
    if (f.rec) {
      var key = String(f.rec).toLowerCase().replace(/[\s-]/g, "");
      rows2 += metric("คำแนะนำรวม", REC_TH[key] || f.rec,
        "เป็นค่าเฉลี่ยความเห็นนักวิเคราะห์ ไม่ใช่การรับประกัน", "");
    }
    if (f.ed) {
      var d2 = daysUntil(f.ed);
      rows2 += metric("ประกาศงบครั้งหน้า", thDate(f.ed),
        d2 === null ? "" : d2 > 0 ? "อีก " + d2 + " วัน"
        : d2 === 0 ? "วันนี้" : "เลยมา " + (-d2) + " วันแล้ว",
        d2 !== null && d2 < 0 ? "warn" : "");
    }
    if (rows2) {
      out += '<h4>ตลาดคาดหวังอะไร</h4>' +
        '<p class="exp">P/E คาดการณ์คือราคาหารด้วยกำไรที่นักวิเคราะห์<b>คาดว่าจะได้ปีหน้า</b> ' +
        "ถ้าต่ำกว่า P/E ปัจจุบัน แปลว่าตลาดคาดว่ากำไรจะโตขึ้น</p>" +
        '<div class="mxgrid">' + rows2 + "</div>";
    }

    /* ── 3. ราคาแพงหรือถูกเทียบเพื่อนในหมวด ── */
    if (f.pe && med.pe && med.pe_n) {
      var where, tone;
      if (med.pe_q1 != null && f.pe < med.pe_q1) {
        where = "ถูกกว่าหุ้นส่วนใหญ่ในหมวดนี้"; tone = "good";
      } else if (med.pe_q3 != null && f.pe > med.pe_q3) {
        where = "แพงกว่าหุ้นส่วนใหญ่ในหมวดนี้"; tone = "bad";
      } else {
        where = "อยู่ในช่วงปกติของหมวดนี้"; tone = "";
      }
      out += "<h4>เทียบกับเพื่อนในหมวด " + esc(r.g || "-") + "</h4>" +
        '<div class="mxgrid">' +
        metric("P/E ของหุ้นนี้", num(f.pe, 1) + " เท่า", where, tone) +
        metric("ช่วงของหมวด",
          (med.pe_q1 != null ? num(med.pe_q1, 1) + "–" + num(med.pe_q3, 1) : num(med.pe, 1)) +
          " เท่า",
          "กลาง " + num(med.pe, 1) + " เท่า · จาก " + med.pe_n + " ตัว" +
          (med.pe_thin ? " (ตัวอย่างน้อย ใช้เทียบอย่างระวัง)" : ""),
          med.pe_thin ? "warn" : "") +
        "</div>";
    }

    /* ── 4. ขนาดกิจการและความมั่นคง ── */
    var rows4 = "";
    if (f.rev) rows4 += metric("รายได้ 12 เดือน", money(f.rev), "ขนาดของกิจการ", "");
    if (f.fcf !== undefined) {
      rows4 += metric("กระแสเงินสดอิสระ", money(f.fcf),
        f.fcf > 0 ? "เงินสดที่เหลือหลังลงทุน — เป็นบวกคือดี"
                  : "ติดลบ = ใช้เงินมากกว่าที่หาได้",
        f.fcf > 0 ? "good" : "bad");
    }
    if (f.de !== undefined) {
      rows4 += metric("หนี้ต่อทุน", num(f.de, 0) + "%",
        "มีหนี้ " + num(f.de, 0) + " บาท ต่อทุนผู้ถือหุ้น 100 บาท" +
        (f.de > 200 ? " — สูง" : f.de < 50 ? " — ต่ำ" : ""),
        f.de > 200 ? "bad" : f.de < 50 ? "good" : "");
    }
    if (f.dy) {
      rows4 += metric("ปันผลต่อปี", num(f.dy * 100, 2) + "%",
        "ซื้อที่ราคานี้ ได้ปันผลปีละราว " + num(f.dy * 100, 2) + "%", "");
    }
    if (rows4) out += "<h4>ขนาดกิจการและความมั่นคง</h4>" +
      '<div class="mxgrid">' + rows4 + "</div>";

    /* ── คำเตือนและที่มา ── */
    if (f.edold || f.qold) {
      out += '<div class="staleq">' +
        (f.edold
          ? "เลยวันประกาศงบมา " + f.edold +
            " วันแล้ว ตัวเลขทั้งหมดด้านบนยังเป็นงบไตรมาสก่อน ระบบจัดคิวดึงงบใหม่ให้แล้ว"
          : "ไตรมาสล่าสุดเก่ากว่า " + f.qold + " วัน อาจมีงบใหม่ที่ยังไม่ได้ดึง") +
        "</div>";
    }
    out += '<div class="efoot2">' +
      (f.mrq ? "ตัวเลขจากงบไตรมาสถึง " + thDate(f.mrq) +
               (o.age !== null ? " (" + o.age + " วันก่อน)" : "") : "ไม่ทราบไตรมาส") +
      " · ทั้งหมดเป็นผลย้อนหลังที่รายงานแล้ว ยกเว้นส่วนที่ระบุว่าคาดการณ์" +
      " · คลิกชื่อหุ้นเพื่อดูกราฟและระยะห่างจากเส้น EMA</div>";
    return out;
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
      /* อธิบายตัวเลขเป็นภาษาที่เข้าใจได้ ไม่ใช่โยนตัวเลขลอย ๆ
         แต่ละอย่างบอกด้วยว่าตัวเลขนั้นแปลว่าอะไรในทางปฏิบัติ */

      function pct(v) { return (v > 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; }

      // ── 1. งบไตรมาสล่าสุด พร้อมคำอธิบาย ──
      function metric(label, val, explain, good, ok, fmt) {
        if (val === null || val === undefined) return "";
        var lvl = val >= good ? "p2" : val >= ok ? "p1" : "p0";
        var word = val >= good ? "ดี" : val >= ok ? "พอใช้" : "อ่อน";
        return '<div class="mrow ' + lvl + '">' +
          '<div class="mtop"><span class="mlabel">' + label + "</span>" +
            '<span class="mval">' + fmt(val) + "</span>" +
            '<span class="mword">' + word + "</span></div>" +
          '<div class="mwhy">' + explain + "</div></div>";
      }

      var eg2 = (f.eqg !== undefined && f.eqg !== null) ? f.eqg : f.eg;
      var quarter =
        metric("รายได้เติบโต", f.rg,
               f.rg === undefined || f.rg === null ? "" :
               (f.rg >= 0 ? "ขายได้มากกว่าไตรมาสเดียวกันปีก่อน " + pct(f.rg)
                          : "ขายได้น้อยลงกว่าปีก่อน " + pct(f.rg)),
               0.15, 0.03, pct) +
        metric("กำไรเติบโต", eg2,
               eg2 === undefined || eg2 === null ? "" :
               (eg2 >= 0 ? "กำไรมากกว่าปีก่อน " + pct(eg2) + " — โตเร็วกว่ารายได้แปลว่าคุมต้นทุนได้ดี"
                         : "กำไรน้อยลงกว่าปีก่อน " + pct(eg2)),
               0.15, 0.0, pct) +
        metric("อัตรากำไรสุทธิ", f.pm,
               f.pm === undefined || f.pm === null ? "" :
               "ขายได้ 100 บาท เหลือเป็นกำไรสุทธิ " + (f.pm * 100).toFixed(1) + " บาท",
               0.15, 0.05, function (v) { return (v * 100).toFixed(1) + "%"; }) +
        metric("ROE", f.roe,
               f.roe === undefined || f.roe === null ? "" :
               "เงินของผู้ถือหุ้นทุก 100 บาท สร้างกำไรได้ " + (f.roe * 100).toFixed(1) + " บาทต่อปี",
               0.15, 0.07, function (v) { return (v * 100).toFixed(1) + "%"; });

      // ── 2. ตลาดคาดหวังอะไร ──
      var expect = "";
      if (f.pe && f.fpe) {
        var gap = (f.fpe / f.pe - 1) * 100;
        var msg, cls3;
        if (gap < -15) {
          cls3 = "up";
          msg = "P/E ปัจจุบัน <b>" + num(f.pe, 1) + "</b> เท่า แต่ P/E ที่คิดจากกำไรปีหน้าเหลือ <b>" +
                num(f.fpe, 1) + "</b> เท่า — <b>ตลาดคาดว่ากำไรจะโตขึ้นมาก</b> " +
                "ราคาที่ดูแพงตอนนี้จึงอาจถูกลงเองถ้ากำไรโตได้จริง";
        } else if (gap > 15) {
          cls3 = "down";
          msg = "P/E ปัจจุบัน <b>" + num(f.pe, 1) + "</b> เท่า แต่ P/E ที่คิดจากกำไรปีหน้าขึ้นเป็น <b>" +
                num(f.fpe, 1) + "</b> เท่า — <b>ตลาดคาดว่ากำไรจะลดลง</b>";
        } else {
          cls3 = "";
          msg = "P/E ปัจจุบัน <b>" + num(f.pe, 1) + "</b> เท่า · คิดจากกำไรปีหน้า <b>" +
                num(f.fpe, 1) + "</b> เท่า — <b>ตลาดคาดว่ากำไรจะทรงตัว</b>";
        }
        expect += '<div class="exrow ' + cls3 + '">' + msg + "</div>";
      }
      if (f.tgt && r.p) {
        var up2 = (f.tgt / r.p - 1) * 100;
        var RECTH = { strong_buy: "แนะนำซื้ออย่างยิ่ง", buy: "แนะนำซื้อ",
                      hold: "แนะนำถือ", sell: "แนะนำขาย",
                      strong_sell: "แนะนำขายอย่างยิ่ง", underperform: "ให้ผลต่ำกว่าตลาด",
                      outperform: "ให้ผลดีกว่าตลาด" };
        expect += '<div class="exrow ' + (up2 > 0 ? "up" : "down") + '">' +
          "นักวิเคราะห์ให้ราคาเป้าหมาย <b>$" + num(f.tgt, 2) + "</b> " +
          (up2 > 0 ? "สูงกว่า" : "ต่ำกว่า") + "ราคาตอนนี้ <b>" + num(Math.abs(up2), 1) + "%</b>" +
          (f.na ? " (จาก " + f.na + " ราย" + (f.rec ? " · " + (RECTH[f.rec] || f.rec) : "") + ")" : "") +
          "</div>";
      }
      if (expect) {
        expect = '<div class="exbox"><div class="exhead">ตลาดคาดหวังอะไร</div>' + expect +
          '<p class="exnote">ตัวเลขคาดการณ์มาจากนักวิเคราะห์ ไม่ใช่ผลจริง ' +
          "และมักผิดบ่อยโดยเฉพาะช่วงที่ธุรกิจเปลี่ยนเร็ว</p></div>";
      }

      // ── 3. ราคาเทียบหมวด ──
      var med2 = (D.meta.sector_med || {})[r.g] || {};
      var val3 = "";
      if (f.pe && med2.pe && med2.pe_q1 && med2.pe_q3) {
        var where3, c4;
        if (f.pe < med2.pe_q1) { where3 = "ถูกกว่าหุ้นส่วนใหญ่ในหมวดนี้"; c4 = "up"; }
        else if (f.pe > med2.pe_q3) { where3 = "แพงกว่าหุ้นส่วนใหญ่ในหมวดนี้"; c4 = "down"; }
        else { where3 = "อยู่ในช่วงปกติของหมวดนี้"; c4 = ""; }
        val3 = '<div class="exbox"><div class="exhead">ราคาแพงหรือถูกเทียบเพื่อนในหมวด</div>' +
          '<div class="exrow ' + c4 + '">P/E <b>' + num(f.pe, 1) + "</b> เท่า · <b>" + where3 +
          "</b><br>หุ้นในหมวด" + esc(r.g) + "ส่วนใหญ่อยู่ที่ <b>" + med2.pe_q1 + "–" + med2.pe_q3 +
          "</b> เท่า · กลาง " + med2.pe + " เท่า (จาก " + med2.pe_n + " ตัว)" +
          (med2.pe_thin ? " — ตัวอย่างน้อย ใช้เทียบอย่างระวัง" : "") + "</div></div>";
      }

      // ── 4. ขนาดและฐานะการเงิน ──
      var facts = [];
      if (f.rev) facts.push(["รายได้ 12 เดือน", money(f.rev)]);
      if (f.mc) facts.push(["มูลค่าบริษัท", money(f.mc)]);
      if (f.fcf) facts.push(["กระแสเงินสดอิสระ",
        (f.fcf < 0 ? "ติดลบ " : "") + money(Math.abs(f.fcf))]);
      if (f.de !== undefined && f.de !== null)
        facts.push(["หนี้ต่อทุน", num(f.de, 0) + "%"]);
      if (f.dy) facts.push(["ปันผลต่อปี", num(f.dy * 100, 2) + "%"]);
      if (f.eps) facts.push(["กำไรต่อหุ้น", "$" + num(f.eps, 2)]);
      var factbox = facts.length
        ? '<div class="exbox"><div class="exhead">ตัวเลขกิจการ</div><div class="factgrid">' +
          facts.map(function (x) {
            return '<div class="fact"><span class="fk">' + x[0] + '</span>' +
                   '<span class="fv">' + x[1] + "</span></div>";
          }).join("") + "</div></div>"
        : "";

      detail = '<div class="erdetail">' +
        '<div class="exbox"><div class="exhead">งบไตรมาสล่าสุดเป็นยังไง</div>' +
        quarter + "</div>" +
        expect + val3 + factbox +
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
          " · คลิกชื่อหุ้นเพื่อดูกราฟและเส้น EMA" +
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

  /* ───────────────── หน้าที่ 8: แตะเส้น × มูลค่าบริษัท ─────────────────

     คัดหุ้นที่ราคาอยู่ในระยะที่ตั้งไว้จากเส้น EMA เส้นใดก็ได้
     จากทั้ง 561 ตัว ไม่กรองหมวดหรือธีม แล้วเรียงตามมูลค่าบริษัทจากใหญ่ลงมา

     แยกรายวันกับรายสัปดาห์เป็นสองแถบ เพราะเป็นคนละชุดข้อมูลกัน
     หุ้นตัวเดียวอาจเข้าเงื่อนไขแค่ไทม์เฟรมเดียว                            */

  function capTouch(r, tf, tol) {
    // คืนรายชื่อเส้นที่ราคาอยู่ในระยะ พร้อมระยะที่ใกล้ที่สุด
    var d = (tf === "w") ? ((r.w || {}).d || null) : (r.d || null);
    if (!d) return null;
    var hit = [], best = 999;
    for (var i = 0; i < EMAS.length; i++) {
      var v = d[i];
      if (v === null || v === undefined) continue;   // เส้นนี้ข้อมูลไม่พอ
      if (Math.abs(v) <= tol) {
        hit.push(EMAS[i]);
        if (Math.abs(v) < best) best = Math.abs(v);
      }
    }
    return hit.length ? { lines: hit, near: best, d: d } : null;
  }

  function capList(tf) {
    var out = [];
    D.rows.forEach(function (r) {
      var t = capTouch(r, tf, st.capTol);
      if (!t) return;
      var mc = (r.f || {}).mc;
      out.push({ r: r, t: t, mc: (mc === undefined ? null : mc) });
    });
    // ใหญ่สุดขึ้นก่อน · ตัวที่ไม่รู้มูลค่าไปท้ายสุด
    out.sort(function (a, b) {
      if (a.mc === null && b.mc === null) return a.r.s.localeCompare(b.r.s);
      if (a.mc === null) return 1;
      if (b.mc === null) return -1;
      return b.mc - a.mc;
    });
    return out;
  }

  function capCard(o, tf) {
    var r = o.r, t = o.t;
    var di = PERIODS.indexOf("1d"), mi = PERIODS.indexOf("1m");
    var chg = r.r[di], m1 = r.r[mi];
    var f = r.f || {};
    var trend = (tf === "w") ? ((r.w || {}).t) : r.t;
    var cls = trend === "up" ? "up" : trend === "down" ? "down" : "";

    var chips = EMAS.map(function (p, i) {
      var v = t.d[i];
      if (v === null || v === undefined) {
        return '<div class="e off"><div class="lb">' + p + '</div><div class="dv">—</div></div>';
      }
      var on = t.lines.indexOf(p) >= 0;
      return '<div class="e ' + (on ? "hit" : "") + '"><div class="lb">' + p + "</div>" +
             '<div class="dv">' + sign(v) + "</div></div>";
    }).join("");

    return '<div class="capcard ' + cls + '" data-tk="' + esc(r.s) +
      '" role="button" tabindex="0">' +
      '<div class="row1">' + starIcon(r.s) +
        '<span class="tk">' + esc(r.s) + "</span>" +
        '<span class="chg ' + ((chg || 0) >= 0 ? "p" : "n") + '">' +
          (chg === null || chg === undefined ? "—" : sign(chg) + "%") + "</span>" +
        '<span class="capmc">' + (o.mc === null ? "ไม่ทราบมูลค่า" : money(o.mc)) + "</span>" +
      "</div>" +
      '<div class="nm">' + esc(r.n) + (r.g ? " · " + esc(r.g) : "") + "</div>" +
      '<div class="badges"><span class="b ' + cls + '">' + (TREND_TH[trend] || "-") + "</span>" +
        '<span class="b">แตะ ' + t.lines.join(" · ") + "</span>" +
        '<span class="b">ใกล้สุด ' + num(t.near, 2) + "%</span></div>" +
      '<div class="emas">' + chips + "</div>" +
      '<div class="efoot"><span>ราคา $' + r.p + "</span>" +
        "<span>1 เดือน " + (m1 === null || m1 === undefined ? "—" : sign(m1) + "%") + "</span>" +
        (f.pe ? "<span>P/E " + num(f.pe, 1) + "</span>" : "") + "</div></div>";
  }

  function renderCap() {
    if (!D) return;
    var tol = st.capTol, n = st.capN;

    var secs = [
      { tf: "d", name: "รายวัน", why: "หนึ่งแท่ง = หนึ่งวัน · อัปเดตทุกวันหลังตลาดปิด" },
      { tf: "w", name: "รายสัปดาห์",
        why: "หนึ่งแท่ง = หนึ่งสัปดาห์ · ข้อมูลถึงสัปดาห์ของวันที่ " +
             thDate(D.meta.weekly_date) }
    ];

    var totals = {};
    var html = secs.map(function (S) {
      var list = capList(S.tf);
      totals[S.tf] = list.length;
      var show = list.slice(0, n);
      if (!show.length) {
        return '<section class="capsec"><div class="tdhead"><h2>' + S.name + "</h2>" +
          '<span class="tdwhy">' + S.why + "</span></div>" +
          '<p class="none">ไม่มีหุ้นที่แตะเส้นในระยะ ' + num(tol, 1) + "%</p></section>";
      }
      var noMc = list.filter(function (x) { return x.mc === null; }).length;
      return '<section class="capsec"><div class="tdhead">' +
        "<h2>" + S.name + ' <span class="tdn">' + list.length + "</span></h2>" +
        '<span class="tdwhy">' + S.why + " · แสดง " + show.length + " ตัวที่ใหญ่สุด" +
        (noMc ? " · ไม่ทราบมูลค่า " + noMc + " ตัว (อยู่ท้ายรายการ)" : "") +
        "</span></div>" +
        '<div class="capgrid">' +
        show.map(function (o) { return capCard(o, S.tf); }).join("") +
        "</div></section>";
    }).join("");

    $("capSections").innerHTML = html;
    $("capNote").innerHTML =
      "คัดจากหุ้นทั้งหมด <b>" + D.meta.count + "</b> ตัว ทุกหมวดทุกธีม · " +
      "ราคาอยู่ในระยะ <b>" + num(tol, 1) + "%</b> จากเส้น EMA เส้นใดก็ได้ · " +
      "เรียงตามมูลค่าบริษัทจากใหญ่สุดลงมา<br>" +
      "เข้าเงื่อนไข: รายวัน <b>" + (totals.d || 0) + "</b> ตัว · " +
      "รายสัปดาห์ <b>" + (totals.w || 0) + "</b> ตัว";
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
    renderBuzz();
    renderCap();
    renderMap();
    renderEma();
    renderTop();
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
    /* เทียบค่ากับหมวดเดียวกัน

       เดิมแสดงแค่ "สูงกว่าหมวด 24%" ซึ่งทำให้เข้าใจผิดได้
       เพราะไม่รู้ว่าหมวดนั้นกระจายกว้างแค่ไหน และคิดจากกี่ตัว
       เช่นหมวดเทคโนโลยีมี P/E ตั้งแต่ 13 ถึง 60 เท่า
       หุ้นที่ P/E 40 จึงไม่ได้ "แพง" จริง แค่อยู่ค่อนไปทางบนของกลุ่ม

       ตอนนี้บอกตำแหน่งในกลุ่มแทน พร้อมช่วงที่หุ้นส่วนใหญ่อยู่และจำนวนตัวอย่าง  */
    function cmpRow(label, val, key, fmt, hint) {
      if (val == null) return "";
      var medv = med[key], n = med[key + "_n"],
          q1 = med[key + "_q1"], q3 = med[key + "_q3"],
          thin = med[key + "_thin"];
      var right = "";

      if (medv != null && medv > 0 && val > 0 && n) {
        var where, cls2;
        if (q1 != null && q3 != null) {
          // บอกตำแหน่งเทียบกลุ่ม ไม่ใช่แค่ห่างจากค่ากลางกี่ %
          if (val < q1) { where = "ถูกกว่าหุ้นส่วนใหญ่ในหมวด"; cls2 = "up"; }
          else if (val > q3) { where = "แพงกว่าหุ้นส่วนใหญ่ในหมวด"; cls2 = "down"; }
          else { where = "อยู่ในช่วงปกติของหมวด"; cls2 = ""; }
        } else {
          var diff = (val / medv - 1) * 100;
          cls2 = diff > 15 ? "down" : diff < -15 ? "up" : "";
          where = diff > 15 ? "สูงกว่าหมวด" : diff < -15 ? "ต่ำกว่าหมวด" : "ใกล้เคียงหมวด";
        }

        right = '<span class="cmp ' + cls2 + '">' + where + "</span>" +
          '<span class="medv">' +
            (q1 != null && q3 != null
              ? "ส่วนใหญ่ " + fmt(q1) + "–" + fmt(q3) + " · กลาง " + fmt(medv)
              : "ค่ากลางหมวด " + fmt(medv)) +
            " · จาก " + n + " ตัว" +
            (thin ? ' <span class="thin">ตัวอย่างน้อย เชื่อได้จำกัด</span>' : "") +
          "</span>";
      }
      return '<div class="frow"><div class="fk">' + label +
             (hint ? '<span class="fh">' + hint + "</span>" : "") + "</div>" +
             '<div class="fv">' + fmt(val) + "</div>" +
             '<div class="fc">' + right + "</div></div>";
    }

    var valuation =
      cmpRow("P/E", f.pe, "pe", function (v) { return num(v, 1) + " เท่า"; },
             f.eps ? "= " + r.p + " ÷ " + num(f.eps, 2) : "ราคาเป็นกี่เท่าของกำไรต่อหุ้น") +
      cmpRow("P/E คาดการณ์", f.fpe, "__none", function (v) { return num(v, 1) + " เท่า"; },
             "คิดจากกำไรที่นักวิเคราะห์คาดปีหน้า") +
      cmpRow("P/BV", f.pb, "pb", function (v) { return num(v, 2) + " เท่า"; },
             "ราคาเป็นกี่เท่าของมูลค่าทางบัญชี") +
      cmpRow("P/S", f.ps, "ps", function (v) { return num(v, 2) + " เท่า"; },
             "ราคาเป็นกี่เท่าของรายได้");

    if (!valuation) valuation = '<p class="mnote">ไม่มีข้อมูลอัตราส่วนราคา</p>';

    // สรุปว่าแพงหรือถูกเทียบเพื่อนในหมวด
    var verdict = "";
    if (f.pe != null && med.pe) {
      // บอกตำแหน่งในกลุ่มโดยใช้ช่วง 25–75% แทนการวัดระยะจากค่ากลาง
      // เพราะหมวดที่กระจายกว้าง การห่างจากค่ากลาง 25% อาจยังอยู่กลางกลุ่มก็ได้
      var q1 = med.pe_q1, q3 = med.pe_q3, n = med.pe_n;
      var t;
      if (q1 != null && q3 != null) {
        t = f.pe > q3 ? ["แพงกว่าหุ้นส่วนใหญ่ในหมวดนี้", "down"]
          : f.pe < q1 ? ["ถูกกว่าหุ้นส่วนใหญ่ในหมวดนี้", "up"]
          : ["อยู่ในช่วงปกติของหมวดนี้", ""];
      } else {
        var d = (f.pe / med.pe - 1) * 100;
        t = d > 25 ? ["สูงกว่าค่ากลางของหมวดพอสมควร", "down"]
          : d < -25 ? ["ต่ำกว่าค่ากลางของหมวดพอสมควร", "up"]
          : ["ใกล้เคียงค่ากลางของหมวด", ""];
      }
      verdict = '<div class="verdict ' + t[1] + '">P/E ' + num(f.pe, 1) +
        " เท่า · " + t[0] +
        (q1 != null && q3 != null
          ? " — หุ้นในหมวด" + esc(r.g) + "ส่วนใหญ่อยู่ที่ " +
            num(q1, 1) + "–" + num(q3, 1) + " เท่า (จาก " + n + " ตัว)"
          : " (" + esc(r.g) + " ค่ากลาง " + num(med.pe, 1) + ")") +
        (med.pe_thin
          ? '<br><span class="thin">ค่ากลางหมวดนี้คิดจากตัวอย่างน้อย ' +
            "ใช้เทียบอย่างระวัง</span>" : "") +
        "</div>";
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
      "<h3>ที่มาของหุ้น</h3><div class='badges'><span class='b'>" +
        (IX_TH[r.ix || 0] || "-") + "</span>" +
        (r.g ? "<span class='b'>" + esc(r.g) + "</span>" : "") + "</div>" +
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
        ["today", "map", "ema", "top", "buzz", "earn", "cmp", "star"]
          .forEach(function (k) {
          var pg = $("page" + k.charAt(0).toUpperCase() + k.slice(1));
          var ft = $("foot" + k.charAt(0).toUpperCase() + k.slice(1));
          if (pg) pg.hidden = (k !== st.page);
          if (ft) ft.hidden = (k !== st.page);
        });
        $("pageTitle").textContent =
          (st.page === "ema" && st.emaSub === "cap")
            ? "หุ้นที่แตะเส้น EMA เรียงตามมูลค่าบริษัท"
            : (TITLE[st.page] || "เช้านี้");
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
    seg("bzSig", "bzSig", null, renderBuzz);
    seg("bzDir", "bzDir", null, renderBuzz);
    seg("bzN", "bzN", Number, renderBuzz);
    seg("idx", "idx", null, renderEma);
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
    // แท็บย่อยในหน้าหาเส้น EMA
    $("emaSub").addEventListener("click", function (e) {
      var b = e.target.closest("[data-sub]");
      if (!b) return;
      st.emaSub = b.dataset.sub;
      $("emaSub").querySelectorAll("[data-sub]").forEach(function (x) {
        x.classList.toggle("on", x.dataset.sub === st.emaSub);
      });
      var isCap = st.emaSub === "cap";
      $("emaFind").hidden = isCap;
      $("emaCap").hidden = !isCap;
      $("pageTitle").textContent = isCap
        ? "หุ้นที่แตะเส้น EMA เรียงตามมูลค่าบริษัท"
        : "หุ้นที่ราคาใกล้เส้น EMA";
      if (isCap) renderCap();
      window.scrollTo(0, 0);
    });

    seg("capN", "capN", Number, renderCap);
    $("capTol").addEventListener("input", function (e) {
      st.capTol = Number(e.target.value);
      $("capTolOut").textContent = st.capTol.toFixed(1) + "%";
      later(renderCap);
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
