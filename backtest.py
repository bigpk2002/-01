#!/usr/bin/env python3
"""
ทดสอบย้อนหลัง (backtest) สัญญาณในเว็บ ว่าเคยใช้ได้จริงหรือไม่

    python backtest.py            ใช้ราคาจริงจาก Yahoo (ดึงใหม่ ~3 นาที)
    python backtest.py --demo     ใช้ข้อมูลจำลอง ไว้ตรวจว่าโค้ดถูก
    python backtest.py --years 5  ย้อนหลังกี่ปี (ค่าเริ่มต้น 3)

═══════════════════════════════════════════════════════════════
กติกาที่ยึด เพื่อไม่ให้ผลลัพธ์หลอกตัวเอง
═══════════════════════════════════════════════════════════════

1. ไม่แอบดูอนาคต (look-ahead bias)
   ทุกสัญญาณ ณ วันที่ t คำนวณจากราคาถึงวันที่ t เท่านั้น
   ผลตอบแทนวัดจากวันที่ t ไปข้างหน้า ไม่มีการใช้ข้อมูลที่ยังไม่เกิด

2. เทียบกับตลาด ไม่ใช่ดูกำไรลอย ๆ
   ถ้าตลาดขึ้น 20% แล้วสัญญาณให้ 15% แปลว่า "แย่กว่าไม่ทำอะไร"
   จึงวัดเป็น "ส่วนต่างจากค่าเฉลี่ยหุ้นทั้งหมดในวันเดียวกัน" (excess return)

3. ลดการนับซ้ำ
   สุ่มตัวอย่างทุก 5 วันทำการ แทนที่จะนับทุกวัน
   เพราะสัญญาณเดียวกันมักค้างอยู่หลายวันติด ถ้านับทุกวันจะเหมือนมีตัวอย่างเยอะกว่าจริง

4. บอกจำนวนตัวอย่าง
   ถ้าเจอสัญญาณไม่ถึง 100 ครั้ง อย่าเชื่อผลลัพธ์

═══════════════════════════════════════════════════════════════
ข้อจำกัดที่แก้ไม่ได้ ต้องรู้ไว้
═══════════════════════════════════════════════════════════════

• รายชื่อหุ้นเป็นสมาชิกดัชนี "ปัจจุบัน" (survivorship bias)
  หุ้นที่เคยอยู่แล้วหลุดออกไปเพราะผลงานแย่ ไม่ได้อยู่ในชุดทดสอบ
  ทำให้ผลลัพธ์ดูดีกว่าความจริงเล็กน้อยทุกสัญญาณเท่า ๆ กัน

• ทดสอบได้เฉพาะสัญญาณที่คำนวณจากราคา
  สัญญาณ "P/E ต่ำกว่าหมวดแต่ยังขาขึ้น" ทดสอบไม่ได้
  เพราะเรามีแต่ P/E ของวันนี้ ไม่มี P/E ย้อนหลัง
  ถ้าเอา P/E วันนี้ไปใช้กับอดีต = แอบดูอนาคต ซึ่งผิดกติกาข้อ 1

• ไม่คิดค่าคอมมิชชัน ภาษี และส่วนต่างราคาซื้อขาย
  ของจริงจะได้น้อยกว่าที่เห็น

• ช่วงเวลาที่ทดสอบสั้น (3 ปี) และเป็นช่วงตลาดขาขึ้นเป็นหลัก
  ผลอาจต่างไปมากในตลาดขาลง
"""

from __future__ import annotations

import argparse
import binascii
import json
import os
import sys
import time
from datetime import datetime

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "docs", "backtest.json")

EMAS = [5, 10, 20, 50, 100, 200]
SAMPLE_EVERY = 5          # สุ่มตัวอย่างทุกกี่วันทำการ
HORIZONS = [20, 60]       # วัดผลไปข้างหน้ากี่วันทำการ (~1 เดือน, ~3 เดือน)
MIN_SAMPLES = 100         # น้อยกว่านี้ถือว่าตัวอย่างไม่พอ

