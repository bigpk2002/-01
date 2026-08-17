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
FUND_PATH = os.path.join(HERE, "docs", "fundamentals.json")

EMAS = [5, 10, 20, 50, 100, 200]
PERIODS = ["1d", "1w", "1m", "3m", "ytd", "1y"]
MIN_BARS = max(EMAS) + 20
SPARK_BARS = 60

BATCH_SIZE = 40
SLEEP_BETWEEN = 1.5

# ข้อมูลพื้นฐานต้องยิงทีละตัว จึงจำกัดจำนวนต่อรอบไม่ให้โดน Yahoo บล็อก
# ข้อมูลพวกนี้เปลี่ยนไตรมาสละครั้ง ไม่ต้องดึงใหม่ทุกวัน
FUND_PER_RUN = 180        # ดึงใหม่สูงสุดกี่ตัวต่อการรันหนึ่งครั้ง
FUND_STALE_DAYS = 7       # ข้อมูลเก่ากว่ากี่วันถึงดึงใหม่
FUND_SLEEP = 0.45         # พักระหว่างตัว (วินาที)
SPLIT_GUARD = 0.35        # ราคาต่างจากตอนดึงเกินกี่เท่า ถือว่าข้อมูลใช้ไม่ได้แล้ว
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

# ไฟล์รายชื่อ Nasdaq 100 ใช้ชื่ออุตสาหกรรมย่อยคนละระบบกับ GICS
# (เช่น "Computer Software" แทนที่จะเป็น "Information Technology")
# จึงต้องจับคู่ด้วยคำสำคัญ เพื่อให้หมวดธุรกิจบนเว็บเป็นชุดเดียวกันทั้งหมด
NASDAQ_TO_GICS = [
    (("software", "edp services", "computer", "semiconductor", "electronic",
      "data processing", "technology services", "prepackaged"), "เทคโนโลยีสารสนเทศ"),
    (("biotech", "pharmaceutic", "medical", "health", "biological", "hospital",
      "diagnostic", "surgical"), "การแพทย์และสุขภาพ"),
    (("bank", "finance", "insurance", "investment", "credit", "securities",
      "savings"), "การเงินและธนาคาร"),
    (("retail", "catalog", "restaurant", "apparel", "auto", "hotel", "leisure",
      "amusement", "recreation", "consumer service", "specialty distribution"),
     "สินค้าฟุ่มเฟือย"),
    (("food", "beverage", "drink", "beer", "tobacco", "grocery", "household",
      "packaged"), "สินค้าจำเป็น"),
    (("telecom", "broadcast", "media", "publishing", "advertis", "entertainment",
      "cable", "motion picture"), "สื่อสารและบันเทิง"),
    (("machinery", "industrial", "military", "aerospace", "defense", "transport",
      "engineering", "construction", "trucking", "airline", "government, technical"),
     "อุตสาหกรรม"),
    (("oil", "gas", "petroleum", "energy", "coal", "drilling"), "พลังงาน"),
    (("utilit", "electric power", "water supply", "natural gas distribution"),
     "สาธารณูปโภค"),
    (("real estate", "reit", "property"), "อสังหาริมทรัพย์"),
    (("chemical", "metal", "mining", "steel", "paper", "forest", "container",
      "packaging", "cement"), "วัตถุดิบและเคมีภัณฑ์"),
]


def to_thai_sector(raw: str) -> str:
    """แปลงชื่อหมวดเป็นภาษาไทย รองรับทั้งชื่อ GICS มาตรฐานและชื่อแบบ NASDAQ"""
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw in SECTOR_TH:
        return SECTOR_TH[raw]
    low = raw.lower()
    for keys, th in NASDAQ_TO_GICS:
        if any(k in low for k in keys):
            return th
    return "อื่น ๆ"


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
                        "g": to_thai_sector(sec)})
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
            # อยู่ทั้งสองดัชนี — คงหมวดจาก S&P 500 ไว้ เพราะเป็น GICS มาตรฐาน
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


