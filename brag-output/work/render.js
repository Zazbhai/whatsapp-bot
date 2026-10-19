const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const FPS = 30, DURATION = 20, W = 1920, H = 1080, TOTAL = FPS * DURATION;

// Build the full HTML document with inline canvas rendering
function buildHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#06050b;overflow:hidden}
canvas{display:block;width:${W}px;height:${H}px}
</style>
</head>
<body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const C=document.getElementById('c');
const X=C.getContext('2d');
const W=${W},H=${H};
const t=window.__t||0;

// ── Palette ──
const BG='#06050b',PURPLE='#7c3aed',CYAN='#06b6d4',GREEN='#22c55e',AMBER='#f59e0b',WHITE='#f8fafc',MUTED='#94a3b8';

// ── Easing ──
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const lerp=(a,b,u)=>a+(b-a)*u;
const eOut=t=>1-Math.pow(1-t,3);
const eInOut=u=>u<.5?4*u*u*u:1-Math.pow(-2*u+2,3)/2;
const appear=(t,from,to)=>clamp((t-from)/(to-from),0,1);
const hold=(t,from,to,a)=>appear(t,from,to)*(a||1);

// ── Helpers ──
function clear(){X.fillStyle=BG;X.fillRect(0,0,W,H);}

function blob(cx,cy,r,col,phase){
  const p=Math.sin(t*1.5+phase)*.15+.85;
  X.save();X.globalAlpha=.12*p;X.fillStyle=col;
  X.shadowColor=col;X.shadowBlur=r*.6;
  X.beginPath();X.arc(cx,cy,r*p,0,Math.PI*2);X.fill();
  X.restore();
}

function rr(x,y,w,h,r){
  X.beginPath();
  X.moveTo(x+r,y);X.lineTo(x+w-r,y);X.quadraticCurveTo(x+w,y,x+w,y+r);
  X.lineTo(x+w,y+h-r);X.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  X.lineTo(x+r,y+h);X.quadraticCurveTo(x,y+h,x,y+r);
  X.lineTo(x,y+r);X.quadraticCurveTo(x,y,x+r,y);
  X.closePath();
}

function drawPhone(px,py,s,stroke,col,glow){
  X.save();
  if(glow){X.shadowColor=glow;X.shadowBlur=20;}
  X.fillStyle='#12111a';rr(px-s/2,py-s*1.7,s,s*1.7,12);X.fill();
  X.strokeStyle=stroke||WHITE;X.lineWidth=2.5;X.stroke();X.shadowBlur=0;
  X.fillStyle='#0a0914';rr(px-s*.42,py-s*1.52,s*.84,s*1.05,8);X.fill();
  X.fillStyle=col||GREEN;X.globalAlpha=.85;
  X.beginPath();X.arc(px,py-s*.9,s*.12,0,Math.PI*2);X.fill();
  X.globalAlpha=.6;
  for(let i=0;i<3;i++){const bw=s*.035,bh=s*(.08+i*.06);
    X.fillStyle=i===2?col||GREEN:MUTED;X.fillRect(px+s*.28,py-s*1.35-bh,bw,bh);}
  X.restore();
}

function drawSidebar(sx,sy,sw,sh){
  X.save();
  X.fillStyle='rgba(255,255,255,.02)';X.strokeStyle='rgba(255,255,255,.06)';X.lineWidth=1;
  rr(sx,sy,sw,sh,8);X.fill();X.stroke();
  X.fillStyle=PURPLE;X.shadowColor=PURPLE;X.shadowBlur=12;
  X.beginPath();X.arc(sx+30,sy+30,14,0,Math.PI*2);X.fill();X.shadowBlur=0;
  X.fillStyle=WHITE;X.font='bold 16px sans-serif';X.textAlign='left';
  X.fillText('WA Bot Hub',sx+55,sy+35);
  const items=['Dashboard','Auto-Responders','Messenger','Sessions','APK Store'];
  const icons=['◻','◈','→','📱','📦'];
  items.forEach((it,i)=>{
    const iy=sy+65+i*36;const active=i===0;
    X.fillStyle=active?'rgba(124,58,237,.15)':'transparent';
    rr(sx+6,iy,sw-12,30,6);X.fill();
    X.fillStyle=active?PURPLE:MUTED;X.font='14px sans-serif';
    X.fillText(icons[i]+' '+it,sx+18,iy+20);
  });
  X.restore();
}

