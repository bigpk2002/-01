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
import binascii
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
WEEKLY_PATH = os.path.join(HERE, "docs", "weekly.json")
BACKTEST_PATH = os.path.join(HERE, "docs", "backtest.json")
PREV_PATH = os.path.join(HERE, "docs", "prev.json")

EMAS = [5, 10, 20, 50, 100, 200]
PERIODS = ["1d", "1w", "1m", "3m", "ytd", "1y"]
MIN_BARS = max(EMAS) + 20
SPARK_BARS = 60

BATCH_SIZE = 40
SLEEP_BETWEEN = 1.5

# ข้อมูลพื้นฐานต้องยิงทีละตัว จึงจำกัดจำนวนต่อรอบไม่ให้โดน Yahoo บล็อก
# ข้อมูลพวกนี้เปลี่ยนไตรมาสละครั้ง ไม่ต้องดึงใหม่ทุกวัน
FUND_PER_RUN = 300        # ดึงใหม่สูงสุดกี่ตัวต่อการรันหนึ่งครั้ง
FUND_STALE_DAYS = 3       # ข้อมูลเก่ากว่ากี่วันถึงดึงใหม่ (วนครบทุกตัวใน ~2 วัน)
FUND_SLEEP = 0.45         # พักระหว่างตัว (วินาที)
QUARTER_MAX_AGE = 100     # ไตรมาสล่าสุดเก่ากว่ากี่วัน ถือว่าพลาดการรายงานไปรอบหนึ่ง
                          # (หนึ่งไตรมาสราว 90 วัน เผื่อเวลารายงานอีก 10 วัน)
NEAR_TOL = 1.5            # ระยะที่ถือว่า "ชนเส้น" ตอนเก็บสถานะไว้เทียบวันถัดไป
SPLIT_GUARD = 0.35        # ราคาต่างจากตอนดึงเกินกี่เท่า ถือว่าข้อมูลใช้ไม่ได้แล้ว

# เส้น EMA รายสัปดาห์ — แท่งหนึ่งแท่งคือหนึ่งสัปดาห์
# ข้อมูลชุดนี้เปลี่ยนสัปดาห์ละครั้ง (ตอนตลาดปิดวันศุกร์) จึงไม่ต้องคำนวณใหม่ทุกวัน
WEEKLY_STALE_DAYS = 6     # ข้อมูลรายสัปดาห์เก่ากว่ากี่วันถึงดึงใหม่
WEEKLY_PERIOD = "10y"     # ต้องยาวพอสำหรับ EMA200 รายสัปดาห์ (200 สัปดาห์ = ~4 ปี)
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


def stable_seed(text: str) -> int:
    """เลขสุ่มประจำตัวที่ได้ค่าเดิมเสมอ

    ห้ามใช้ hash() ของ Python เพราะค่าจะเปลี่ยนทุกครั้งที่เปิดโปรแกรมใหม่
    (Python สุ่มค่าเริ่มต้นของ hash เพื่อความปลอดภัย) ทำให้ข้อมูลจำลอง
    ไม่คงที่และตรวจสอบย้อนหลังไม่ได้
    """
    return binascii.crc32(text.encode("utf-8")) % 100_000


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


def load_extra(universe: dict) -> list[str]:
    """หุ้นที่ผู้ใช้เพิ่มเองใน themes.yml ใต้หัวข้อ extra

    ใช้กับหุ้นที่ยังไม่อยู่ใน S&P 500 หรือ Nasdaq 100 เช่นหุ้นที่เพิ่งเข้าตลาด
    ชื่อบริษัทกับหมวดธุรกิจจะเติมให้เองตอนดึงข้อมูลพื้นฐาน
    """
    path = os.path.join(HERE, "themes.yml")
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    added = []
    for x in (raw.get("extra") or []):
        v = YAML_BOOL_BACK.get(str(x), str(x)) if isinstance(x, bool) else str(x)
        v = norm(v)
        if not v or v in universe:
            continue
        universe[v] = {"t": v, "n": "", "g": "", "sp": 0, "ndx": 0, "extra": 1}
        added.append(v)

    if added:
        print(f"เพิ่มหุ้นที่ระบุเองใน themes.yml {len(added)} ตัว: {', '.join(added)}")
        print()
    return added


def load_themes(universe: dict) -> tuple[list[dict], list[str]]:
    path = os.path.join(HERE, "themes.yml")
    with open(path, encoding="utf-8") as f:
        cfg = (yaml.safe_load(f) or {}).get("themes") or []
    if not cfg:
        sys.exit("ไฟล์ themes.yml ว่างเปล่า")

    themes, warnings, seen_keys = [], [], set()
    for i, t in enumerate(cfg, 1):
        key, name = str(t.get("key", "")).strip(), str(t.get("name", "")).strip()
        if not key or not name:
            sys.exit(f"ธีมลำดับที่ {i} ขาด key หรือ name")
        if key in seen_keys:
            sys.exit(f"ชื่อคีย์ธีมซ้ำกัน: {key} — แก้ไฟล์ themes.yml ให้ไม่ซ้ำก่อน")
        seen_keys.add(key)

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