# ────────────────────── ข้อมูลพื้นฐานบริษัท ──────────────────────
#
# ต่างจากราคาตรงที่ต้องยิงทีละตัว (Yahoo ไม่มี endpoint แบบขอทีเดียวหลายตัว)
# 517 คำขอรวดเดียวเสี่ยงโดนบล็อก แต่ข้อมูลพวกนี้เปลี่ยนไตรมาสละครั้ง
# จึงใช้วิธี "ทยอยดึงแล้วเก็บสะสม" — แต่ละรอบดึงเฉพาะตัวที่ยังไม่มี
# หรือเก่ากว่า 7 วัน สูงสุด 180 ตัว ผ่านไปสองสามวันก็ครบเอง
# ถ้าดึงไม่ได้ ข้อมูลเดิมยังอยู่ ไม่หาย

FUND_FIELDS = {
    "mc":   "marketCap",              # มูลค่าบริษัท
    "pe":   "trailingPE",             # P/E ย้อนหลัง 12 เดือน
    "fpe":  "forwardPE",              # P/E คาดการณ์
    "pb":   "priceToBook",            # ราคาต่อมูลค่าทางบัญชี
    "ps":   "priceToSalesTrailing12Months",
    "peg":  "pegRatio",               # P/E เทียบการเติบโต
    "roe":  "returnOnEquity",
    "de":   "debtToEquity",
    "pm":   "profitMargins",
    "rg":   "revenueGrowth",
    "eg":   "earningsGrowth",
    "dy":   "dividendYield",
    "eps":  "trailingEps",
    "sh":   "sharesOutstanding",      # จำนวนหุ้น ใช้คำนวณมูลค่าบริษัทจากราคาล่าสุด
    "px0":  "currentPrice",           # ราคา ณ ตอนที่ดึง ใช้ปรับอัตราส่วนให้ตรงกับราคาปัจจุบัน
    "beta": "beta",
    "hi":   "fiftyTwoWeekHigh",
    "lo":   "fiftyTwoWeekLow",
    "tgt":  "targetMeanPrice",        # ราคาเป้าหมายเฉลี่ยของนักวิเคราะห์
    "na":   "numberOfAnalystOpinions",
    "rec":  "recommendationKey",
    "emp":  "fullTimeEmployees",
    "ind":  "industry",
}


def load_fundamentals() -> dict:
    if not os.path.exists(FUND_PATH):
        return {}
    try:
        with open(FUND_PATH, encoding="utf-8") as f:
            return json.load(f).get("rows", {})
    except Exception as e:
        print(f"  ! อ่านไฟล์ข้อมูลพื้นฐานเดิมไม่ได้ ({e}) เริ่มเก็บใหม่")
        return {}


def _clean(v):
    """ตัดค่าที่ใช้ไม่ได้ออก (None, NaN, ค่าติดลบที่ไม่มีความหมาย)"""
    if v is None:
        return None
    if isinstance(v, str):
        return v.strip() or None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f):
        return None
    return round(f, 4)


def sanitize(row: dict) -> dict:
    """แก้หน่วยและตัดค่าที่เป็นไปไม่ได้ทิ้ง

    เหตุผลที่ต้องมี:
      - Yahoo เปลี่ยนหน่วยของ dividendYield ไปมา บางช่วงส่งมาเป็นเศษส่วน (0.0066)
        บางช่วงส่งเป็นเปอร์เซ็นต์แล้ว (0.66) ถ้าคูณ 100 ซ้ำจะกลายเป็น 66%
      - บางครั้งส่งค่าประหลาดมา เช่น P/E ติดลบหรือหลักหมื่น ซึ่งใช้ไม่ได้
    """
    r = dict(row)

    # ปันผล: ถ้าค่ามากกว่า 0.25 แปลว่าเป็นหน่วยเปอร์เซ็นต์อยู่แล้ว
    # (ไม่มีหุ้นไหนจ่ายปันผล 25% ต่อปีในรูปเศษส่วน)
    dy = r.get("dy")
    if dy is not None:
        if dy > 0.25:
            dy = dy / 100.0
        r["dy"] = dy if 0 <= dy < 0.5 else None

    # อัตราส่วนราคาต้องเป็นบวกและอยู่ในช่วงที่เป็นไปได้
    for k, hi in (("pe", 3000), ("fpe", 3000), ("pb", 500), ("ps", 500)):
        v = r.get(k)
        if v is not None and not (0 < v < hi):
            r[k] = None

    # อัตราส่วนที่เป็นเศษส่วน ไม่ควรเกิน ±10 เท่า
    for k in ("roe", "pm", "rg", "eg"):
        v = r.get(k)
        if v is not None and abs(v) > 10:
            r[k] = None

    for k in ("mc", "sh", "px0", "hi", "lo", "tgt"):
        v = r.get(k)
        if v is not None and v <= 0:
            r[k] = None

    return {k: v for k, v in r.items() if v is not None}