SIGNALS = {
    "sup200":   "ทดสอบแนวรับ EMA200",
    "pullback": "ย่อในขาขึ้นแข็งแรง",
    "nearHi":   "ใกล้จุดสูงสุด 52 สัปดาห์",
    "strong":   "แรงกว่าหมวดมาก",
    "bothTf":   "รายวันและรายสัปดาห์ตรงกัน",
    "brk200":   "หลุดเส้น EMA200",
    "nearLo":   "ใกล้จุดต่ำสุด 52 สัปดาห์",
    "weak":     "อ่อนกว่าหมวดมาก",
    "res200":   "ชนแนวต้าน EMA200",
    "squeeze":  "เส้นบีบตัว",
}
UNTESTABLE = {"cheapUp": "P/E ต่ำกว่าหมวดแต่ยังขาขึ้น"}


def stable_seed(text: str) -> int:
    return binascii.crc32(text.encode("utf-8")) % 100_000


# ────────────────────── ข้อมูลราคา ──────────────────────

def load_universe() -> tuple[list[str], dict[str, str]]:
    """รายชื่อหุ้นและหมวดธุรกิจ จากไฟล์ที่ build.py สร้างไว้"""
    path = os.path.join(HERE, "docs", "data.json")
    if not os.path.exists(path):
        sys.exit("ไม่พบ docs/data.json — รัน build.py ก่อน")
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    syms = [r["s"] for r in d["rows"]]
    sect = {r["s"]: r.get("g", "") for r in d["rows"]}
    return syms, sect


def random_prices(symbols: list[str], years: int) -> pd.DataFrame:
    """ราคาสุ่มล้วน — ใช้เป็นชุดควบคุม

    ราคาแบบนี้ไม่มีรูปแบบใด ๆ ให้จับ ถ้าวิธีทดสอบของเราถูกต้อง
    ทุกสัญญาณต้องได้ส่วนต่างใกล้ 0 และค่า t ต่ำ
    ถ้าสัญญาณไหนได้กำไรชัดเจนจากข้อมูลสุ่ม แปลว่ามีบั๊กหรือแอบดูอนาคต
    """
    bars = years * 252 + 260
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=bars)
    data = {}
    for i, s in enumerate(symbols):
        rng = np.random.default_rng(stable_seed(s) + 777_000)
        ret = rng.normal(0.0004, 0.018, len(idx))      # เดินสุ่มล้วน ไม่มีรูปแบบ
        data[s] = 50 * np.exp(np.cumsum(ret))
    return pd.DataFrame(data, index=idx)


def demo_prices(symbols: list[str], years: int) -> pd.DataFrame:
    bars = years * 252 + 260
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=bars)
    data = {}
    for s in symbols:
        rng = np.random.default_rng(stable_seed(s))
        ret = rng.normal(rng.normal(0.0005, 0.0008), rng.uniform(.012, .032), len(idx))
        ret += 0.005 * np.sin(np.linspace(0, rng.uniform(3, 10) * np.pi, len(idx)))
        data[s] = 20 * np.exp(np.cumsum(ret)) * rng.uniform(0.4, 18)
    return pd.DataFrame(data, index=idx)