def fetch_prices(symbols: list[str], period: str = "3y",
                 interval: str = "1d") -> dict[str, pd.DataFrame]:
    import yfinance as yf

    out, failed = {}, []
    for i in range(0, len(symbols), BATCH_SIZE):
        chunk = symbols[i:i + BATCH_SIZE]
        print(f"  ดาวน์โหลด {i + 1}-{i + len(chunk)} / {len(symbols)}")
        raw = None
        for attempt in range(1, MAX_RETRY + 1):
            try:
                raw = yf.download(tickers=chunk, period=period, interval=interval,
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
        rng = np.random.default_rng(stable_seed(s))
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
    "rg":   "revenueGrowth",              # รายได้เติบโต เทียบไตรมาสเดียวกันปีก่อน
    "eg":   "earningsGrowth",             # กำไรเติบโต เทียบปีก่อน
    "eqg":  "earningsQuarterlyGrowth",    # กำไรเติบโตรายไตรมาส
    "om":   "operatingMargins",           # อัตรากำไรจากการดำเนินงาน
    "rev":  "totalRevenue",               # รายได้รวม 12 เดือนล่าสุด
    "fcf":  "freeCashflow",               # กระแสเงินสดอิสระ
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
    "mrq":  "mostRecentQuarter",      # ไตรมาสล่าสุดที่รายงานงบ (เป็น unix timestamp)
    "ed":   "earningsTimestamp",      # วันประกาศงบครั้งถัดไป (unix timestamp)
    "nm":   "shortName",              # ใช้เติมชื่อบริษัทให้หุ้นที่ผู้ใช้เพิ่มเอง
    "sec":  "sector",                 # ใช้เติมหมวดธุรกิจให้หุ้นที่ผู้ใช้เพิ่มเอง
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

    # แปลง unix timestamp เป็นวันที่ (Yahoo ส่งมาเป็นวินาที)
    for k in ("mrq", "ed"):
        v = r.get(k)
        if v is None:
            continue
        try:
            ts = float(v)
            # ช่วงที่เป็นไปได้: ปี 2000 ถึง 2035
            if 946_684_800 < ts < 2_082_758_400:
                r[k] = datetime.fromtimestamp(ts).date().isoformat()
            else:
                r[k] = None
        except (TypeError, ValueError, OSError, OverflowError):
            r[k] = None

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
    for k in ("roe", "pm", "om", "rg", "eg", "eqg"):
        v = r.get(k)
        if v is not None and abs(v) > 10:
            r[k] = None

    for k in ("mc", "sh", "px0", "hi", "lo", "tgt", "rev"):
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
    fake = reported = stale_q = 0
    for s in symbols:
        old = existing.get(s)
        if not old or not old.get("ts"):
            todo.append(s)
            continue

        # ข้อมูลจำลองที่ติดมากับไฟล์ตัวอย่าง ต้องดึงของจริงมาทับก่อนเพื่อน
        if not demo and old.get("dm"):
            urgent.append(s)
            fake += 1
            continue

        # ไม่มี px0 = บันทึกไว้ด้วยโค้ดรุ่นเก่า ตรวจความถูกต้องไม่ได้ ให้ดึงใหม่
        px0, pnow = old.get("px0"), prices.get(s)
        if not demo and not px0:
            urgent.append(s)
            continue

        # ราคาห่างจากตอนดึงมากผิดปกติ = ข้อมูลใช้ไม่ได้แล้ว ต้องดึงใหม่ก่อนใคร
        if px0 and pnow and abs(pnow / px0 - 1) > SPLIT_GUARD:
            urgent.append(s)
            continue

        # ราคาหลุดออกนอกช่วง 52 สัปดาห์ที่เก็บไว้ = ข้อมูลเก่าเกินไปเช่นกัน
        h52, l52 = old.get("hi"), old.get("lo")
        if pnow and h52 and l52 and not (l52 * 0.95 <= pnow <= h52 * 1.05):
            urgent.append(s)
            continue

        # ── วันประกาศงบที่เก็บไว้ผ่านไปแล้ว = บริษัทรายงานงบใหม่ไปแล้ว ──
        # เป็นสัญญาณที่ตรงที่สุดว่าข้อมูลงบชุดที่มีอยู่ล้าสมัย
        # ไม่ควรรอให้ครบรอบตามอายุ เพราะตัวเลขกำไร รายได้ และ P/E เปลี่ยนไปหมดแล้ว
        ed = old.get("ed")
        if ed:
            try:
                if datetime.fromisoformat(str(ed)).date() < today:
                    urgent.append(s)
                    reported += 1
                    continue
            except ValueError:
                pass

        # ไตรมาสล่าสุดเก่ากว่า 1 ไตรมาสเต็ม = น่าจะพลาดการรายงานไปรอบหนึ่ง
        mrq = old.get("mrq")
        if mrq:
            try:
                if (today - datetime.fromisoformat(str(mrq)).date()).days > QUARTER_MAX_AGE:
                    urgent.append(s)
                    stale_q += 1
                    continue
            except ValueError:
                pass

        try:
            age = (today - datetime.fromisoformat(old["ts"]).date()).days
        except ValueError:
            age = 999
        if age >= FUND_STALE_DAYS:
            todo.append(s)

    if fake:
        print(f"  พบข้อมูลจำลองค้างอยู่ {fake} ตัว จะดึงของจริงมาทับให้")
    if reported:
        print(f"  ประกาศงบใหม่ไปแล้ว {reported} ตัว จะดึงงบชุดใหม่มาแทน")
    if stale_q:
        print(f"  ไตรมาสล่าสุดเก่ากว่า {QUARTER_MAX_AGE} วัน {stale_q} ตัว")
    if urgent:
        print(f"  ต้องดึงใหม่ด่วนรวม {len(urgent)} ตัว")
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
                "eqg": float(rng.uniform(-.4, 1.1)),
                "om": float(rng.uniform(-.05, .45)),
                "rev": float(rng.uniform(5e8, 4e11)),
                "fcf": float(rng.uniform(-2e9, 8e10)),
                "mrq": (today - timedelta(days=int(rng.integers(20, 110)))).isoformat(),
                "ed": (today + timedelta(days=int(rng.integers(3, 90)))).isoformat(),
                "dy": float(rng.uniform(0, .05)),
                "eps": float(eps_v),
                "sh": float(sh_v),
                "px0": float(px * rng.uniform(0.95, 1.05)),
                "beta": float(rng.uniform(.4, 2.2)),
                "hi": float(hi), "lo": float(lo),
                "tgt": float(px * rng.uniform(0.85, 1.35)), "na": int(rng.integers(3, 45)),
                "rec": str(rng.choice(["buy", "hold", "strong_buy", "underperform"])),
                "emp": int(rng.integers(500, 200000)), "ind": "ตัวอย่าง",
                "nm": s + " Inc.",
                "sec": str(rng.choice(list(SECTOR_TH))),
                "dm": 1,                      # ธงบอกว่าเป็นข้อมูลจำลอง
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
                merged = {k: v for k, v in old_row.items()
                          if k not in ("ts", "dm")}     # ล้างธงจำลองทิ้ง
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
        # เก็บเฉพาะตัวเลขที่ไม่ผูกกับราคา ส่วนที่อิงราคาทิ้งหมด
        # (ช่วง 52 สัปดาห์และราคาเป้าหมายก็อิงราคา จึงใช้ไม่ได้เช่นกัน)
        keep = ("roe", "de", "pm", "om", "rg", "eg", "eqg", "rev", "fcf",
                "dy", "beta", "emp", "ind", "rec", "na", "dm", "mrq", "ed")
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
    for k, cap in (("pe", 3000), ("fpe", 3000), ("pb", 500), ("ps", 500)):
        if out.get(k) is not None and not (0 < out[k] < cap):
            out.pop(k, None)

    # ราคาต้องอยู่ในช่วงสูงสุด/ต่ำสุด 52 สัปดาห์เสมอ ถ้าอยู่นอกช่วงแปลว่าข้อมูลเก่าเกินไป
    # (นี่เป็นสัญญาณที่ตรวจง่ายและชัดที่สุดว่าข้อมูลพื้นฐานใช้ไม่ได้แล้ว)
    hi52, lo52 = out.get("hi"), out.get("lo")
    if hi52 and lo52:
        if hi52 <= lo52 or price < lo52 * 0.95 or price > hi52 * 1.05:
            out.pop("hi", None)
            out.pop("lo", None)
            out["recheck"] = 1

    # ราคาเป้าหมายที่ห่างจากราคาปัจจุบันเกิน 3 เท่า ไม่สมเหตุสมผล
    tgt = out.get("tgt")
    if tgt and (tgt > price * 3 or tgt < price * 0.3):
        out.pop("tgt", None)
        out.pop("na", None)
        out.pop("rec", None)
        out["recheck"] = 1

    # ราคาต่างจากตอนดึงเกิน 0.5% ถือว่ามีการปรับที่ผู้ใช้ควรรู้
    out["adj"] = 1 if abs(ratio - 1) > 0.005 else 0

    # ติดธงเตือนถ้างบชุดนี้น่าจะล้าสมัยแล้ว
    # เพื่อให้หน้าเว็บบอกผู้ใช้ตรง ๆ แทนที่จะแสดงตัวเลขเก่าเงียบ ๆ
    today = datetime.now().date()
    for key, flag in (("ed", "edold"), ("mrq", "qold")):
        v = f.get(key)
        if not v:
            continue
        try:
            d0 = datetime.fromisoformat(str(v)).date()
        except ValueError:
            continue
        if key == "ed" and d0 < today:
            out["edold"] = (today - d0).days
        elif key == "mrq" and (today - d0).days > QUARTER_MAX_AGE:
            out["qold"] = (today - d0).days
    for k in ("px0", "sh", "nm", "sec"):
        out.pop(k, None)
    return out


def load_weekly() -> dict:
    if not os.path.exists(PREV_PATH):
        save_prev({"date": None, "rows": {}})
        print("สร้างไฟล์ prev.json ไว้ (ยังไม่มีสถานะวันก่อนหน้า)")

    if not os.path.exists(WEEKLY_PATH):
        return {}
    try:
        with open(WEEKLY_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"  ! อ่านไฟล์รายสัปดาห์เดิมไม่ได้ ({e}) เริ่มใหม่")
        return {}


def save_weekly(payload: dict) -> None:
    os.makedirs(os.path.dirname(WEEKLY_PATH), exist_ok=True)
    with open(WEEKLY_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))