def fetch_fundamentals(symbols: list[str], existing: dict,
                       limit: int = FUND_PER_RUN, demo: bool = False,
                       prices: dict | None = None) -> dict:
    today = datetime.now().date()
    prices = prices or {}
    todo, urgent = [], []
    for s in symbols:
        old = existing.get(s)
        if not old or not old.get("ts"):
            todo.append(s)
            continue

        # ราคาห่างจากตอนดึงมากผิดปกติ = ข้อมูลใช้ไม่ได้แล้ว ต้องดึงใหม่ก่อนใคร
        px0, pnow = old.get("px0"), prices.get(s)
        if px0 and pnow and abs(pnow / px0 - 1) > SPLIT_GUARD:
            urgent.append(s)
            continue

        try:
            age = (today - datetime.fromisoformat(old["ts"]).date()).days
        except ValueError:
            age = 999
        if age >= FUND_STALE_DAYS:
            todo.append(s)

    if urgent:
        print(f"  ต้องดึงใหม่ด่วน {len(urgent)} ตัว "
              f"(ราคาต่างจากตอนเก็บมาก อาจแตกพาร์)")
    todo = urgent + todo

    fresh = len(symbols) - len(todo)
    if not todo:
        print(f"  ข้อมูลพื้นฐานเป็นปัจจุบันครบทั้ง {fresh} ตัว ไม่ต้องดึงเพิ่ม")
        return existing

    # โหมดจำลองไม่ได้ยิงเซิร์ฟเวอร์จริง จึงไม่ต้องจำกัดจำนวน สร้างให้ครบทีเดียว
    if not demo:
        remaining = max(0, len(todo) - limit)
        todo = todo[:limit]
        print(f"  มีอยู่แล้ว {fresh} ตัว · รอบนี้ดึง {len(todo)} ตัว"
              + (f" · เหลืออีก {remaining} ตัวจะทยอยดึงในรอบถัดไป" if remaining else ""))
    else:
        print(f"  สร้างข้อมูลจำลอง {len(todo)} ตัว")

    if demo:
        rng = np.random.default_rng(7)
        for s in todo:
            px = prices.get(s, 100.0)
            lo = px * rng.uniform(0.55, 0.92)      # จุดต่ำสุดต้องต่ำกว่าราคาปัจจุบัน
            hi = px * rng.uniform(1.03, 1.55)      # จุดสูงสุดต้องสูงกว่า
            eps_v = px / rng.uniform(12, 60)
            sh_v = rng.uniform(2e8, 1.6e10)
            existing[s] = {
                "mc": float(sh_v * px),
                "pe": float(px / eps_v),          # ให้สอดคล้องกันเหมือนข้อมูลจริง
                "fpe": float(rng.uniform(7, 50)), "pb": float(rng.uniform(0.8, 22)),
                "ps": float(rng.uniform(0.5, 18)), "roe": float(rng.uniform(-.1, .6)),
                "de": float(rng.uniform(5, 220)), "pm": float(rng.uniform(-.05, .45)),
                "rg": float(rng.uniform(-.15, .6)), "eg": float(rng.uniform(-.3, .9)),
                "dy": float(rng.uniform(0, .05)),
                "eps": float(eps_v),
                "sh": float(sh_v),
                "px0": float(px * rng.uniform(0.95, 1.05)),
                "beta": float(rng.uniform(.4, 2.2)),
                "hi": float(hi), "lo": float(lo),
                "tgt": float(px * rng.uniform(0.85, 1.35)), "na": int(rng.integers(3, 45)),
                "rec": str(rng.choice(["buy", "hold", "strong_buy", "underperform"])),
                "emp": int(rng.integers(500, 200000)), "ind": "ตัวอย่าง",
                "ts": today.isoformat(),
            }
        return existing

    try:
        import yfinance as yf
    except ImportError:
        print("  ! ไม่มี yfinance ข้ามการดึงข้อมูลพื้นฐาน")
        return existing

    ok = errs = 0
    for i, sym in enumerate(todo, 1):
        if i % 40 == 0:
            print(f"    {i}/{len(todo)}")
        try:
            info = yf.Ticker(sym).get_info()
            if not isinstance(info, dict) or not info:
                errs += 1
                continue
            row = {}
            for key, src in FUND_FIELDS.items():
                v = _clean(info.get(src))
                if v is not None:
                    row[key] = v

            row = sanitize(row)

            # ต้องได้ข้อมูลแกนหลักมาอย่างน้อยหนึ่งอย่าง ถึงจะถือว่าดึงสำเร็จ
            # ถ้าได้มาแค่ชิ้นสองชิ้น แปลว่า Yahoo ตอบไม่ครบ (มักเกิดตอนโดนจำกัดการเรียก)
            # กรณีนั้นห้ามบันทึกทับ ไม่งั้นข้อมูลดีที่มีอยู่จะหายและไม่ถูกดึงใหม่อีก 7 วัน
            if row.get("mc") or row.get("px0"):
                old_row = existing.get(sym) or {}
                merged = {k: v for k, v in old_row.items() if k != "ts"}
                merged.update(row)          # ค่าใหม่ทับค่าเก่า ส่วนที่ขาดใช้ของเดิมต่อ
                merged["ts"] = today.isoformat()
                existing[sym] = merged
                ok += 1
            else:
                errs += 1
        except Exception:
            errs += 1
            # โดนจำกัดการเรียก หยุดรอบนี้ไว้ก่อน ข้อมูลที่ได้มาแล้วยังอยู่
            if errs >= 25 and ok == 0:
                print("    ! ดึงไม่สำเร็จติดกันหลายตัว หยุดรอบนี้ไว้ก่อน")
                break
        time.sleep(FUND_SLEEP + random.uniform(0, 0.25))

    print(f"  ดึงสำเร็จ {ok} ตัว · ไม่สำเร็จ {errs} ตัว")
    return existing


