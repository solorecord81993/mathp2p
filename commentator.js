// ==================== AI COMMENTATOR ====================
// Phrase bank + a tiny priority queue so only one line is "spoken" (broadcast as a
// tts_speak event) at a time. The Live Dashboard (public/live.html) is the device that
// actually calls the Web Speech API — this module just decides WHAT to say and WHEN.

export const COMMENTATOR_PHRASES = {
  welcome: [
    'ยินดีต้อนรับสู่ Math Battle Live! เกมคิดเลขเร็วที่สนุกที่สุด!',
    'สวัสดีทุกคน! วันนี้เรามีเกมคิดเลขสุดมันส์รออยู่!',
    'พร้อมกันหรือยัง? Math Battle กำลังจะเริ่มแล้ว!',
  ],
  viewerJoin: [
    (name) => `ยินดีต้อนรับ ${name} เข้าสู่ไลฟ์ครับ!`,
    (name) => `${name} เข้ามาแล้ว! มาลุ้นเกมคิดเลขกันเถอะ!`,
  ],
  joinInstructions: [
    (name, room) => `${name} อยากเล่นด้วยใช่ไหม เปิดเว็บเกมแล้วใส่รหัสห้อง ${room || '------'} ได้เลยครับ!`,
    (name, room) => `อยากร่วมสนุกกับ ${name} ไหม รหัสห้องคือ ${room || '------'} เปิดเว็บแล้วพิมพ์รหัสนี้ได้เลย!`,
  ],
  roundStart: [
    (round) => `รอบที่ ${round} เริ่มแล้ว! ใครจะเป็นผู้ชนะ?`,
    (round) => `รอบ ${round}! พร้อมคิดเลขกันรึยัง?`,
  ],
  correctAnswer: [
    (name, score) => `${name} ตอบถูกเร็วที่สุด! ได้ ${score} คะแนน!`,
    (name) => `สุดยอด! ${name} คิดเลขเร็วมาก!`,
  ],
  timeUp: [
    'หมดเวลา! รอบนี้ไม่มีใครทำได้ตรงเป้าเลยครับ',
    'เวลาหมดแล้ว! ไปลุ้นรอบถัดไปกันเลย!',
  ],
  like: [
    (name, count) => `${name} กดไลค์ ${count} ครั้ง ขอบคุณมากครับ!`,
    (name) => `ไลค์จาก ${name}! เป็นกำลังใจให้ผู้เล่นด้วยนะครับ!`,
  ],
  gift: [
    (name, gift) => `ขอบคุณ ${name} สำหรับ ${gift} สุดยอดมากครับ!`,
    (name, gift) => `ว้าว! ${name} ส่ง ${gift} มา ขอบคุณจริง ๆ ครับ!`,
  ],
  follow: [
    (name) => `${name} กดติดตามแล้ว! ยินดีต้อนรับสู่ครอบครัว Math Battle ครับ!`,
  ],
  gameEnd: [
    (winner, score) => `เกมจบแล้ว! ขอแสดงความยินดีกับ ${winner} ที่ได้ ${score} คะแนน!`,
    (winner) => `แชมป์ของวันนี้คือ ${winner}! เก่งมากครับ!`,
  ],
};

export function getRandomPhrase(category, ...args) {
  const phrases = COMMENTATOR_PHRASES[category];
  if (!phrases || !phrases.length) return '';
  const phrase = phrases[Math.floor(Math.random() * phrases.length)];
  return typeof phrase === 'function' ? phrase(...args) : phrase;
}

// One TTS queue per room. Higher priority jumps the line; same priority = FIFO.
const PRIORITY = { high: 3, normal: 2, low: 1 };

export function createTtsQueue(onSpeak) {
  let queue = [];
  let speaking = false;

  function pump() {
    if (speaking || queue.length === 0) return;
    const item = queue.shift();
    speaking = true;
    onSpeak(item.text);
    // Rough estimate of how long Thai TTS takes to say this line, so we don't
    // talk over ourselves. The dashboard's own utterance.onend is the real signal
    // for BGM ducking; this timer is only used to pace the *queue*.
    const words = item.text.split(/\s+/).length;
    const durationMs = Math.max(1800, words * 220 + 500);
    setTimeout(() => {
      speaking = false;
      pump();
    }, durationMs);
  }

  return {
    push(text, priority = 'normal') {
      if (!text) return;
      queue.push({ text, priority, ts: Date.now() });
      queue.sort((a, b) => {
        if (a.priority !== b.priority) return PRIORITY[b.priority] - PRIORITY[a.priority];
        return a.ts - b.ts;
      });
      pump();
    },
    clear() {
      queue = [];
    },
  };
}