function sessionGrid(sx,sy,cols,rows,s){
  const gap=16,tw=cols*s+(cols-1)*gap,th=rows*s+(rows-1)*gap;
  const ox=sx+(s-tw)/2,oy=sy+(s-th)/2;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const px=ox+c*(s+gap),py=oy+r*(s+gap);
    const p=Math.sin(t*2+r*.7+c*.5)*.08+.92;
    X.save();X.globalAlpha=p;
    X.fillStyle='#1a1925';rr(px,py,s,s,8);X.fill();
    X.strokeStyle=GREEN;X.lineWidth=1.5;X.shadowColor=GREEN;X.shadowBlur=6;
    X.stroke();X.shadowBlur=0;
    X.fillStyle=GREEN;X.beginPath();X.arc(px+s*.5,py+s*.5,s*.18,0,Math.PI*2);X.fill();
    X.restore();
  }
}

function chatBubble(bx,by,text,col,alpha){
  X.save();X.globalAlpha=alpha;
  X.fillStyle=col||GREEN;X.shadowColor=col||GREEN;X.shadowBlur=8;
  rr(bx,by,420,60,10);X.fill();X.shadowBlur=0;
  X.beginPath();X.moveTo(bx+15,by+60);X.lineTo(bx+30,by+60);X.lineTo(bx+30,by+72);X.fill();
  X.fillStyle=WHITE;X.font='18px sans-serif';X.textAlign='left';
  X.fillText(text,bx+18,by+38);X.restore();
}

function typingDots(tx,ty){
  for(let i=0;i<3;i++){const bob=Math.sin(t*6+i*1.2)*3;
    X.save();X.globalAlpha=.7;X.fillStyle=GREEN;
    X.beginPath();X.arc(tx+i*22,ty+bob,5,0,Math.PI*2);X.fill();X.restore();}
}

function bigText(txt,cx,cy,sz,col,alpha,glow){
  X.save();X.fillStyle=col||WHITE;X.globalAlpha=alpha;
  X.font='bold '+sz+'px "Plus Jakarta Sans",sans-serif';X.textAlign='center';X.textBaseline='middle';
  if(glow){X.shadowColor=glow;X.shadowBlur=25;}
  X.fillText(txt,cx,cy);X.restore();
}

// ═══════════════════════════════════════
// RENDER BASED ON TIME t (0-20)
// ═══════════════════════════════════════
clear();

// Ambient blobs always
blob(W*.3,H*.4,350,PURPLE,0);
blob(W*.7,H*.6,400,CYAN,3);

// S1: Hook 0-2s
{const a=hold(t,0,1.8);
 bigText('One server.',W/2,H/2-40,58,WHITE,a,PURPLE);
 bigText('Unlimited numbers.',W/2,H/2+40,58,GREEN,a,GREEN);
}

// S2: Reveal 2-5s
{const p=(t-2)/3;if(p>0){
  const sl=lerp(-300,0,eOut(clamp(p*1.2,0,1)));
  X.save();X.translate(sl,0);drawSidebar(20,80,240,920);X.restore();
  const ga=eOut(clamp(p*2,0,1));X.save();X.globalAlpha=ga;sessionGrid(300,120,5,3,80);X.restore();
  const ta=eOut(clamp((p-.3)*3,0,1));bigText('WA Bot Hub',W/2+60,70,48,WHITE,ta,PURPLE);
  const sa=eOut(clamp((p-.6)*3,0,1));X.save();X.globalAlpha=sa;X.fillStyle=MUTED;X.font='22px sans-serif';X.textAlign='center';
  X.fillText('Manage everything. Zero downtime.',W/2+60,110);X.restore();
}}

