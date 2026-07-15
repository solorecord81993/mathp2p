# Math Battle — Live Bridge Server 📡

เซิร์ฟเวอร์ Node.js ตัวเล็ก ๆ ที่ทำหน้าที่เป็น "สะพาน" ระหว่าง

1. **เกม Math Battle** (`public/index.html`) — รันบนมือถือของ Host
2. **Live Dashboard** (`public/live.html`) — รันบนมือถือ/คอมเครื่องที่สอง แล้วเปิดเป็น Browser Source ใน OBS หรือ TikTok Live Studio
3. **TikTok LIVE** — อ่าน comment / gift / like / follow มาแปลงเป็นเสียงพากย์ + ป้ายแจ้งเตือนบนจอ

## ทำไมต้องแยกเป็นเซิร์ฟเวอร์ต่างหาก (ไม่ใช้ Vercel)

ดีไซน์แรกที่ร่างไว้ใน `math-battle-tiktok-live-architecture.md` วาง WebSocket server และการเชื่อมต่อ
TikTok Live ไว้ใน Vercel Serverless Function — **ใช้งานจริงไม่ได้** เพราะ:

- Serverless function ถูกเรียกเป็นครั้ง ๆ แล้วปิดตัวเอง (Vercel Hobby ตัดที่ ~10 วิ) แต่การฟัง TikTok Live
  ต้องมี connection ค้างไว้ตลอดเวลาไม่มีกำหนด
- แม้แต่ตัวแปร state ในหน่วยความจำ (`const rooms = new Map()`) ก็หายไปทุกครั้งที่ function ถูกเรียกใหม่บน
  container คนละตัว

ทางแก้คือรัน Node.js process ตัวเดียวที่ **ไม่มีวันหลับ** (persistent) แยกออกมาต่างหาก คล้ายกับที่คุณรัน
Telegram bot บน Render.com อยู่แล้ว — จึงเลือก pattern เดียวกัน

## Deploy ขึ้น Render.com (แนะนำ — มี free tier)

1. Push โฟลเดอร์ `bridge-server/` นี้ขึ้น GitHub repo ของคุณ (จะแยก repo ต่างหาก หรือรวมไว้ใน repo เดียวกับ
   `math-battle-p2p` ก็ได้ — ถ้ารวม ให้ตั้งค่า **Root Directory** เป็น `bridge-server` ตอนสร้าง service)
2. ที่ Render Dashboard → **New** → **Web Service** → เลือก repo นี้
3. ตั้งค่า:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (ใช้งานได้ แต่จะ sleep เมื่อไม่มี traffic ~15 นาที ดูหัวข้อ "ข้อจำกัด" ด้านล่าง)
4. Environment Variables (Render → service → Environment):
   - `EULERSTREAM_API_KEY` — แนะนำให้ตั้ง (ดูวิธีขอฟรีด้านล่าง) ไม่ตั้งก็รันได้แต่การเชื่อมต่อ TikTok
     อาจโดน rate-limit หรือหลุดบ่อยกว่า
5. Deploy แล้วคัดลอก URL ที่ได้ เช่น `https://math-battle-live-bridge.onrender.com` แล้วแปลงเป็น
   `wss://math-battle-live-bridge.onrender.com` (เปลี่ยน `https://` → `wss://`) — นี่คือ **Bridge Server URL**
   ที่ต้องกรอกทั้งในเกม (Settings) และใน `live.html`

## การขอ Euler Stream API Key (ฟรี)

`tiktok-live-connector` (ไลบรารีที่ใช้อ่าน TikTok Live) ต้องพึ่งพา sign-server เพื่อสร้างพารามิเตอร์ที่
TikTok เซ็นชื่อไว้ (msToken, X-Bogus) — ตัวไลบรารีเองใช้ **Euler Stream** เป็นค่าเริ่มต้น สมัครฟรีได้ที่
https://www.eulerstream.com (มี free tier) แล้วนำ API key มาใส่ในตัวแปร `EULERSTREAM_API_KEY`

> **ข้อควรรู้อย่างตรงไปตรงมา:** TikTok ไม่มี public API อย่างเป็นทางการสำหรับ Live เลย ไลบรารีนี้เป็นโปรเจกต์
> reverse-engineering ที่ดูแลต่อเนื่องดี แต่ TikTok เปลี่ยนระบบได้ตลอดเวลาโดยไม่แจ้งล่วงหน้า และอาจทำให้การ
> เชื่อมต่อใช้งานไม่ได้ชั่วคราวจนกว่าไลบรารีจะอัปเดตตาม ถือว่าเป็นฟีเจอร์ "best effort" — ตัวเกม Math Battle
> เองเล่นได้ปกติ 100% ไม่ว่าส่วนนี้จะเชื่อมต่อติดหรือไม่ก็ตาม

## ทดสอบรันในเครื่องตัวเอง

```bash
cd bridge-server
npm install
cp .env.example .env   # แล้วกรอก EULERSTREAM_API_KEY ถ้ามี
npm start
```

เซิร์ฟเวอร์จะฟังที่ `ws://localhost:8080` (หรือ `$PORT` ถ้าตั้งไว้) และมี health check ที่ `/health`

## วิธีต่อเข้ากับเกมและ Dashboard