def real_prices(symbols: list[str], years: int) -> pd.DataFrame:
    import yfinance as yf
    frames, batch = {}, 40
    print(f"ดึงราคาย้อนหลัง {years} ปี ของ {len(symbols)} ตัว")
    for i in range(0, len(symbols), batch):
        chunk = symbols[i:i + batch]
        print(f"  {i + 1}-{i + len(chunk)} / {len(symbols)}")
        try:
            raw = yf.download(tickers=chunk, period=f"{years + 1}y", interval="1d",
                              auto_adjust=False, group_by="ticker",
                              threads=False, progress=False)
        except Exception as e:
            print(f"    ! {str(e)[:80]}")
            continue
        if raw is None or not len(raw):
            continue
        for s in chunk:
            try:
                df = raw[s] if isinstance(raw.columns, pd.MultiIndex) else raw
                col = "Adj Close" if "Adj Close" in df.columns else "Close"
                ser = df[col].dropna()
                if len(ser) > 260:
                    frames[s] = ser
            except (KeyError, TypeError):
                pass
        time.sleep(1.5)
    if not frames:
        sys.exit("ดึงราคาไม่ได้เลย")
    px = pd.DataFrame(frames)
    px.index = pd.to_datetime(px.index)
    if getattr(px.index, "tz", None) is not None:
        px.index = px.index.tz_localize(None)
    print(f"  ได้ {px.shape[1]} ตัว × {px.shape[0]} วัน\n")
    return px


# ────────────────────── คำนวณสัญญาณย้อนหลัง ──────────────────────

def signal_matrices(px: pd.DataFrame, sect: dict) -> dict[str, pd.DataFrame]:
    """
    สร้างตาราง True/False ของแต่ละสัญญาณ ขนาด (วัน × หุ้น)

    ทุกค่าที่ตำแหน่ง [t, หุ้น] คำนวณจากราคาถึงวันที่ t เท่านั้น
    ฟังก์ชัน ewm และ rolling ของ pandas มองย้อนหลังอย่างเดียวโดยธรรมชาติ
    จึงไม่มีการแอบดูอนาคต
    """
    ema = {p: px.ewm(span=p, adjust=False).mean() for p in EMAS}
    dist = {p: (px - ema[p]) / ema[p] * 100 for p in EMAS}

    trend_up = (px > ema[200]) & (ema[50] > ema[200])
    trend_dn = (px < ema[200]) & (ema[50] < ema[200])

    aligned = ema[5] > ema[10]
    for a, b in zip(EMAS[1:-1], EMAS[2:]):
        aligned &= ema[a] > ema[b]

    stack = np.stack([ema[p].to_numpy() for p in EMAS])
    ribbon = pd.DataFrame((stack.max(axis=0) - stack.min(axis=0)) / px.to_numpy() * 100,
                          index=px.index, columns=px.columns)

    # จุดสูงสุด/ต่ำสุด 52 สัปดาห์ (252 วันทำการ) นับถึงวันนั้น
    hi52 = px.rolling(252, min_periods=200).max()
    lo52 = px.rolling(252, min_periods=200).min()

    # เทรนด์รายสัปดาห์: ใช้ราคาปิดวันศุกร์ แล้วเติมค่าไปข้างหน้า
    # (ค่าของสัปดาห์ที่ปิดแล้วเท่านั้น ไม่ใช่สัปดาห์ที่กำลังวิ่ง)
    wk = px.resample("W-FRI").last()
    w50 = wk.ewm(span=50, adjust=False).mean()
    w200 = wk.ewm(span=200, adjust=False).mean()
    w_up = ((wk > w200) & (w50 > w200)).shift(1).reindex(px.index, method="ffill")
    w_near = wk.copy()
    wd = {p: (wk - wk.ewm(span=p, adjust=False).mean())
              / wk.ewm(span=p, adjust=False).mean() * 100 for p in EMAS}
    w_touch = wd[5].abs() <= 2
    for p in EMAS[1:]:
        w_touch |= wd[p].abs() <= 2
    w_touch = w_touch.shift(1).reindex(px.index, method="ffill")

    # ผลตอบแทน 1 เดือนย้อนหลัง เทียบกับค่ากลางของหมวด
    r1m = px / px.shift(21) - 1
    sec_med = pd.DataFrame(index=px.index, columns=px.columns, dtype=float)
    groups: dict[str, list[str]] = {}
    for s in px.columns:
        groups.setdefault(sect.get(s, ""), []).append(s)
    for g, cols in groups.items():
        if len(cols) >= 4:
            med = r1m[cols].median(axis=1)
            for c in cols:
                sec_med[c] = med
    rel = (r1m - sec_med) * 100

    touch_short = dist[5].abs() <= 2
    for p in (10, 20, 50):
        touch_short |= dist[p].abs() <= 2
    touch_any = dist[5].abs() <= 2
    for p in EMAS[1:]:
        touch_any |= dist[p].abs() <= 2

    return {
        "sup200":   trend_up & (dist[200] >= 0) & (dist[200] <= 2),
        "pullback": aligned & touch_short,
        "nearHi":   (px >= hi52 * 0.97) & (px <= hi52 * 1.02),
        "strong":   rel >= 15,
        "bothTf":   trend_up & w_up.astype(bool) & touch_any & w_touch.astype(bool),
        "brk200":   (dist[200] < 0) & (dist[200] >= -4) & (dist[50] < dist[200]),
        "nearLo":   px <= lo52 * 1.03,
        "weak":     rel <= -15,
        "res200":   trend_dn & (dist[200] <= 0) & (dist[200] >= -2),
        "squeeze":  ribbon <= 3,
    }