def save_fundamentals(rows: dict) -> None:
    os.makedirs(os.path.dirname(FUND_PATH), exist_ok=True)
    with open(FUND_PATH, "w", encoding="utf-8") as f:
        json.dump({"updated": datetime.now().isoformat(timespec="seconds"),
                   "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))


def refresh_ratios(f: dict, price: float) -> dict:
    """ปรับอัตราส่วนราคาให้ตรงกับราคาปิดล่าสุดที่เว็บแสดง

    ปัญหาที่แก้: ข้อมูลพื้นฐานเก็บไว้ใช้ได้ 7 วัน แต่ราคาอัปเดตทุกวัน
    ค่า P/E ที่ Yahoo ส่งมาคิดจากราคา ณ วันที่ดึง ถ้าราคาขยับไป 8%
    ตัวเลข P/E ที่แสดงคู่กับราคาวันนี้จะไม่ตรงกันทันที

    วิธีแก้: คำนวณใหม่จากราคาปัจจุบัน
      P/E  = ราคาปัจจุบัน ÷ กำไรต่อหุ้น   (กำไรต่อหุ้นเปลี่ยนแค่ไตรมาสละครั้ง)
      P/BV, P/S = ค่าเดิม × (ราคาปัจจุบัน ÷ ราคาตอนดึง)
      มูลค่าบริษัท = จำนวนหุ้น × ราคาปัจจุบัน
    ทำให้ทุกตัวเลขบนหน้าจอสอดคล้องกันเสมอ ไม่ว่าข้อมูลจะเก็บไว้กี่วัน
    """
    out = {k: v for k, v in f.items() if k != "ts"}
    out["fts"] = f.get("ts")           # วันที่ดึงข้อมูลพื้นฐาน แสดงให้ผู้ใช้เห็น

    px0 = f.get("px0")
    ratio = (price / px0) if (px0 and px0 > 0) else 1.0

    # ราคาต่างจากตอนดึงเกิน 35% มักแปลว่าหุ้นแตกพาร์ หรือข้อมูลเก่าเกินไป
    # กรณีนี้ห้ามเอาอัตราส่วนเก่ามาคูณ เพราะกำไรต่อหุ้นก็เปลี่ยนไปด้วย
    # ให้ซ่อนอัตราส่วนราคาไว้ก่อน แล้วรอดึงใหม่รอบหน้า (ตัวเลขกิจการอื่นยังใช้ได้)
    if px0 and abs(ratio - 1) > SPLIT_GUARD:
        keep = ("roe", "de", "pm", "rg", "eg", "dy", "beta", "emp", "ind",
                "rec", "na", "hi", "lo", "tgt")
        out = {k: v for k, v in f.items() if k in keep}
        out["fts"] = f.get("ts")
        out["adj"] = 0
        out["recheck"] = 1
        return out

    # คำนวณใหม่เสมอ ไม่ว่าราคาจะขยับหรือไม่
    # เพื่อรับประกันว่า P/E ที่แสดง = ราคาที่แสดง ÷ กำไรต่อหุ้นที่แสดง เสมอ
    # ผู้ใช้กดเครื่องคิดเลขตามได้ตรงทุกครั้ง
    eps = f.get("eps")
    if eps and eps > 0:
        out["pe"] = round(price / eps, 4)
    elif f.get("pe"):
        out["pe"] = round(f["pe"] * ratio, 4)

    for k in ("fpe", "pb", "ps"):
        if f.get(k):
            out[k] = round(f[k] * ratio, 4)

    sh = f.get("sh")
    if sh and sh > 0:
        out["mc"] = round(sh * price, 0)          # จำนวนหุ้น x ราคา = มูลค่าจริง
    elif f.get("mc"):
        out["mc"] = round(f["mc"] * ratio, 0)

    # ตัดค่าที่คำนวณแล้วเพี้ยนออก (เช่นข้อมูลต้นทางผิดปกติ)
    for k, hi in (("pe", 3000), ("fpe", 3000), ("pb", 500), ("ps", 500)):
        if out.get(k) is not None and not (0 < out[k] < hi):
            out.pop(k, None)

    # ราคาต่างจากตอนดึงเกิน 0.5% ถือว่ามีการปรับที่ผู้ใช้ควรรู้
    out["adj"] = 1 if abs(ratio - 1) > 0.005 else 0
    out.pop("px0", None)
    out.pop("sh", None)
    return out


def sector_medians(rows: list[dict]) -> dict:
    """ค่ากลางของแต่ละหมวดธุรกิจ ใช้เทียบว่าหุ้นตัวนี้แพงหรือถูกกว่าเพื่อนในหมวด"""
    from statistics import median
    buckets: dict[str, dict[str, list]] = {}
    for r in rows:
        f = r.get("f")
        if not f or not r.get("g"):
            continue
        b = buckets.setdefault(r["g"], {"pe": [], "pb": [], "ps": []})
        for k in ("pe", "pb", "ps"):
            v = f.get(k)
            if v is not None and 0 < v < 500:
                b[k].append(v)
    out = {}
    for g, b in buckets.items():
        out[g] = {k: round(median(v), 2) for k, v in b.items() if len(v) >= 4}
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
    ap.add_argument("--skip-fundamentals", action="store_true",
                    help="ข้ามการดึงข้อมูลพื้นฐาน (ใช้เมื่ออยากได้ราคาเร็ว ๆ)")
    ap.add_argument("--fund-limit", type=int, default=FUND_PER_RUN,
                    help="ดึงข้อมูลพื้นฐานสูงสุดกี่ตัวต่อรอบ")
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

    # ── ข้อมูลพื้นฐานบริษัท ──
    if a.skip_fundamentals:
        print("ข้ามการดึงข้อมูลพื้นฐานตามที่สั่ง")
        fund = load_fundamentals()
    else:
        print("ข้อมูลพื้นฐานบริษัท")
        fund = load_fundamentals()
        try:
            fund = fetch_fundamentals([r["s"] for r in rows], fund,
                                      limit=a.fund_limit, demo=a.demo,
                                      prices={r["s"]: r["p"] for r in rows})
            save_fundamentals(fund)
        except Exception as e:
            print(f"  ! ดึงข้อมูลพื้นฐานไม่สำเร็จ: {e} (ใช้ข้อมูลเดิมต่อ)")
    print()

    stale_adj = 0
    for r in rows:
        f = fund.get(r["s"])
        if f:
            r["f"] = refresh_ratios(f, r["p"])
            if r["f"].get("adj"):
                stale_adj += 1
    if stale_adj:
        print(f"  ปรับอัตราส่วนให้ตรงกับราคาล่าสุด {stale_adj} ตัว")

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
            "fund_count": sum(1 for r in rows if "f" in r),
            "sector_med": sector_medians(rows),
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
    print(f"  มีข้อมูลพื้นฐาน {payload['meta']['fund_count']} ตัว "
          f"· ค่ากลางรายหมวด {len(payload['meta']['sector_med'])} หมวด")
    print(f"  ข้อมูลปิดตลาดวันที่ {payload['meta']['date']}")

    # ตรวจความสมเหตุสมผลของข้อมูลพื้นฐาน แล้วรายงานในล็อก
    checks = []
    withf = [r for r in rows if "f" in r]
    if withf:
        mism = [r["s"] for r in withf
                if r["f"].get("eps", 0) > 0 and r["f"].get("pe")
                and abs(r["f"]["pe"] - r["p"] / r["f"]["eps"]) > 0.05]
        if mism:
            checks.append(f"P/E ไม่ตรงกับ ราคา/EPS {len(mism)} ตัว: {', '.join(mism[:6])}")
        biddy = [r["s"] for r in withf if (r["f"].get("dy") or 0) > 0.25]
        if biddy:
            checks.append(f"ปันผลสูงผิดปกติ {len(biddy)} ตัว: {', '.join(biddy[:6])}")
        bigpe = [r["s"] for r in withf if (r["f"].get("pe") or 0) > 1000]
        if bigpe:
            checks.append(f"P/E สูงผิดปกติ {len(bigpe)} ตัว: {', '.join(bigpe[:6])}")
        oldf = [r["s"] for r in withf
                if r["f"].get("fts") and
                (datetime.now().date() - datetime.fromisoformat(r["f"]["fts"]).date()).days > 10]
        if oldf:
            checks.append(f"ข้อมูลพื้นฐานเก่ากว่า 10 วัน {len(oldf)} ตัว")
    if checks:
        print("\n  ข้อควรตรวจสอบ:")
        for c in checks:
            print(f"    ! {c}")
    else:
        print("  ตรวจความสมเหตุสมผลของข้อมูลพื้นฐาน: ผ่าน")

    for tol in (1.0, 1.5, 3.0):
        n = sum(1 for r in rows if "d" in r and min(abs(x) for x in r["d"]) <= tol)
        up = sum(1 for r in rows if "d" in r and r.get("t") == "up"
                 and min(abs(x) for x in r["d"]) <= tol)
        print(f"  ระยะ {tol}% : ใกล้เส้น {n} ตัว (เป็นขาขึ้น {up} ตัว)")

    print(f"\nใช้เวลา {(time.time() - t0) / 60:.1f} นาที")
    return 0


if __name__ == "__main__":
    sys.exit(main())