// S3: Auto-rotation 5-10s
{const p=(t-5)/5;
  const ba=eOut(clamp(p*2,0,1));X.save();X.globalAlpha=ba;sessionGrid(400,200,4,2,70);X.restore();
  drawPhone(550,560,140,'#f43f5e','#f43f5e');bigText('Logged out',550,420,28,'#ff6b6b',eOut(clamp(p*3,0,1)));
  const ap=eInOut(clamp((p-.25)*2.5,0,1));
  X.save();X.globalAlpha=eOut(clamp((p-.1)*4,0,1));
  X.strokeStyle=AMBER;X.lineWidth=4;X.shadowColor=AMBER;X.shadowBlur=10;
  X.beginPath();X.moveTo(650,540);const mx=lerp(650,950,ap);X.quadraticCurveTo(mx,490-30*Math.sin(ap*Math.PI),950,540);X.stroke();
  if(ap>.7){const hp=(ap-.7)/.3;X.fillStyle=AMBER;X.beginPath();X.moveTo(950,525);X.lineTo(950+25*hp,540);X.lineTo(950,555);X.fill();}
  X.restore();
  drawPhone(950,560,140,GREEN,GREEN);bigText('Auto-rotated',950,420,28,GREEN,eOut(clamp((p-.35)*3,0,1)));
  bigText('No downtime. Always connected.',W/2+200,950,28,MUTED,eOut(clamp((p-.5)*3,0,1)));
}

// S4: Telegram 10-15s
{const p=(t-10)/5;
  const pa=eOut(clamp(p*2.5,0,1));X.save();X.globalAlpha=pa;
  X.fillStyle='#12111a';X.strokeStyle=CYAN;X.lineWidth=3;X.shadowColor=CYAN;X.shadowBlur=15;
  rr(1200,100,280,880,24);X.fill();X.stroke();X.shadowBlur=0;
  X.fillStyle='#059669';rr(1205,105,270,50,20);X.fill();
  X.fillStyle=WHITE;X.font='bold 20px sans-serif';X.textAlign='center';
  X.fillText('🤖 WA Bot Hub',1340,136);
  const bubbles=[
    {y:190,text:'/addsession',t:.05,c:GREEN},
    {y:270,text:'📱 Adding session...',t:.25,c:GREEN},
    {y:370,text:'📦 upload apk',t:.45,c:'#059669'},
    {y:470,text:'🎁 BLINK50 → delivered',t:.65,c:GREEN},
    {y:570,text:'👥 47 sessions online',t:.85,c:CYAN},
  ];
  bubbles.forEach(b=>{const a=eOut(clamp((p-b.t)*3.5,0,1));if(a>0)chatBubble(1220,b.y,b.text,b.c,a);});
  const da=eOut(clamp((p-.7)*4,0,1));if(da>0)typingDots(1220,670);
  X.restore();
  bigText('Manage everything from Telegram.',W/2+200,970,26,MUTED,eOut(clamp((p-.3)*3,0,1)));
}

