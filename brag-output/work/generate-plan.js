const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORK = path.join(__dirname, 'work');
const OUT = path.dirname(__dirname);
const W = 1920, H = 1080, FPS = 30;
const DURATION = 20; // seconds
const TOTAL_FRAMES = DURATION * FPS;

// Create HTML-based frame generator
const HTML = `
<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; overflow: hidden; }
  canvas { width: 1920px; height: 1080px; display: block; }
</style>
</head>
<body>
<canvas id="c" width="1920" height="1080"></canvas>
<script>
const c = document.getElementById('c');
const ctx = c.getContext('2d');
const W = 1920, H = 1080;

// Color palette
const BG = '#0a0a0a';
const GREEN = '#25D366';
const GREEN_DARK = '#128C7E';
const WHITE = '#ffffff';
const AMBER = '#FFD700';
const TEAL = '#00E5FF';

function lerp(a, b, t) { return a + (b - a) * t; }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOut(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }

function clear() { ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); }

function drawPhone(x, y, s, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  // Phone body
  ctx.fillStyle = '#1a1a2e';
  ctx.strokeStyle = color || WHITE;
  ctx.lineWidth = 3;
  const r = s * 0.15;
  ctx.beginPath();
  ctx.roundRect(x - s/2, y - s*1.6, s, s*1.6, r);
  ctx.fill();
  ctx.stroke();
  // Screen
  ctx.fillStyle = '#0f0f23';
  ctx.beginPath();
  ctx.roundRect(x - s*0.38, y - s*1.45, s*0.76, s*1.1, r*0.5);
  ctx.fill();
  // WhatsApp icon (simplified)
  ctx.fillStyle = color || GREEN;
  ctx.beginPath();
  ctx.arc(x, y - s*0.8, s*0.15, 0, Math.PI*2);
  ctx.fill();
  // Signal bars
  for (let i = 0; i < 3; i++) {
    const bw = s*0.04, bh = s*(0.1 + i*0.08);
    ctx.fillStyle = GREEN;
    ctx.fillRect(x + s*0.25, y - s*1.25 - bh, bw, bh);
  }
  ctx.restore();
}

function drawChatBubble(x, y, text, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color || GREEN_DARK;
  ctx.beginPath();
  ctx.roundRect(x, y, 500, 80, 12);
  ctx.fill();
  // Tail
  ctx.beginPath();
  ctx.moveTo(x + 20, y + 80);
  ctx.lineTo(x + 40, y + 80);
  ctx.lineTo(x + 40, y + 95);
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = '24px Arial, sans-serif';
  ctx.fillText(text, x + 20, y + 50);
  ctx.restore();
}

function drawTypingDots(x, y, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.arc(x + i * 25, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawText(text, x, y, size, color, align, alpha, glow) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color || WHITE;
  ctx.font = 'bold ' + size + 'px Arial, sans-serif';
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = 30;
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawSubtitle(text, y, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '28px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, W/2, y);
  ctx.restore();
}

function drawCTA(text, x, y, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  // CTA button
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.roundRect(x - 250, y - 25, 500, 50, 10);
  ctx.fill();
  ctx.fillStyle = BG;
  ctx.font = 'bold 26px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawGridPhones(phones, time) {
  phones.forEach((p, i) => {
    const pulse = Math.sin(time * 3 + i * 1.5) * 0.1 + 0.9;
    drawPhone(p.x, p.y, p.size, p.color, pulse);
  });
}

// Scene timings (in frames)
const S1_DURATION = FPS * 2;   // 2s hook
const S2_DURATION = FPS * 3;   // 3s reveal
const S3_DURATION = FPS * 5;   // 5s rotation
const S4_DURATION = FPS * 5;   // 5s telegram
const S5_DURATION = FPS * 3;   // 3s coupon
const S6_DURATION = FPS * 2;   // 2s punchline
// Total = 20s

let frame = parseInt(process.argv[2]) || 0;

clear();

if (frame < S1_DURATION) {
  // Scene 1: One server. Fifty numbers.
  const t = frame / S1_DURATION;
  const pulse = Math.sin(frame * 0.15) * 0.15 + 0.85;
  drawPhone(W/2, H/2, 200, GREEN, pulse);
  const textAlpha = easeOut(Math.min(t * 3, 1));
  drawText('One server.', W/2, H/2 - 200, 64, WHITE, 'center', textAlpha, TEAL);
  drawText('Fifty numbers.', W/2, H/2 - 120, 64, WHITE, 'center', textAlpha, TEAL);
}
else if (frame < S1_DURATION + S2_DURATION) {
  // Scene 2: Dashboard reveal
  const t = (frame - S1_DURATION) / S2_DURATION;
  const staggerT = easeOut(t);

  // Grid of phones
  const gridPhones = [];
  const cols = 5, rows = 2;
  const spacingX = 300, spacingY = 200;
  const startX = W/2 - (cols-1)*spacingX/2;
  const startY = H/2 - (rows-1)*spacingY/2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const appearT = Math.max(0, Math.min(1, (staggerT * cols * rows - idx) / (cols * rows * 0.3)));
      if (appearT > 0) {
        gridPhones.push({
          x: startX + c * spacingX,
          y: startY + r * spacingY,
          size: 100,
          color: GREEN
        });
      }
    }
  }
  drawGridPhones(gridPhones, frame * 0.05);

  // Title
  const titleAlpha = easeOut(Math.max(0, (staggerT - 0.5) * 2));
  if (titleAlpha > 0) {
    drawText('WhatsApp Bot Hub', W/2, 120, 72, WHITE, 'center', titleAlpha, GREEN);
    drawSubtitle('Multi-instance WhatsApp automation at scale', 200, easeOut(Math.max(0, (staggerT - 0.7) * 3)));
  }
}
else if (frame < S1_DURATION + S2_DURATION + S3_DURATION) {
  // Scene 3: Session rotation
  const t = (frame - S1_DURATION - S2_DURATION) / S3_DURATION;

  // Two phones side by side
  const p1X = W/2 - 250, p2X = W/2 + 250, phoneY = H/2 + 50;

  // Phone 1 going out (red)
  const redAlpha = easeOut(Math.max(0, (t - 0) * 2));
  drawPhone(p1X, phoneY, 180, '#ff4444', redAlpha);
  drawText('📱 Logged out', p1X, phoneY - 230, 32, '#ff6666', 'center', redAlpha);

  // Arrow sliding
  const arrowT = easeInOut(Math.max(0, Math.min(1, (t - 0.3) * 3)));
  if (arrowT > 0) {
    ctx.save();
    ctx.globalAlpha = arrowT;
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 6;
    ctx.shadowColor = AMBER;
    ctx.shadowBlur = 15;
    ctx.beginPath();
    const arrowStartX = p1X + 100;
    const arrowEndX = p2X - 100;
    const midX = lerp(arrowStartX, arrowEndX, arrowT);
    ctx.moveTo(arrowStartX, phoneY);
    ctx.lineTo(midX, phoneY - 40 * Math.sin(arrowT * Math.PI));
    ctx.lineTo(arrowEndX, phoneY);
    ctx.stroke();
    // Arrowhead
    if (arrowT > 0.8) {
      const headT = (arrowT - 0.8) * 5;
      ctx.beginPath();
      ctx.moveTo(arrowEndX, phoneY - 15);
      ctx.lineTo(arrowEndX + 20 * headT, phoneY);
      ctx.lineTo(arrowEndX, phoneY + 15);
      ctx.fillStyle = AMBER;
      ctx.fill();
    }
    ctx.restore();
  }

  // Phone 2 taking over (green)
  const greenAlpha = easeOut(Math.max(0, (t - 0.5) * 2));
  drawPhone(p2X, phoneY, 180, GREEN, greenAlpha);
  const labelAlpha = easeOut(Math.max(0, (t - 0.7) * 3));
  drawText('✅ Auto-rotated', p2X, phoneY - 230, 32, GREEN, 'center', labelAlpha);

  const subAlpha = easeOut(Math.max(0, (t - 0.6) * 2.5));
  drawSubtitle('No downtime. Always connected.', W/2, H - 150, subAlpha);
}
else if (frame < S1_DURATION + S2_DURATION + S3_DURATION + S4_DURATION) {
  // Scene 4: Telegram control
  const t = (frame - S1_DURATION - S2_DURATION - S3_DURATION) / S4_DURATION;

  // Telegram phone mockup
  ctx.save();
  ctx.globalAlpha = easeOut(Math.min(t * 2, 1));

  // Phone body
  ctx.fillStyle = '#1a1a2e';
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(W/2 - 160, 100, 320, 700, 30);
  ctx.fill();
  ctx.stroke();

  // Header
  ctx.fillStyle = GREEN_DARK;
  ctx.beginPath();
  ctx.roundRect(W/2 - 155, 105, 310, 60, 25);
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = 'bold 22px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('🤖 Bot Hub', W/2, 140);

  // Chat bubbles appearing over time
  const bubbles = [
    { y: 200, text: '/addsession', time: 0.1, color: GREEN_DARK },
    { y: 310, text: '📱 Adding session...', time: 0.3, color: GREEN_DARK },
    { y: 420, text: '📦 upload apk', time: 0.5, color: GREEN_DARK },
    { y: 530, text: '🎁 BLINK50 → delivered', time: 0.7, color: GREEN_DARK },
    { y: 640, text: '👥 47 sessions online', time: 0.9, color: TEAL },
  ];

  bubbles.forEach(b => {
    const a = easeOut(Math.max(0, Math.min(1, (t - b.time) * 4)));
    if (a > 0) drawChatBubble(W/2 - 130, b.y, b.text, b.color, a);
  });

  // Typing dots
  const dotAlpha = Math.sin(t * 15) * 0.3 + 0.7;
  drawTypingDots(W/2 - 130, 720, dotAlpha);

  ctx.restore();

  const subAlpha = easeOut(Math.max(0, (t - 0.5) * 3));
  drawSubtitle('Manage everything from Telegram', W/2, 900, subAlpha);
}
else if (frame < S1_DURATION + S2_DURATION + S3_DURATION + S4_DURATION + S5_DURATION) {
  // Scene 5: Coupon delivery after 6h
  const t = (frame - S1_DURATION - S2_DURATION - S3_DURATION - S4_DURATION) / S5_DURATION;

  // Coupon card
  const cardAlpha = easeOut(Math.min(t * 3, 1));
  ctx.save();
  ctx.globalAlpha = cardAlpha;

  // Card background
  ctx.fillStyle = '#1a1a2e';
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 3;
  ctx.shadowColor = AMBER;
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.roundRect(W/2 - 350, H/2 - 180, 700, 360, 20);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Title
  ctx.fillStyle = AMBER;
  ctx.font = 'bold 36px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('🎁 Coupon Pool', W/2, H/2 - 120);

  // Code
  ctx.fillStyle = WHITE;
  ctx.font = 'bold 52px monospace';
  const codeAlpha = easeOut(Math.max(0, (t - 0.15) * 4));
  ctx.globalAlpha = cardAlpha * codeAlpha;
  ctx.fillText('BLINK50', W/2, H/2 - 50);

  // Timer
  ctx.globalAlpha = cardAlpha * easeOut(Math.max(0, (t - 0.3) * 3));
  ctx.fillStyle = '#888';
  ctx.font = '24px Arial';
  ctx.fillText('Waiting for 6h connection...', W/2, H/2 + 30);

  // Progress bar
  const progressT = easeOut(Math.max(0, Math.min(1, (t - 0.4) * 2)));
  ctx.fillStyle = '#333';
  ctx.beginPath();
  ctx.roundRect(W/2 - 200, H/2 + 50, 400, 12, 6);
  ctx.fill();
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.roundRect(W/2 - 200, H/2 + 50, 400 * progressT, 12, 6);
  ctx.fill();

  // Checkmark
  const doneAlpha = easeOut(Math.max(0, (t - 0.7) * 4));
  if (doneAlpha > 0) {
    ctx.globalAlpha = cardAlpha * doneAlpha;
    ctx.fillStyle = GREEN;
    ctx.font = 'bold 60px Arial';
    ctx.fillText('✅ Delivered', W/2, H/2 + 130);
  }

  ctx.restore();

  const subAlpha = easeOut(Math.max(0, (t - 0.5) * 3));
  drawSubtitle('Codes deliver after 6h of connection', W/2, H - 100, subAlpha);
}
else {
  // Scene 6: Punchline
  const t = (frame - S1_DURATION - S2_DURATION - S3_DURATION - S4_DURATION - S5_DURATION) / S6_DURATION;

  // All phones
  const phones = [];
  for (let i = 0; i < 9; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    phones.push({
      x: W/2 - 200 + col * 200,
      y: H/2 - 100 + row * 150,
      size: 80,
      color: GREEN
    });
  }
  drawGridPhones(phones, frame * 0.08);

  // Text
  const textAlpha = easeOut(Math.min(t * 4, 1));
  drawText('Build it.', W/2, H/2 - 120, 60, WHITE, 'center', textAlpha, GREEN);
  drawText('Ship it.', W/2, H/2 - 50, 60, WHITE, 'center', textAlpha, GREEN);
  drawText('Let it run.', W/2, H/2 + 20, 60, WHITE, 'center', textAlpha, GREEN);

  // CTA
  const ctaAlpha = easeOut(Math.max(0, (t - 0.5) * 4));
  if (ctaAlpha > 0) {
    drawCTA('github.com/Zazbhai/whatsapp-bot', W/2, H/2 + 120, ctaAlpha);
  }
}

// Signal the frame is ready
window.frameReady = true;
</script>
</body>
</html>
`;

// Write HTML file
const htmlPath = path.join(WORK, 'frames.html');
fs.writeFileSync(htmlPath, HTML);

console.log('HTML frame generator ready at:', htmlPath);

// Generate all frames using Puppeteer-like approach with node-canvas or direct approach
// Since we don't have puppeteer, we'll use a different approach: render frames with Node + canvas
// Actually, let's check if playwright is available
const { execSync } = require('child_process');
try {
  const playwrightVer = execSync('npx playwright --version 2>&1', { encoding: 'utf8', timeout: 5000 });
  console.log('Playwright:', playwrightVer.trim());
} catch (e) {
  console.log('No playwright:', e.message);
}

try {
  const puppeteerVer = execSync('npx puppeteer --version 2>&1', { encoding: 'utf8', timeout: 5000 });
  console.log('Puppeteer:', puppeteerVer.trim());
} catch (e) {
  console.log('No puppeteer:', e.message);
}