def run_backtest(px: pd.DataFrame, sect: dict) -> dict:
    sig = signal_matrices(px, sect)
    n_days = len(px.index)
    results = {}

    for h in HORIZONS:
        # ผลตอบแทนไปข้างหน้า h วันทำการ
        fwd = (px.shift(-h) / px - 1) * 100
        # ค่าเฉลี่ยของหุ้นทั้งหมดในวันเดียวกัน = "ตลาด" ที่ใช้เทียบ
        market = fwd.mean(axis=1)
        excess = fwd.sub(market, axis=0)

        # เลือกเฉพาะวันที่สุ่มตัวอย่าง และมีข้อมูลข้างหน้าครบ
        rows = np.zeros(n_days, dtype=bool)
        rows[200:n_days - h:SAMPLE_EVERY] = True
        mask_rows = pd.Series(rows, index=px.index)

        for key, mat in sig.items():
            m = mat & mask_rows.to_numpy()[:, None] & fwd.notna()
            vals = excess.to_numpy()[m.to_numpy()]
            raw = fwd.to_numpy()[m.to_numpy()]
            vals = vals[np.isfinite(vals)]
            raw = raw[np.isfinite(raw)]
            n = len(vals)
            if n == 0:
                continue

            mean_ex = float(np.mean(vals))
            med_ex = float(np.median(vals))
            win = float(np.mean(vals > 0) * 100)
            std = float(np.std(vals, ddof=1)) if n > 1 else 0.0
            # t เบื้องต้น — ตัวอย่างซ้อนทับกันอยู่บ้าง ค่าจริงจะต่ำกว่านี้
            tstat = (mean_ex / (std / np.sqrt(n))) if std > 0 else 0.0

            results.setdefault(key, {})[f"h{h}"] = {
                "n": n,
                "excess_mean": round(mean_ex, 3),
                "excess_median": round(med_ex, 3),
                "raw_mean": round(float(np.mean(raw)), 3),
                "win_rate": round(win, 1),
                "tstat": round(float(tstat), 2),
            }

        # เส้นฐาน: สุ่มหุ้นทั่วไปในวันเดียวกัน
        allm = mask_rows.to_numpy()[:, None] & fwd.notna().to_numpy()
        base_raw = fwd.to_numpy()[allm]
        base_raw = base_raw[np.isfinite(base_raw)]
        results.setdefault("_baseline", {})[f"h{h}"] = {
            "n": len(base_raw),
            "raw_mean": round(float(np.mean(base_raw)), 3),
            "win_rate": round(float(np.mean(base_raw > 0) * 100), 1),
        }

    return results