def weekly_ema(close: pd.Series) -> dict | None:
    """คำนวณระยะห่างจากเส้น EMA บนกราฟรายสัปดาห์

    ต่างจากรายวันตรงที่หนึ่งแท่ง = หนึ่งสัปดาห์ เส้น EMA20 รายสัปดาห์
    จึงมองย้อนหลังราว 5 เดือน ส่วน EMA200 มองย้อนไปเกือบ 4 ปี
    นักลงทุนระยะยาวใช้ดูภาพใหญ่ว่าแนวโน้มหลักยังอยู่ทิศไหน

    เส้นไหนข้อมูลไม่พอจะคืนค่า None แทนที่จะคำนวณจากเท่าที่มี
    (หุ้นที่เพิ่งเข้าตลาดมักมี EMA5-20 แต่ไม่มี EMA200)
    """
    n = len(close)
    if n < 30:                       # น้อยกว่านี้ไม่มีความหมายแม้แต่เส้นสั้น
        return None

    price = float(close.iloc[-1])
    if not np.isfinite(price) or price <= 0:
        return None

    dists, levels = [], {}
    for p in EMAS:
        # ต้องมีแท่งมากพอให้ค่า EMA นิ่ง ไม่งั้นตัวเลขจะเพี้ยนตามค่าเริ่มต้น
        if n < p + 15:
            dists.append(None)
            continue
        lv = float(close.ewm(span=p, adjust=False).mean().iloc[-1])
        if not np.isfinite(lv) or lv <= 0:
            dists.append(None)
            continue
        levels[p] = lv
        dists.append(round((price - lv) / lv * 100, 2) + 0.0)

    if all(x is None for x in dists):
        return None

    out = {"d": dists, "n": n}

    e50, e200 = levels.get(50), levels.get(200)
    if e50 and e200:
        out["t"] = ("up" if (price > e200 and e50 > e200)
                    else "down" if (price < e200 and e50 < e200) else "flat")
        got = [levels[p] for p in EMAS if p in levels]
        out["a"] = int(len(got) == len(EMAS)
                       and all(got[i] > got[i + 1] for i in range(len(got) - 1)))
    return out


