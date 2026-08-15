#!/usr/bin/env python3
"""
สร้างข้อมูลสำหรับเว็บไซต์ — ดึงราคา คำนวณ แล้วเขียนออกเป็น docs/data.json

ทำงานทั้งหมดในไฟล์เดียว ตั้งใจให้ GitHub Actions เรียกวันละครั้ง
ไม่ต้องมีฐานข้อมูล ไม่ต้องมีเซิร์ฟเวอร์ ผลที่ได้คือไฟล์ JSON ไฟล์เดียว
ที่หน้าเว็บ (docs/index.html) โหลดไปแสดงผลและกรองในเบราว์เซอร์

    python build.py            ดึงข้อมูลจริงจาก Yahoo Finance
    python build.py --demo     ข้อมูลจำลอง ไม่ต้องต่อเน็ต
    python build.py --limit 60 ทดลองกับ 60 ตัวแรก
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import random
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "docs", "data.json")

EMAS = [5, 10, 20, 50, 100, 200]
PERIODS = ["1d", "1w", "1m", "3m", "ytd", "1y"]
MIN_BARS = max(EMAS) + 20
SPARK_BARS = 60

BATCH_SIZE = 40
SLEEP_BETWEEN = 1.5
MAX_RETRY = 4
BACKOFF_BASE = 8

UA = {"User-Agent": "Mozilla/5.0 (personal stock research tool)"}

SP500_SOURCES = [
    ("csv", "https://raw.githubusercontent.com/datasets/s-and-p-500-companies"
            "/main/data/constituents.csv"),
    ("wiki", "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"),
]
NDX_SOURCES = [
    ("csv", "https://raw.githubusercontent.com/Gary-Strauss/NASDAQ100_Constituents"
            "/master/data/nasdaq100_constituents.csv"),
    ("wiki", "https://en.wikipedia.org/wiki/Nasdaq-100"),
]

SECTOR_TH = {
    "Information Technology": "เทคโนโลยีสารสนเทศ",
    "Health Care": "การแพทย์และสุขภาพ",
    "Financials": "การเงินและธนาคาร",
    "Consumer Discretionary": "สินค้าฟุ่มเฟือย",
    "Consumer Staples": "สินค้าจำเป็น",
    "Communication Services": "สื่อสารและบันเทิง",
    "Industrials": "อุตสาหกรรม",
    "Energy": "พลังงาน",
    "Utilities": "สาธารณูปโภค",
    "Real Estate": "อสังหาริมทรัพย์",
    "Materials": "วัตถุดิบและเคมีภัณฑ์",
}

TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
             "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]


def thai_date(d) -> str:
    return f"{d.day} {TH_MONTHS[d.month - 1]} {d.year + 543}"


def norm(sym) -> str:
    return str(sym).strip().upper().replace(".", "-")


# ────────────────────── รายชื่อสมาชิกดัชนี ──────────────────────

def _get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _pick(df, *names):
    cols = {str(c).lower().strip(): c for c in df.columns}
    for n in names:
        if n.lower() in cols:
            return cols[n.lower()]
    return None


def _rows_from(df) -> list[dict]:
    tcol = _pick(df, "Symbol", "Ticker", "Ticker symbol")
    ncol = _pick(df, "Security", "Company", "Name", "Company Name")
    scol = _pick(df, "GICS Sector", "GICS_Sector", "Sector")
    if not tcol:
        raise ValueError("ไม่พบคอลัมน์สัญลักษณ์หุ้น")
    out = []
    for _, r in df.iterrows():
        s = norm(r[tcol])
        if s and len(s) <= 8 and re.fullmatch(r"[A-Z\-]+", s):
            sec = str(r[scol]).strip() if scol else ""
            out.append({"t": s,
                        "n": str(r[ncol]).strip() if ncol else "",
                        "g": SECTOR_TH.get(sec, sec)})
    return out


def fetch_index(sources, label) -> list[dict]:
    for kind, url in sources:
        try:
            if kind == "csv":
                df = pd.read_csv(io.BytesIO(_get(url)))
            else:
                tables = pd.read_html(io.BytesIO(_get(url)))
                df = max((t for t in tables if _pick(t, "Symbol", "Ticker")),
                         key=len, default=None)
                if df is None:
                    raise ValueError("ไม่พบตารางที่ต้องการ")
            rows = _rows_from(df)
            if len(rows) < 50:
                raise ValueError(f"ได้แค่ {len(rows)} ตัว น้อยผิดปกติ")
            print(f"  {label}: {len(rows)} ตัว (จาก {kind})")
            return rows
        except Exception as e:
            print(f"  ! {label} จาก {kind} ไม่สำเร็จ: {e}")
    return []


def build_universe() -> dict[str, dict]:
    print("ดึงรายชื่อสมาชิกดัชนี")
    sp = fetch_index(SP500_SOURCES, "S&P 500")
    ndx = fetch_index(NDX_SOURCES, "Nasdaq 100")
    if not sp and not ndx:
        sys.exit("ดึงรายชื่อดัชนีไม่ได้เลย หยุดการทำงาน (ข้อมูลเดิมบนเว็บยังอยู่)")

    uni: dict[str, dict] = {}
    for r in sp:
        uni[r["t"]] = {**r, "sp": 1, "ndx": 0}
    for r in ndx:
        if r["t"] in uni:
            uni[r["t"]]["ndx"] = 1
        else:
            uni[r["t"]] = {**r, "sp": 0, "ndx": 1}
    print(f"  รวม {len(uni)} ตัว (หักตัวซ้ำแล้ว)\n")
    return uni


# ────────────────────── ธีม ──────────────────────

YAML_BOOL_BACK = {"True": "ON", "False": "NO"}


def load_themes(universe: dict) -> tuple[list[dict], list[str]]:
    path = os.path.join(HERE, "themes.yml")
    with open(path, encoding="utf-8") as f:
        cfg = (yaml.safe_load(f) or {}).get("themes") or []
    if not cfg:
        sys.exit("ไฟล์ themes.yml ว่างเปล่า")

    themes, warnings = [], []
    for i, t in enumerate(cfg, 1):
        key, name = str(t.get("key", "")).strip(), str(t.get("name", "")).strip()
        if not key or not name:
            sys.exit(f"ธีมลำดับที่ {i} ขาด key หรือ name")

        tickers, missing, seen = [], [], set()
        for x in (t.get("tickers") or []):
            # YAML ตีความ ON / NO เป็น boolean ซึ่งบังเอิญเป็นสัญลักษณ์หุ้นจริง
            v = YAML_BOOL_BACK.get(str(x), str(x)) if isinstance(x, bool) else str(x)
            v = norm(v)
            if not v or v in seen:
                continue
            seen.add(v)
            if v in universe:
                tickers.append(v)
            else:
                missing.append(v)

        if missing:
            warnings.append(f"[{key}] ไม่อยู่ในดัชนีแล้ว จึงข้ามไป: {', '.join(sorted(missing))}")

        themes.append({"key": key, "name": name,
                       "desc": str(t.get("description", "")).strip(),
                       "order": int(t.get("order", i)),
                       "tickers": tickers})

    n = len({x for t in themes for x in t["tickers"]})
    print(f"โหลดธีม {len(themes)} กลุ่ม · หุ้นในธีม {n} ตัว")
    for w in warnings:
        print(f"  ! {w}")
    print()
    return themes, warnings


# ────────────────────── ราคา ──────────────────────

def _sleep(sec: float) -> None:
    time.sleep(sec + random.uniform(0, 0.6))


def _tidy(raw, sym):
    try:
        df = raw[sym] if isinstance(raw.columns, pd.MultiIndex) else raw
    except KeyError:
        return None
    if df is None or len(df) == 0:
        return None
    df = df.copy()
    df.columns = [str(c).strip().lower() for c in df.columns]
    if "close" not in df.columns:
        return None
    df["adj_close"] = df["adj close"] if "adj close" in df.columns else df["close"]
    if "volume" not in df.columns:
        df["volume"] = 0.0
    df = df[["adj_close", "volume"]]
    df.index = pd.to_datetime(df.index, errors="coerce")
    if getattr(df.index, "tz", None) is not None:
        df.index = df.index.tz_localize(None)
    df = df[df.index.notna()].dropna(subset=["adj_close"]).sort_index()
    return df if len(df) else None


def fetch_prices(symbols: list[str], period: str = "3y") -> dict[str, pd.DataFrame]:
    import yfinance as yf

    out, failed = {}, []
    for i in range(0, len(symbols), BATCH_SIZE):
        chunk = symbols[i:i + BATCH_SIZE]
        print(f"  ดาวน์โหลด {i + 1}-{i + len(chunk)} / {len(symbols)}")
        raw = None
        for attempt in range(1, MAX_RETRY + 1):
            try:
                raw = yf.download(tickers=chunk, period=period, interval="1d",
                                  auto_adjust=False, group_by="ticker",
                                  threads=False, progress=False)
                if raw is not None and len(raw):
                    break
            except Exception as e:
                if attempt == MAX_RETRY:
                    print(f"    ! ล้มเหลวถาวร: {str(e)[:100]}")
                    raw = None
                    break
                wait = BACKOFF_BASE * (2 ** (attempt - 1))
                print(f"    ! {str(e)[:90]} — รอ {wait} วินาที ({attempt}/{MAX_RETRY})")
                _sleep(wait)

        if raw is not None and len(raw):
            for s in chunk:
                d = _tidy(raw, s)
                if d is not None:
                    out[s] = d
                else:
                    failed.append(s)
        else:
            failed.extend(chunk)
        _sleep(SLEEP_BETWEEN)

    failed = sorted(set(failed) - set(out))
    print(f"  ได้ข้อมูล {len(out)}/{len(symbols)} ตัว")
    if failed:
        print(f"  ตัวที่ไม่ได้: {', '.join(failed[:15])}{' …' if len(failed) > 15 else ''}")
    return out


def demo_prices(symbols: list[str], bars: int = 760) -> dict[str, pd.DataFrame]:
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=bars)
    n = len(idx)
    out = {}
    for s in symbols:
        rng = np.random.default_rng(abs(hash(s)) % 10_000)
        ret = rng.normal(rng.normal(0.0005, 0.0008), rng.uniform(.012, .032), n)
        ret += 0.005 * np.sin(np.linspace(0, rng.uniform(3, 10) * np.pi, n))
        close = 20 * np.exp(np.cumsum(ret)) * rng.uniform(0.4, 18)
        out[s] = pd.DataFrame(
            {"adj_close": close, "volume": rng.integers(1e6, 6e7, n)}, index=idx)
    return out


# ────────────────────── คำนวณ ──────────────────────

def anchor_date(last, period: str):
    if period == "1d":
        return last - pd.Timedelta(days=1)
    if period == "1w":
        return last - pd.Timedelta(days=7)
    if period == "1m":
        return last - pd.DateOffset(months=1)
    if period == "3m":
        return last - pd.DateOffset(months=3)
    if period == "1y":
        return last - pd.DateOffset(years=1)
    if period == "ytd":
        return pd.Timestamp(year=last.year, month=1, day=1) - pd.Timedelta(days=1)
    raise ValueError(period)


def spark(series: pd.Series) -> list[int]:
    v = series.tail(SPARK_BARS).to_numpy(dtype=float)
    lo, hi = float(v.min()), float(v.max())
    if not np.isfinite(lo) or hi <= lo:
        return [50] * len(v)
    return [int(round((x - lo) / (hi - lo) * 100)) for x in v]


def analyse(info: dict, df: pd.DataFrame) -> dict | None:
    close = df["adj_close"]
    price = float(close.iloc[-1])
    if not np.isfinite(price) or price <= 0:
        return None

    last_date = df.index[-1]
    first_date = df.index[0]

    # ── % เปลี่ยนแปลงแต่ละช่วง ──
    # หุ้นที่ประวัติไม่ครบช่วงนั้นจะได้ค่า None ไม่ใช่คำนวณจากเท่าที่มี
    rets = {}
    for p in PERIODS:
        a = anchor_date(last_date, p)
        if first_date > a:
            rets[p] = None
            continue
        prior = close[close.index <= a]
        if len(prior) == 0 or prior.iloc[-1] <= 0:
            rets[p] = None
            continue
        rets[p] = round((price / float(prior.iloc[-1]) - 1) * 100, 2)

    row = {**{k: info[k] for k in ("n", "g")},
           "s": info["t"], "p": round(price, 2),
           "r": [rets[p] for p in PERIODS],
           "h": spark(close)}

    # ── ระยะห่างจากเส้น EMA ──
    if len(df) >= MIN_BARS:
        ema = {p: close.ewm(span=p, adjust=False).mean() for p in EMAS}
        lv = {p: float(ema[p].iloc[-1]) for p in EMAS}
        if all(np.isfinite(v) and v > 0 for v in lv.values()):
            row["d"] = [round((price - lv[p]) / lv[p] * 100, 2) for p in EMAS]
            e50, e200 = lv[50], lv[200]
            row["t"] = ("up" if (price > e200 and e50 > e200)
                        else "down" if (price < e200 and e50 < e200) else "flat")
            row["a"] = int(all(lv[EMAS[i]] > lv[EMAS[i + 1]]
                               for i in range(len(EMAS) - 1)))
            row["rb"] = round((max(lv.values()) - min(lv.values())) / price * 100, 2)
            s200 = ema[200]
            row["sl"] = (round(float((s200.iloc[-1] - s200.iloc[-11])
                                     / abs(s200.iloc[-11]) * 100), 2)
                         if len(s200) > 11 and s200.iloc[-11] else 0.0)

    turnover = float((close * df["volume"].fillna(0)).tail(20).mean())
    row["v"] = round(turnover / 1e6, 1) if np.isfinite(turnover) else 0.0
    return row


# ────────────────────── main ──────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="สร้างข้อมูลสำหรับเว็บไซต์")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--period", default="3y")
    a = ap.parse_args()

    t0 = time.time()
    universe = build_universe()
    themes, warnings = load_themes(universe)

    symbols = sorted(universe)
    if a.limit:
        keep = {x for t in themes for x in t["tickers"]}
        symbols = sorted(keep)[:a.limit] or symbols[:a.limit]

    print(f"เริ่มดึงราคา {len(symbols)} ตัว (ย้อนหลัง {a.period})")
    prices = demo_prices(symbols) if a.demo else fetch_prices(symbols, a.period)
    if not prices:
        sys.exit("ดึงราคาไม่ได้เลย — ข้อมูลเดิมบนเว็บยังอยู่ ลองรันใหม่อีกครั้ง")
    print()

    rows, last_date = [], None
    for s in symbols:
        df = prices.get(s)
        if df is None or len(df) < 30:
            continue
        try:
            r = analyse(universe[s], df)
        except Exception:
            r = None
        if r:
            rows.append(r)
            d = df.index[-1]
            if last_date is None or d > last_date:
                last_date = d

    rows.sort(key=lambda r: r["s"])
    have = {r["s"] for r in rows}
    for t in themes:
        t["tickers"] = [x for x in t["tickers"] if x in have]

    tz = timezone(timedelta(hours=7))
    payload = {
        "meta": {
            "emas": EMAS,
            "periods": PERIODS,
            "count": len(rows),
            "ema_count": sum(1 for r in rows if "d" in r),
            "date": thai_date(last_date.date()) if last_date is not None else "-",
            "generated": f"{thai_date(datetime.now(tz))} {datetime.now(tz):%H:%M} น.",
            "sectors": sorted({r["g"] for r in rows if r["g"]}),
            "demo": bool(a.demo),
            "warnings": warnings,
        },
        "themes": [{k: t[k] for k in ("key", "name", "desc", "order", "tickers")}
                   for t in themes],
        "rows": rows,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(OUT) / 1024
    print(f"เขียนไฟล์ -> {OUT} ({size:.0f} KB)")
    print(f"  หุ้นทั้งหมด {len(rows)} ตัว · คำนวณ EMA ได้ {payload['meta']['ema_count']} ตัว")
    print(f"  ข้อมูลปิดตลาดวันที่ {payload['meta']['date']}")

    for tol in (1.0, 1.5, 3.0):
        n = sum(1 for r in rows if "d" in r and min(abs(x) for x in r["d"]) <= tol)
        up = sum(1 for r in rows if "d" in r and r.get("t") == "up"
                 and min(abs(x) for x in r["d"]) <= tol)
        print(f"  ระยะ {tol}% : ใกล้เส้น {n} ตัว (เป็นขาขึ้น {up} ตัว)")

    print(f"\nใช้เวลา {(time.time() - t0) / 60:.1f} นาที")
    return 0


if __name__ == "__main__":
    sys.exit(main())