1. **ในเกม (index.html):** เปิด ⚙️ ตั้งค่า → หัวข้อ "📡 TikTok Live (ตัวเลือกเสริม)" → กรอก Bridge Server URL
   (`wss://...`) → กด บันทึก จากนั้นเมื่อกด "สร้างห้อง" เกมจะเชื่อมต่อ Bridge อัตโนมัติ ถ้าไม่กรอก URL
   ฟีเจอร์นี้จะปิดอยู่เฉย ๆ เกมเล่นได้ปกติทุกอย่าง
2. **ใน Live Dashboard (`public/live.html`):** เปิดหน้านี้บนมือถือ/คอมเครื่องที่สอง กรอก Bridge Server URL,
   รหัสห้อง 6 หลัก (รหัสเดียวกับที่ Host เห็นในหน้าห้องรอ), และ (ถ้าต้องการ) username TikTok ที่กำลังไลฟ์
   → กดเชื่อมต่อ แล้วเพิ่มหน้านี้เป็น **Browser Source** ใน OBS / TikTok Live Studio

## Protocol โดยย่อ (WebSocket, ข้อความเป็น JSON)

**เกม (Host) → Bridge**
- `{type:'register_game', roomCode}`
- `{type:'game_state', data:{...}}`, `{type:'round_start', data:{...}}`, `{type:'player_update', data:{...}}`,
  `{type:'round_end', data:{...}}`, `{type:'game_end', data:{...}}` — ทั้งหมดถูก relay ต่อไปยัง dashboard ของ
  ห้องเดียวกันแบบเกือบทันที

**Dashboard → Bridge**
- `{type:'register_dashboard', roomCode, tiktokUsername?}` — ถ้าใส่ `tiktokUsername` มา และห้องนี้ยังไม่ได้
  ต่อ TikTok ไว้ Bridge จะเริ่มเชื่อมต่อให้ทันที

**Bridge → Dashboard**
- ข้อความทั้งหมดที่ relay มาจากเกม (เหมือนด้านบน)
- `{type:'game_disconnected'}` — ส่งทันทีที่ WebSocket ฝั่งเกมหลุด (ไม่ว่าจะกดออกจากห้องหรือปิดแท็บเฉย ๆ)
  live.html จะขึ้นข้อความ "จบการถ่ายทอดสดแล้ว" คลุมจอ แล้วหายไปเองเมื่อมีเกม/host คนใหม่ต่อเข้ามาส่งข้อมูลอีกครั้ง
  (รองรับ host migration ของเกมด้วย — host คนใหม่จะต่อ Bridge อัตโนมัติ)
- `{type:'tiktok_event', event:'chat'|'gift'|'like'|'member'|'follow'|'share', user:{nickname}, ...}`
- `{type:'viewer_count', count}`
- `{type:'tts_speak', text, pose}` — ให้ dashboard พูดด้วย Web Speech API (client-side) พร้อมโชว์ตัวละคร
  มาสคอต (`public/mascot/*.png`) เลื่อนเข้ามาจากมุมขวาล่างพร้อมลูกโป่งคำพูด `pose` เป็นหนึ่งใน
  `wave`|`explain`|`think`|`confused`|`celebrate` — map จาก category ของประโยคใน commentator.js
  (`CATEGORY_POSE`) มีทั้งคำพากย์ที่มาจากเหตุการณ์จริง (เริ่มรอบ/ตอบถูก/ของขวัญ ฯลฯ) และคำพากย์แทรก
  "DJ chatter" ที่พูดเป็นระยะเมื่อเงียบไปนาน (สุ่มทุก ~6-12 วินาทีที่ไม่มีใครพูด ดู commentator.js
  หมวด `filler_*` เพื่อแก้ไข/เพิ่มประโยค)
- `{type:'tiktok_status', connected, username, error?}`

## ข้อจำกัดที่ควรรู้

- **Render free tier จะ sleep** เมื่อไม่มี traffic เข้ามา ~15 นาที ทำให้การเชื่อมต่อ WebSocket หลุดและต้อง
  ปลุกเซิร์ฟเวอร์ใหม่ (จะช้าไปครั้งแรก) — ถ้าจะไลฟ์จริงจังต่อเนื่อง แนะนำอัปเป็น instance แบบเสียเงินที่ไม่ sleep
  หรือใช้บริการ uptime-ping ปลุกเป็นระยะ (ผิดเจตนารมณ์ free tier อยู่บ้าง แต่เป็นวิธีที่คนใช้กันทั่วไป)
- **ไม่มีทางให้ผู้ชม TikTok เข้าห้องเกมอัตโนมัติผ่านคอมเมนต์ `!join`** ได้จริง เพราะ Math Battle เป็นเกม
  P2P (WebRTC ตรงระหว่างเบราว์เซอร์ ไม่มี server กลางที่จะเพิ่มผู้เล่นแทนได้) สิ่งที่ Bridge ทำได้คือให้ AI
  พากย์/แสดงรหัสห้องบนจอเมื่อมีคนพิมพ์ `!join` เพื่อชวนให้เปิดเว็บแล้วใส่รหัสเองอีกที
- เก็บ state ของแต่ละห้องไว้ใน memory เท่านั้น (ไม่ persist ข้าม deploy/restart) — เหมาะกับการใช้งานสด
  ไม่ใช่การเก็บ log ระยะยาว