def build_weekly(symbols: list[str], period: str = WEEKLY_PERIOD,
                 demo: bool = False) -> dict:
    """ดึงราคารายสัปดาห์แล้วคำนวณ EMA — ทำสัปดาห์ละครั้งพอ"""
    print(f"เส้น EMA รายสัปดาห์ — ดึงราคา {len(symbols)} ตัว (ย้อนหลัง {period})")

    if demo:
        idx = pd.date_range(end=pd.Timestamp.today().normalize(), periods=520, freq="W-FRI")
        rows = {}
        for s in symbols:
            rng = np.random.default_rng(stable_seed(s + "w"))
            ret = rng.normal(0.002, 0.035, len(idx))
            ret += 0.02 * np.sin(np.linspace(0, rng.uniform(2, 6) * np.pi, len(idx)))
            close = pd.Series(30 * np.exp(np.cumsum(ret)) * rng.uniform(0.5, 15), index=idx)
            w = weekly_ema(close)
            if w:
                rows[s] = w
        date = str(idx[-1].date())
    else:
        data = fetch_prices(symbols, period=period, interval="1wk")
        rows, last = {}, None
        for s in symbols:
            df = data.get(s)
            if df is None or len(df) < 30:
                continue
            w = weekly_ema(df["adj_close"])
            if w:
                rows[s] = w
                if last is None or df.index[-1] > last:
                    last = df.index[-1]
        date = str(last.date()) if last is not None else "-"

    full = sum(1 for w in rows.values() if all(x is not None for x in w["d"]))
    print(f"  คำนวณได้ {len(rows)} ตัว (ครบทั้ง 6 เส้น {full} ตัว)")
    return {"updated": datetime.now().isoformat(timespec="seconds"),
            "date": date, "rows": rows}


