# claude-autoloop

ให้ **Claude Code ทำงานยาวข้ามลิมิต 5 ชั่วโมงเองได้** — watchdog ตัวเล็ก ๆ ที่ปลุก session เดิมกลับมาทำงานต่อ "ทีละรอบ" จนกว่างานจะจบจริง (พิสูจน์ด้วย **stop marker** ในไฟล์ state กลาง) ไม่มี GUI, ไม่มี dependency, มีแค่ Node + `claude` CLI ที่ login ไว้แล้ว

> ต่อยอดจากแนวคิด [autoresume]: อ่าน "เวลา reset" จาก output จริงของ Claude Code (ไม่ใช่เดา) → นอนรอ → ยิงต่ออัตโนมัติ · เพิ่มสิ่งที่ autoresume ไม่มี: **สัญญา state กลาง + เงื่อนไขหยุดจากไฟล์ + heartbeat อัตโนมัติ + สั่งแบบ start/stop/status ไม่ต้องเฝ้า terminal**

## มันแก้ปัญหาอะไร

- `/loop` ในแชทตั้งปลุกตัวเองได้สูงสุด ~1 ชม. และ**ตายถาวร**ถ้าโดน usage limit กลางคัน
- Cloud routines ฟื้นเองได้ แต่**มองไม่เห็นเครื่อง local** (localhost, งานที่ยังไม่ push, Chrome, ไฟล์ creds)
- autoloop = จุดกึ่งกลาง: **รันบนเครื่องคุณ เห็นทุกอย่างที่ session เดิมเห็น + ฟื้นเองหลังลิมิตเหมือน cloud**

## หลักการทำงาน

```
┌────────────────────────────────────────────────────────┐
│ ทุก cycle:                                              │
│ 1. อ่าน state file → เจอ stop marker? ── จบสวย ✅       │
│ 2. ยิง claude -p --resume <session> (prompt ประจำรอบ)  │
│ 3. โดน limit? → อ่านเวลา reset จาก output จริง          │
│      → นอนรอถึงเวลานั้น (+buffer)                       │
│      → อ่านไม่ได้? fallback +300 นาที (ตั้งได้)          │
│ 4. รอบสำเร็จ? → นับ cycle → วนข้อ 1                     │
│ 5. error อื่น? → หยุดทันที ไม่ลูปมั่ว (อ่าน log ได้)      │
│ ทุกจังหวะ → เขียน heartbeat ลง <state>.autoloop.json    │
└────────────────────────────────────────────────────────┘
```

**สัญญา 2 ไฟล์ (แยกหน้าที่ชัด):**

| ไฟล์ | ใครเขียน | มีอะไร |
|---|---|---|
| `STATE.md` (คุณเลือก path เอง) | **เซสชัน Claude ที่ทำงาน** อัปเดตทุกรอบ | checklist งาน, log, และ **stop marker** เมื่อเสร็จ |
| `STATE.md.autoloop.json` | **autoloop** เขียนอัตโนมัติ | pid, status (running/sleeping/done/error), cycles, limitedAt, **resumeAt (จะตื่นกี่โมง)** |

## ติดตั้ง

```bash
git clone https://github.com/<you>/claude-autoloop
# ไม่ต้อง npm install — pure Node ≥18
```

ติดตั้ง skill ให้ Claude Code เรียกใช้เป็น (`/autoloop`):

```bash
npx skills add https://github.com/<you>/claude-autoloop --skill autoloop
```

## ใช้งานเร็ว

```bash
# 1) หา session id ของแชทที่จะให้ทำงานต่อ (สำคัญ: อย่าใช้ --continue เฉย ๆ เดี๋ยวหยิบแชทผิด)
node bin/autoloop.mjs list

# 2) เตรียมไฟล์ (ดู examples/)
#    - STATE.md        = แผน+checklist + ตกลง stop marker
#    - round-prompt.txt = prompt ประจำรอบ (แก้สด ๆ กลางทางได้ อ่านใหม่ทุกรอบ)

# 3) ปล่อยรันเบื้องหลัง
node bin/autoloop.mjs start \
  --cwd "F:\my-proj" \
  --session <SESSION_ID> \
  --state-file "F:\my-proj\docs\STATE.md" \
  --prompt-file "F:\my-proj\docs\round-prompt.txt" \
  --permission-mode acceptEdits \
  --max-cycles 20

# 4) ดูสถานะ / หยุด
node bin/autoloop.mjs status --state-file "F:\my-proj\docs\STATE.md"
node bin/autoloop.mjs stop   --state-file "F:\my-proj\docs\STATE.md"
```

