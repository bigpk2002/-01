#!/usr/bin/env python3
"""
ส่งสรุปเข้า Telegram หลังดึงข้อมูลเสร็จ

อ่านไฟล์ docs/data.json ที่ build.py สร้างไว้ แล้วสรุปเป็นข้อความสั้น ๆ
ไม่ต้องเปิดเว็บก็รู้ว่าวันนี้ตลาดเป็นอย่างไร

ต้องตั้งค่าสองอย่างเป็น Secret ใน GitHub ก่อน (ดูวิธีใน README)
    TELEGRAM_TOKEN     โทเคนบอทที่ได้จาก @BotFather
    TELEGRAM_CHAT_ID   รหัสห้องแชทของคุณ

ถ้าไม่ได้ตั้ง สคริปต์จะข้ามไปเงียบ ๆ ไม่ทำให้ workflow ล้มเหลว

    python notify.py            ส่งจริง
    python notify.py --dry      แสดงข้อความที่จะส่งบนหน้าจอ ไม่ส่งจริง
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "docs", "data.json")

EMAS = [5, 10, 20, 50, 100, 200]
W = {5: 1.0, 10: 1.0, 20: 1.5, 50: 2.0, 100: 2.5, 200: 3.0}
TOL = 1.5                 # ระยะที่ถือว่าใกล้เส้น (%) — ให้ตรงกับค่าเริ่มต้นบนเว็บ
TREND_TH = {"up": "ขาขึ้น", "down": "ขาลง", "flat": "ออกข้าง"}


def load() -> dict:
    if not os.path.exists(DATA):
        sys.exit(f"ไม่พบไฟล์ข้อมูล {DATA} — รัน build.py ก่อน")
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


def money(v) -> str:
    if not v:
        return "-"
    if v >= 1e12:
        return f"{v / 1e12:.2f} ล้านล้าน"
    if v >= 1e9:
        return f"{v / 1e9:.0f} พันล้าน"
    return f"{v / 1e6:.0f} ล้าน"


def score_of(r: dict) -> tuple[float, list[int]]:
    """คะแนนความน่าสนใจแบบเดียวกับที่หน้าเว็บใช้"""
    d = r.get("d")
    if not d:
        return 0.0, []
    near = [p for i, p in enumerate(EMAS) if abs(d[i]) <= TOL]
    if not near:
        return 0.0, []
    sc = sum(W[p] * (0.5 + 0.5 * (1 - abs(d[EMAS.index(p)]) / TOL)) for p in near)
    if r.get("a"):
        sc += 2
    if r.get("t") == "up":
        sc += 1
    if (r.get("sl") or 0) > 0:
        sc += 0.5
    return sc, near


def build_message(D: dict) -> str:
    meta, rows = D["meta"], D["rows"]
    periods = meta.get("periods") or []
    pi = periods.index("1d") if "1d" in periods else 0
    mi = periods.index("1m") if "1m" in periods else 0

    L = []
    L.append(f"📊 สรุปหุ้น AI · ข้อมูลปิดตลาด {meta['date']}")
    if meta.get("demo"):
        L.append("⚠️ ข้อมูลจำลอง ไม่ใช่ราคาจริง")
    L.append("")

    # ── ธีมที่แรงสุด/อ่อนสุดในรอบ 1 เดือน ──
    by_t = {r["s"]: r for r in rows}
    groups = []
    for t in D.get("themes", []):
        vals = [by_t[x]["r"][mi] for x in t["tickers"]
                if x in by_t and isinstance(by_t[x].get("r"), list)
                and len(by_t[x]["r"]) > mi and by_t[x]["r"][mi] is not None]
        if vals:
            groups.append((t["name"], statistics.median(vals), len(vals)))
    groups.sort(key=lambda x: -x[1])

    if groups:
        L.append("🔥 ธีมที่แรงสุดในรอบ 1 เดือน (ค่ากลางกลุ่ม)")
        for name, med, n in groups[:3]:
            L.append(f"   {med:+.1f}%  {name}  ({n} ตัว)")
        L.append("")
        L.append("🧊 ธีมที่อ่อนสุด")
        for name, med, n in groups[-2:][::-1]:
            L.append(f"   {med:+.1f}%  {name}  ({n} ตัว)")
        L.append("")

    # ── หุ้นที่มาชนเส้น EMA น่าสนใจสุด ──
    cands = []
    for r in rows:
        sc, near = score_of(r)
        if sc > 0:
            cands.append((sc, near, r))
    cands.sort(key=lambda x: -x[0])

    if cands:
        L.append(f"🎯 มาชนเส้น EMA ในระยะ {TOL}% (คะแนนสูงสุด)")
        for sc, near, r in cands[:6]:
            pe = (r.get("f") or {}).get("pe")
            pe_s = f" · P/E {pe:.1f}" if pe else ""
            chg = r["r"][pi] if (isinstance(r.get("r"), list)
                                 and len(r["r"]) > pi and r["r"][pi] is not None) else 0.0
            L.append(f"   {r['s']} ${r['p']} ({chg:+.1f}%)")
            L.append(f"      ชนเส้น {'/'.join(map(str, near))} · "
                     f"{TREND_TH.get(r.get('t'), '')}{pe_s}")
        L.append("")

    # ── ตัวที่มาแตะเส้นใหญ่ 200 พอดี ──
    big = [r for r in rows if r.get("d") and abs(r["d"][5]) <= 1.0]
    if big:
        big.sort(key=lambda r: abs(r["d"][5]))
        L.append("🧱 แตะเส้น EMA200 (แนวรับ/ต้านใหญ่) ในระยะ 1%")
        for r in big[:5]:
            side = "เหนือเส้น" if r["d"][5] >= 0 else "ใต้เส้น"
            L.append(f"   {r['s']} ${r['p']} · ห่าง {r['d'][5]:+.2f}% ({side})")
        L.append("")

    # ── ขึ้นแรง/ลงแรงของวัน ──
    day = [r for r in rows if isinstance(r.get("r"), list)
           and len(r["r"]) > pi and r["r"][pi] is not None]
    day.sort(key=lambda r: -r["r"][pi])
    if day:
        up = ", ".join(f"{r['s']} {r['r'][pi]:+.1f}%" for r in day[:4])
        dn = ", ".join(f"{r['s']} {r['r'][pi]:+.1f}%" for r in day[-4:][::-1])
        L.append(f"📈 ขึ้นแรงวันนี้: {up}")
        L.append(f"📉 ลงแรงวันนี้: {dn}")
        L.append("")

    L.append(f"คำนวณจากหุ้น {meta['count']} ตัว · "
             f"มีข้อมูลพื้นฐาน {meta.get('fund_count', 0)} ตัว")
    L.append("ดูรายละเอียดทั้งหมดบนเว็บ · เครื่องมือคัดกรอง ไม่ใช่คำแนะนำการลงทุน")
    return "\n".join(L)


def send(text: str, token: str, chat: str) -> bool:
    # Telegram จำกัดข้อความละ 4096 ตัวอักษร ตัดเผื่อไว้
    if len(text) > 3900:
        text = text[:3900] + "\n…(ตัดข้อความ)"
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat,
        "text": text,
        "disable_web_page_preview": "true",
    }).encode()
    try:
        with urllib.request.urlopen(url, data=data, timeout=30) as r:
            ok = json.loads(r.read()).get("ok", False)
        print("ส่งข้อความเข้า Telegram แล้ว" if ok else "Telegram ตอบว่าไม่สำเร็จ")
        return bool(ok)
    except Exception as e:
        print(f"! ส่ง Telegram ไม่สำเร็จ: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="แสดงข้อความบนหน้าจอ ไม่ส่งจริง")
    a = ap.parse_args()

    try:
        msg = build_message(load())
    except Exception as e:
        # ไฟล์ข้อมูลผิดรูปหรือขาดบางส่วน — ไม่ควรทำให้ workflow ล้ม
        print(f"! สร้างข้อความไม่สำเร็จ: {e}")
        return 0

    if a.dry:
        print(msg)
        print(f"\n[ความยาว {len(msg)} ตัวอักษร]")
        return 0

    token = os.environ.get("TELEGRAM_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat:
        print("ยังไม่ได้ตั้ง TELEGRAM_TOKEN หรือ TELEGRAM_CHAT_ID — ข้ามการแจ้งเตือน")
        return 0

    send(msg, token, chat)
    return 0          # ส่งไม่สำเร็จก็ไม่ให้ workflow ล้ม เพราะข้อมูลบนเว็บอัปเดตแล้ว


if __name__ == "__main__":
    sys.exit(main())