def load_prev() -> dict:
    """สถานะของวันทำการก่อนหน้า ใช้เทียบว่ามีอะไรเปลี่ยนไปบ้าง

    เก็บเฉพาะสิ่งที่จำเป็นต่อการเทียบ ไม่ได้เก็บทุกอย่าง
    เพราะไฟล์จะใหญ่โดยไม่จำเป็น
    """
    if not os.path.exists(PREV_PATH):
        return {}
    try:
        with open(PREV_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"  ! อ่านไฟล์สถานะเดิมไม่ได้ ({e}) เริ่มเก็บใหม่")
        return {}


def snapshot(rows: list[dict], date: str) -> dict:
    """ย่อสถานะวันนี้ให้เหลือเท่าที่ต้องใช้เทียบพรุ่งนี้"""
    out = {}
    for r in rows:
        d = r.get("d")
        if not d:
            continue
        # ระยะห่างที่ใกล้ที่สุดจากเส้นใดเส้นหนึ่ง และเส้นที่ชนอยู่
        near = [EMAS[i] for i, x in enumerate(d) if abs(x) <= NEAR_TOL]
        out[r["s"]] = {
            "p": r["p"],
            "t": r.get("t"),
            "n": near,                       # เส้นที่อยู่ในระยะ ณ วันนั้น
            "a": r.get("a", 0),
        }
    return {"date": date, "rows": out}


def save_prev(snap: dict) -> None:
    os.makedirs(os.path.dirname(PREV_PATH), exist_ok=True)
    with open(PREV_PATH, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, separators=(",", ":"))