## เงื่อนไขหยุด (ครบทุกทางออก)

1. **stop marker ในไฟล์ state** (ดีสุด — เช็คก่อนเผาโควตาทุกรอบ) — default `AUTOLOOP: COMPLETE`
2. marker ในคำตอบของ agent (กันเหนียว)
3. `--max-cycles` ครบ (เพดานรอบสำเร็จ)
4. `--max-waits` ครบ (โดนลิมิตซ้ำเกินกำหนด)
5. error ที่ไม่ใช่ลิมิต → หยุดทันที + เก็บท้าย log ไว้ให้อ่าน
6. `autoloop stop` / Ctrl+C (จบสวยหลังรอบปัจจุบัน)

## Flags หลัก

| flag | default | ความหมาย |
|---|---|---|
| `--state-file` | (บังคับ) | ไฟล์ state กลาง — จุดเช็ค stop marker |
| `--session` | ล่าสุดใน cwd | session id เป้าหมาย (**แนะนำระบุเสมอ**) |
| `--prompt-file` / `--prompt` | ข้อความกลาง ๆ | prompt ประจำรอบ (file ชนะ, hot-reload) |
| `--stop-marker` | `AUTOLOOP: COMPLETE` | สตริงจบงาน |
| `--fallback-wait-min` | `300` (5 ชม.) | รอเท่าไหร่เมื่ออ่านเวลา reset ไม่ได้ |
| `--max-cycles` / `--max-waits` | 30 / 20 | เพดานรอบสำเร็จ / เพดานครั้งที่โดนลิมิต |
| `--buffer` / `--min-retry` | 90 / 60 วินาที | กันตื่นเร็วไป / กันถี่ไป |
| `--permission-mode` | — | ส่งต่อให้ claude (แนะนำ `acceptEdits`) |
| `--timeout` | 0 | ฆ่ารอบที่ค้างเกิน N วินาที |
| `--claude-cmd` | `claude` | override binary (ไว้เทสต์ด้วย mock) |

## แจ้งเตือน Telegram / Webhook

autoloop ยิงแจ้งเตือนเองที่จังหวะสำคัญ (ไม่สแปมทุกรอบ): **เริ่มขับ · โดน limit (บอกเวลาจะตื่น) · ฟื้นกลับมาทำต่อสำเร็จ · งานจบ (แยกเหตุผล marker/ครบเพดาน) · error ที่ต้องมาดู · ถูกสั่งหยุด**

```bash
# ตั้งค่า: สร้าง autoloop.secrets.json ที่ root (gitignored แล้ว) — ดู autoloop.secrets.example.json
{ "telegram": { "token": "<จาก @BotFather>", "chatId": "<chat id>" } }
# หรือใช้ env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID / AUTOLOOP_WEBHOOK_URL (Discord/Slack/generic ก็ได้)

# ทดสอบก่อนใช้จริง
node bin/autoloop.mjs notify-test

# ปิดชั่วคราว: --no-notify
```

## กติกาที่ทำให้ปลอดภัย

- **1 session = 1 คนขับ** — ระหว่าง autoloop รัน ห้ามเปิดแชทนั้นคุยมือ/รันซ้อน (ตัว `start` กันซ้อนให้ระดับหนึ่งด้วย pid probe)
- prompt ประจำรอบควรขึ้นต้นด้วย "กู้ซากก่อน" (ดู examples) — เผื่อรอบก่อนตายกลางคัน
- headless ตอบ permission prompt ไม่ได้ → ใช้ allowlist ของโปรเจกต์ + `--permission-mode acceptEdits` · **อย่าใช้** `--dangerously-skip-permissions`
- ไม่มีการเก็บ token/secret ใด ๆ — เรียก `claude` CLI ที่ login อยู่แล้วบนเครื่องคุณ · sidecar/log ถูก gitignore ไว้แล้ว

## ทดสอบ

```bash
npm test   # smoke test ครบวงจรกับ mock claude (limit → sleep → resume → marker) ไม่เผาโควตาจริง
```

---

## English (short)

**claude-autoloop** keeps a long-running Claude Code session working across subscription usage limits. A tiny Node watchdog resumes one session headlessly round-by-round; on a usage limit it parses the real reset time from Claude's own output and sleeps past it (configurable +5h fallback), until a **stop marker** appears in your shared state file. Ships with a Claude Code **skill** (`/autoloop`) that sets everything up. `start` / `status` / `stop`, heartbeat sidecar JSON, no GUI, no deps, MIT.
