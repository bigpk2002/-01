name: ทดสอบย้อนหลังสัญญาณ

# แยกจาก build.yml เพราะ backtest.py ใช้เวลานานกว่า (ดึงราคาย้อนหลังหลายปี)
# และไม่จำเป็นต้องรันทุกวัน — กดเองตอนอยากอัปเดตผลก็พอ

on:
  workflow_dispatch:
    inputs:
      years:
        description: "ย้อนหลังกี่ปี"
        default: "3"
      mode:
        description: "real = ราคาจริง | random = ชุดควบคุมพิสูจน์ว่าไม่มีอคติ"
        default: "real"
        type: choice
        options: ["real", "random"]

permissions:
  contents: write

concurrency:
  group: backtest

jobs:
  backtest:
    runs-on: ubuntu-latest
    steps:
      - name: เช็กเอาต์โค้ด
        uses: actions/checkout@v4

      - name: ติดตั้ง Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: ติดตั้งไลบรารี
        run: pip install pandas numpy yfinance

      - name: รันทดสอบย้อนหลัง
        env:
          YEARS: ${{ inputs.years || '3' }}
          MODE: ${{ inputs.mode || 'real' }}
        run: |
          if [ "$MODE" = "random" ]; then
            python backtest.py --years "$YEARS" --random
          else
            python backtest.py --years "$YEARS"
          fi

      - name: อัปเดตผลลัพธ์
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          if [ ! -f docs/backtest.json ]; then
            echo "::error::ไม่พบ docs/backtest.json — backtest.py อาจทำงานไม่สำเร็จ"
            exit 1
          fi
          git add -f docs/backtest.json

          if git diff --quiet --cached; then
            echo "ผลไม่เปลี่ยน ไม่ต้องคอมมิต"
            exit 0
          fi

          git commit -m "ผลทดสอบย้อนหลัง ($MODE, ${YEARS}y) ณ $(date -u '+%Y-%m-%d %H:%M UTC')"

          for i in 1 2 3; do
            if git push; then
              echo "ส่งขึ้นสำเร็จ"
              exit 0
            fi
            echo "ส่งไม่สำเร็จ ลองใหม่ ($i/3)"
            git pull --rebase --autostash || true
            sleep 5
          done
          echo "::error::ส่งขึ้น GitHub ไม่สำเร็จหลังลอง 3 ครั้ง"
          exit 1

      - name: เก็บไฟล์ไว้ดาวน์โหลด
        uses: actions/upload-artifact@v4
        with:
          name: backtest-${{ github.run_number }}
          path: docs/backtest.json
          retention-days: 30