def sector_medians(rows: list[dict], demo: bool = False) -> dict:
    """ค่ากลางของแต่ละหมวดธุรกิจ ใช้เทียบว่าหุ้นตัวนี้แพงหรือถูกกว่าเพื่อนในหมวด"""
    from statistics import median
    buckets: dict[str, dict[str, list]] = {}
    for r in rows:
        f = r.get("f")
        # ข้อมูลจำลองที่ปนอยู่ในชุดข้อมูลจริง ต้องไม่นำมาคิดค่ากลาง
        # (ยกเว้นตอนรันโหมดทดลองทั้งชุด ซึ่งทุกตัวเป็นข้อมูลจำลองอยู่แล้ว)
        if not f or not r.get("g") or (f.get("dm") and not demo):
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
        rets[p] = round((price / float(prior.iloc[-1]) - 1) * 100, 2) + 0.0

    # เก็บว่าหุ้นตัวนี้มาจากดัชนีไหน เพื่อให้หน้าเว็บกรองและแสดงที่มาได้
    # ix: 1=S&P 500 · 2=Nasdaq 100 · 3=ทั้งสองดัชนี · 0=เพิ่มเองใน themes.yml
    ix = (1 if info.get("sp") else 0) + (2 if info.get("ndx") else 0)

    # ── สัญญาณ "เพิ่งเข้ากระแส" ──
    # วัดจากตัวเลขที่มีอยู่แล้ว ไม่ต้องพึ่งข่าว
    vol = df["volume"].fillna(0)
    extra_sig = {}

    # 1) วอลุ่มพุ่งผิดปกติ = วอลุ่มวันล่าสุดเทียบค่าเฉลี่ย 20 วันก่อนหน้า
    #    ใช้ 20 วันก่อนหน้า ไม่รวมวันล่าสุด ไม่งั้นวันที่พุ่งจะดันค่าเฉลี่ยขึ้นเอง
    if len(vol) >= 25:
        base = float(vol.iloc[-21:-1].mean())
        last = float(vol.iloc[-1])
        if base > 0 and last > 0:
            ratio = last / base
            if np.isfinite(ratio) and ratio > 0:
                extra_sig["vr"] = round(ratio, 2)      # กี่เท่าของปกติ

    # 2) หลุดกรอบราคา = ทำจุดสูงสุด/ต่ำสุดใหม่ในรอบ 3 เดือน (63 วันทำการ)
    #    เทียบกับ 63 วันก่อนหน้า ไม่รวมวันล่าสุด
    if len(close) >= 70:
        win = close.iloc[-64:-1]
        hi63, lo63 = float(win.max()), float(win.min())
        if hi63 > 0 and price > hi63:
            extra_sig["bo"] = 1                        # ทะลุขึ้น
        elif lo63 > 0 and price < lo63:
            extra_sig["bo"] = -1                       # หลุดลง

    row = {"ix": ix,
           **{k: info[k] for k in ("n", "g")},
           "s": info["t"], "p": round(price, 2),
           **({"x": 1} if info.get("extra") else {}),   # หุ้นนอกดัชนี
           "r": [rets[p] for p in PERIODS],
           **extra_sig,
           "h": spark(close)}

    # ── ระยะห่างจากเส้น EMA ──
    if len(df) >= MIN_BARS:
        ema = {p: close.ewm(span=p, adjust=False).mean() for p in EMAS}
        lv = {p: float(ema[p].iloc[-1]) for p in EMAS}
        if all(np.isfinite(v) and v > 0 for v in lv.values()):
            # บวก 0.0 เพื่อให้ค่าติดลบศูนย์ (-0.0) กลายเป็น 0.0
            # ไม่งั้นไฟล์ข้อมูลจะมี -0.0 ซึ่งสับสนเวลาตรวจสอบ
            row["d"] = [round((price - lv[p]) / lv[p] * 100, 2) + 0.0 for p in EMAS]
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
    ap.add_argument("--weekly", action="store_true",
                    help="บังคับคำนวณเส้นรายสัปดาห์ใหม่ (ปกติทำเองสัปดาห์ละครั้ง)")
    ap.add_argument("--skip-weekly", action="store_true",
                    help="ข้ามเส้นรายสัปดาห์ ใช้ของเดิมต่อ")
    a = ap.parse_args()

    t0 = time.time()
    universe = build_universe()
    extra = load_extra(universe)
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

    # หุ้นที่ผู้ใช้เพิ่มเองแต่ดึงไม่สำเร็จ ต้องบอกให้รู้ ไม่ปล่อยหายเงียบ
    got = {r["s"] for r in rows}
    lost = [t for t in extra if t not in got]
    if lost:
        print(f"หุ้นที่เพิ่มเองแต่ดึงข้อมูลไม่ได้ {len(lost)} ตัว: {', '.join(lost)}")
        print("  (อาจเปลี่ยนชื่อย่อ ถูกถอนจากตลาด หรือประวัติราคาสั้นเกินไป)")
        print("  แก้ได้โดยลบออกจากรายการ extra ใน themes.yml")
        print()

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

    # หุ้นที่เพิ่มเองไม่มีชื่อ/หมวดจากไฟล์ดัชนี เติมจากข้อมูลพื้นฐานที่ดึงมา
    filled, pending = 0, 0
    for r in rows:
        f = fund.get(r["s"]) or {}
        if not r.get("n"):
            if f.get("nm"):
                r["n"] = str(f["nm"])
                filled += 1
            else:
                # ยังไม่ถึงคิวดึงข้อมูลพื้นฐาน ใช้ชื่อย่อไปก่อน ดีกว่าปล่อยว่าง
                r["n"] = r["s"]
                pending += 1
        if not r.get("g") and f.get("sec"):
            r["g"] = to_thai_sector(str(f["sec"]))
    if filled:
        print(f"  เติมชื่อบริษัทให้หุ้นที่เพิ่มเอง {filled} ตัว")
    if pending:
        print(f"  ยังรอชื่อบริษัทอีก {pending} ตัว (จะเติมให้เมื่อดึงข้อมูลพื้นฐานถึงคิว)")

    # ── เส้น EMA รายสัปดาห์ ──
    # ข้อมูลชุดนี้เปลี่ยนแค่ตอนตลาดปิดวันศุกร์ จึงคำนวณสัปดาห์ละครั้งพอ
    wk = load_weekly()
    need_weekly = a.weekly or not wk.get("rows")
    if not need_weekly and wk.get("updated"):
        try:
            age = (datetime.now() - datetime.fromisoformat(wk["updated"])).days
            need_weekly = age >= WEEKLY_STALE_DAYS
        except ValueError:
            need_weekly = True
    # มีหุ้นใหม่เข้ามาก็ต้องคำนวณใหม่ ไม่งั้นตัวใหม่จะไม่มีเส้นรายสัปดาห์
    if not need_weekly and wk.get("rows"):
        missing = [r["s"] for r in rows if r["s"] not in wk["rows"]]
        if len(missing) > max(5, len(rows) * 0.02):
            need_weekly = True
            print(f"มีหุ้นใหม่ {len(missing)} ตัวที่ยังไม่มีเส้นรายสัปดาห์")

    if a.skip_weekly:
        print("ข้ามเส้นรายสัปดาห์ตามที่สั่ง ใช้ข้อมูลเดิมต่อ")
    elif need_weekly:
        try:
            wk = build_weekly([r["s"] for r in rows], demo=a.demo)
            save_weekly(wk)
        except Exception as e:
            print(f"  ! คำนวณเส้นรายสัปดาห์ไม่สำเร็จ: {e} (ใช้ข้อมูลเดิมต่อ)")
    else:
        d_old = wk.get("date", "-")
        print(f"เส้นรายสัปดาห์ยังใหม่อยู่ (ข้อมูลถึง {d_old}) ไม่ต้องคำนวณใหม่")
    print()

    wrows = wk.get("rows", {})
    for r in rows:
        w = wrows.get(r["s"])
        if w:
            r["w"] = w

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

    # ── เทียบกับสถานะวันทำการก่อนหน้า ──
    prev = load_prev()
    prev_rows = prev.get("rows", {})
    prev_date = prev.get("date")
    today_str = str(last_date.date()) if last_date is not None else "-"
    same_day = (prev_date == today_str)     # รันซ้ำวันเดิม ไม่ควรทับสถานะเดิม

    fresh_touch = 0
    if prev_rows and not same_day:
        for r in rows:
            d = r.get("d")
            if not d:
                continue
            now_near = [EMAS[i] for i, x in enumerate(d) if abs(x) <= NEAR_TOL]
            if not now_near:
                continue
            old_row = prev_rows.get(r["s"])
            if old_row is None:
                continue                    # หุ้นใหม่ ไม่นับว่า "เพิ่งมาถึง"
            was_near = set(old_row.get("n") or [])
            new_lines = [p for p in now_near if p not in was_near]
            if new_lines:
                # เพิ่งเข้าระยะเส้นเหล่านี้เป็นวันแรก
                r["nw"] = new_lines
                fresh_touch += 1
            # เทรนด์เพิ่งเปลี่ยนวันนี้
            if old_row.get("t") and r.get("t") and old_row["t"] != r["t"]:
                r["tc"] = old_row["t"]      # เทรนด์เดิมก่อนเปลี่ยน

    # เปลี่ยนแปลงของราคาเทียบวันก่อนหน้าที่เก็บไว้ (ใช้ตรวจสอบความต่อเนื่อง)
    if prev_rows and not same_day:
        for r in rows:
            o = prev_rows.get(r["s"])
            if o and o.get("p"):
                r["pc"] = round((r["p"] / o["p"] - 1) * 100, 2) + 0.0

    if prev_rows:
        if same_day:
            print(f"สถานะเดิมเป็นของวันเดียวกัน ({prev_date}) "
                  f"ไม่คำนวณ 'เพิ่งมาถึงเส้น' และไม่ทับไฟล์")
        else:
            print(f"เทียบกับสถานะวันที่ {prev_date} · "
                  f"เพิ่งมาถึงเส้นวันนี้ {fresh_touch} ตัว")
    else:
        print("ยังไม่มีสถานะวันก่อนหน้า — รอบหน้าจะเริ่มเทียบได้")
    print()

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
            "weekly_count": sum(1 for r in rows if "w" in r),
            "prev_date": prev_date,
            "fresh_count": sum(1 for r in rows if "nw" in r),
            "near_tol": NEAR_TOL,
            "weekly_date": wk.get("date", "-"),
            "sector_med": sector_medians(rows, a.demo),
        },
        "themes": [{k: t[k] for k in ("key", "name", "desc", "order", "tickers")}
                   for t in themes],
        "rows": rows,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    # ── รับประกันว่าไฟล์ในโฟลเดอร์ docs มีครบทุกรอบ ──
    # ถ้าไฟล์ไหนหาย ขั้นตอน git add ใน GitHub Actions จะพังทั้งขั้นตอน (exit 128)
    # จึงสร้างไฟล์เปล่าไว้แทนที่จะปล่อยให้ไม่มี
    if not os.path.exists(BACKTEST_PATH):
        with open(BACKTEST_PATH, "w", encoding="utf-8") as f:
            json.dump({"generated": None, "signals": {},
                       "note": "ยังไม่ได้ทดสอบย้อนหลัง — รัน python backtest.py"},
                      f, ensure_ascii=False)
        print("สร้างไฟล์ backtest.json เปล่าไว้ (ยังไม่ได้ทดสอบย้อนหลัง)")

    if not os.path.exists(FUND_PATH):
        save_fundamentals(fund if isinstance(fund, dict) else {})
        print("สร้างไฟล์ fundamentals.json ไว้ (ยังไม่มีข้อมูลพื้นฐาน)")

    if not os.path.exists(PREV_PATH):
        save_prev({"date": None, "rows": {}})
        print("สร้างไฟล์ prev.json ไว้ (ยังไม่มีสถานะวันก่อนหน้า)")

    if not os.path.exists(WEEKLY_PATH):
        save_weekly(wk if isinstance(wk, dict) and wk else
                    {"updated": None, "date": "-", "rows": {}})
        print("สร้างไฟล์ weekly.json ไว้ (ยังไม่มีข้อมูลรายสัปดาห์)")

    # เก็บสถานะวันนี้ไว้เทียบรอบหน้า
    # ถ้ารันซ้ำวันเดิมจะไม่ทับ ไม่งั้น "เพิ่งมาถึงเส้น" จะหายไปทั้งหมด
    if last_date is not None and not same_day:
        save_prev(snapshot(rows, today_str))
    elif not os.path.exists(PREV_PATH) and last_date is not None:
        save_prev(snapshot(rows, today_str))

    size = os.path.getsize(OUT) / 1024
    print(f"เขียนไฟล์ -> {OUT} ({size:.0f} KB)")
    print(f"  หุ้นทั้งหมด {len(rows)} ตัว · คำนวณ EMA ได้ {payload['meta']['ema_count']} ตัว")
    print(f"  มีข้อมูลพื้นฐาน {payload['meta']['fund_count']} ตัว "
          f"· ค่ากลางรายหมวด {len(payload['meta']['sector_med'])} หมวด")
    print(f"  เพิ่งมาถึงเส้นวันนี้ {payload['meta']['fresh_count']} ตัว")
    print(f"  มีเส้นรายสัปดาห์ {payload['meta']['weekly_count']} ตัว "
          f"· ข้อมูลถึงสัปดาห์ของวันที่ {payload['meta']['weekly_date']}")
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
        outr = [r["s"] for r in withf
                if r["f"].get("hi") and r["f"].get("lo")
                and not (r["f"]["lo"] * 0.95 <= r["p"] <= r["f"]["hi"] * 1.05)]
        if outr:
            checks.append(f"ราคาอยู่นอกช่วง 52 สัปดาห์ {len(outr)} ตัว: {', '.join(outr[:6])}")
        edold = [r["s"] for r in withf if r["f"].get("edold")]
        if edold:
            checks.append(f"เลยวันประกาศงบไปแล้วแต่ข้อมูลยังไม่อัปเดต {len(edold)} ตัว: "
                          f"{', '.join(edold[:6])}")
        qold = [r["s"] for r in withf if r["f"].get("qold")]
        if qold:
            checks.append(f"ไตรมาสล่าสุดเก่ากว่า {QUARTER_MAX_AGE} วัน {len(qold)} ตัว: "
                          f"{', '.join(qold[:6])}")
        rech = [r["s"] for r in withf if r["f"].get("recheck")]
        if rech:
            checks.append(f"รอดึงข้อมูลใหม่ {len(rech)} ตัว (ข้อมูลเดิมไม่สอดคล้องกับราคา)")
        bigpe = [r["s"] for r in withf if (r["f"].get("pe") or 0) > 1000]
        if bigpe:
            checks.append(f"P/E สูงผิดปกติ {len(bigpe)} ตัว: {', '.join(bigpe[:6])}")
        fakes = [r["s"] for r in withf if r["f"].get("dm")]
        if fakes:
            checks.append(f"ยังเป็นข้อมูลจำลอง {len(fakes)} ตัว — "
                          f"รัน workflow ซ้ำจนกว่าจะหมด")
        ages = []
        for r in withf:
            if r["f"].get("fts"):
                try:
                    ages.append((datetime.now().date()
                                 - datetime.fromisoformat(r["f"]["fts"]).date()).days)
                except ValueError:
                    pass
        if ages:
            print(f"  อายุข้อมูลพื้นฐาน: ใหม่สุด {min(ages)} วัน · "
                  f"เก่าสุด {max(ages)} วัน · เฉลี่ย {sum(ages)/len(ages):.1f} วัน")
        oldf = [a for a in ages if a > FUND_STALE_DAYS + 2]
        if oldf:
            checks.append(f"ข้อมูลพื้นฐานเก่ากว่า {FUND_STALE_DAYS + 2} วัน {len(oldf)} ตัว "
                          f"— รัน workflow ซ้ำเพื่อดึงให้ครบ")
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