// S5: AI + Coupons 15-18s
{const p=(t-15)/3;
  const ca=eOut(clamp(p*3,0,1));X.save();X.globalAlpha=ca;
  X.fillStyle='#12111a';X.strokeStyle=AMBER;X.lineWidth=2.5;X.shadowColor=AMBER;X.shadowBlur=18;
  rr(1150,150,580,600,16);X.fill();X.stroke();X.shadowBlur=0;
  X.fillStyle=AMBER;X.font='bold 34px sans-serif';X.textAlign='center';
  X.fillText('🎁 Coupon Pool',1440,220);
  const coa=eOut(clamp((p-.15)*4,0,1));X.save();X.globalAlpha=coa;
  X.fillStyle=WHITE;X.font='bold 48px monospace';X.fillText('BLINK50',1440,300);X.restore();
  const prog=eOut(clamp((p-.35)*2.5,0,1));
  X.fillStyle='#2a2938';rr(1260,360,420,14,7);X.fill();
  X.fillStyle=GREEN;X.shadowColor=GREEN;X.shadowBlur=8;rr(1260,360,420*prog,14,7);X.fill();X.shadowBlur=0;
  const dna=eOut(clamp((p-.65)*4,0,1));if(dna>0){X.save();X.globalAlpha=dna;X.fillStyle=GREEN;X.font='bold 40px sans-serif';X.fillText('✅ Delivered',1440,450);X.restore();}
  X.fillStyle=MUTED;X.font='18px sans-serif';X.fillText('6h connection → automatic delivery',1440,520);
  const aia=eOut(clamp((p-.2)*4,0,1));X.save();X.globalAlpha=aia;
  X.fillStyle=PURPLE;X.shadowColor=PURPLE;X.shadowBlur=10;rr(1260,550,80,36,8);X.fill();X.shadowBlur=0;
  X.fillStyle=WHITE;X.font='bold 15px sans-serif';X.fillText('AI',1300,573);
  X.fillStyle=MUTED;X.font='16px sans-serif';X.fillText('Smart auto-replies',1390,576);X.restore();
  X.restore();
}

// S6: Punchline 18-20s
{const p=(t-18)/2;
  const ga=eOut(clamp(p*3,0,1));X.save();X.globalAlpha=ga;sessionGrid(500,100,6,3,60);X.restore();
  const words=['Build it.','Ship it.','Let it run.'];
  words.forEach((w,i)=>{const a=eOut(clamp((p-i*.15)*4,0,1));bigText(w,W/2,H/2-60+i*55,44,WHITE,a,GREEN);});
  const cta=eOut(clamp((p-.4)*3.5,0,1));if(cta>0){X.save();X.globalAlpha=cta;
    X.fillStyle=GREEN;X.shadowColor=GREEN;X.shadowBlur=12;rr(W/2-240,H/2+120,480,52,12);X.fill();X.shadowBlur=0;
    X.fillStyle=BG;X.font='bold 24px sans-serif';X.textAlign='center';
    X.fillText('github.com/Zazbhai/whatsapp-bot',W/2,H/2+148);X.restore();}
}

window.__renderDone=true;
</script>
</body>
</html>`;
}

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  const html = buildHTML();
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html), { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  const frameDir = path.join(ROOT, 'frames');
  fs.mkdirSync(frameDir, { recursive: true });

  console.log(`Rendering ${TOTAL} frames at 30fps...`);
  for (let frame = 0; frame < TOTAL; frame++) {
    const frameTime = frame / FPS;
    await page.evaluate((ft) => { window.__t = ft; (new Function(document.querySelector('script').textContent))(); }, frameTime);

    // Wait for canvas to have actual rendered pixels
    await page.evaluate(() => new Promise(r => {
      const ctx = document.getElementById('c').getContext('2d');
      let tries = 0;
      const check = () => {
        try {
          const d = ctx.getImageData(0, 0, 10, 10);
          if (d.data.some(v => v > 0) || tries > 10) { r(); return; }
        } catch(e) { r(); return; }
        tries++; setTimeout(check, 20);
      };
      check();
    }));

    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    fs.writeFileSync(path.join(frameDir, `${String(frame).padStart(6, '0')}.png`), buf);
    if (frame % 60 === 0) console.log(`  ${frame}/${TOTAL} (${((frame/TOTAL)*100).toFixed(0)}%)`);
  }

  await browser.close();
  console.log(`Done. ${TOTAL} frames in ${frameDir}/`);
  return frameDir;
}

main().catch(e => { console.error(e); process.exit(1); });