def verdict(st: dict) -> tuple[str, str]:
    """สรุปว่าสัญญาณนี้มีหลักฐานแค่ไหน"""
    n, ex, t = st["n"], st["excess_mean"], st["tstat"]
    if n < MIN_SAMPLES:
        return "ตัวอย่างน้อยเกิน", "none"
    if abs(t) < 2:
        return "ไม่ต่างจากสุ่ม", "none"
    if ex > 0:
        return "ดีกว่าตลาดเล็กน้อย" if ex < 1.5 else "ดีกว่าตลาด", "good"
    return "แย่กว่าตลาดเล็กน้อย" if ex > -1.5 else "แย่กว่าตลาด", "bad"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--years", type=int, default=3)
    ap.add_argument("--random", action="store_true",
                    help="ทดสอบด้วยราคาสุ่มล้วน เพื่อพิสูจน์ว่าวิธีการไม่มีอคติ "
                         "(ถ้าวิธีถูก ทุกสัญญาณต้องได้ส่วนต่างใกล้ 0)")
    a = ap.parse_args()

    t0 = time.time()
    syms, sect = load_universe()
    print(f"ชุดทดสอบ {len(syms)} ตัว · ย้อนหลัง {a.years} ปี\n")

    if a.random:
        print("โหมดควบคุม: ราคาสุ่มล้วน — ทุกสัญญาณควรได้ส่วนต่างใกล้ 0\n")
        px = random_prices(syms, a.years)
    elif a.demo:
        px = demo_prices(syms, a.years)
    else:
        px = real_prices(syms, a.years)
    px = px.dropna(axis=1, thresh=int(len(px) * 0.6))
    print(f"ใช้ได้จริง {px.shape[1]} ตัว × {px.shape[0]} วัน\n")

    res = run_backtest(px, sect)

    print("=" * 74)
    print("ผลทดสอบย้อนหลัง — ส่วนต่างจากค่าเฉลี่ยหุ้นทั้งหมดในวันเดียวกัน")
    print("=" * 74)
    for h in HORIZONS:
        b = res["_baseline"][f"h{h}"]
        print(f"\nถือต่อ {h} วันทำการ (~{h // 21 or 1} เดือน) · "
              f"หุ้นทั่วไปได้เฉลี่ย {b['raw_mean']:+.2f}% ชนะ {b['win_rate']:.0f}%")
        print(f"  {'สัญญาณ':<28} {'ครั้ง':>6} {'ส่วนต่าง':>9} {'ชนะตลาด':>9} "
              f"{'t':>6}  สรุป")
        rows = [(k, res[k][f"h{h}"]) for k in SIGNALS if k in res]
        rows.sort(key=lambda x: -x[1]["excess_mean"])
        for key, st in rows:
            v, _ = verdict(st)
            print(f"  {SIGNALS[key]:<28} {st['n']:>6} {st['excess_mean']:>+8.2f}% "
                  f"{st['win_rate']:>8.1f}% {st['tstat']:>6.1f}  {v}")

    for k, name in UNTESTABLE.items():
        print(f"\n  {name}: ทดสอบไม่ได้ (ไม่มีข้อมูลพื้นฐานย้อนหลัง)")

    payload = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "years": a.years,
        "universe": px.shape[1],
        "days": px.shape[0],
        "demo": bool(a.demo or a.random),
        "mode": "random" if a.random else ("demo" if a.demo else "real"),
        "sample_every": SAMPLE_EVERY,
        "horizons": HORIZONS,
        "min_samples": MIN_SAMPLES,
        "signals": {k: {**v, "name": SIGNALS[k],
                        "verdict": verdict(v[f"h{HORIZONS[-1]}"])[0],
                        "grade": verdict(v[f"h{HORIZONS[-1]}"])[1]}
                    for k, v in res.items() if k in SIGNALS},
        "baseline": res["_baseline"],
        "untestable": UNTESTABLE,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"\nเขียนผลลง {OUT}")
    print(f"ใช้เวลา {(time.time() - t0) / 60:.1f} นาที")
    return 0


if __name__ == "__main__":
    sys.exit(main())
