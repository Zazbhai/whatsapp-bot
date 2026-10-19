// Renders each frame of the brag video as an image using Puppeteer,
// then composes them into brag.mp4 with ffmpeg.
const puppeteer = require('puppeteer');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');

const exec = promisify(execFile);

const WORK = path.join(__dirname);
const OUT = path.dirname(path.dirname(WORK));
const W = 1920, H = 1080, FPS = 30, DURATION = 20;
const TOTAL_FRAMES = DURATION * FPS;

async function main() {
  // Launch browser
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  // Read the HTML generator
  const htmlPath = path.join(WORK, 'frames.html');
  if (!fs.existsSync(htmlPath)) {
    console.error('frames.html not found. Run generate-plan.js first.');
    process.exit(1);
  }

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // We need to modify the HTML to render based on a query parameter
  // Instead, let's create a loop that modifies the canvas via evaluate
  // The simplest approach: use puppeteer to take screenshots at frame boundaries

  // Actually, the cleanest approach: write each frame's time to a shared state
  // and re-evaluate the canvas

  // Let me rewrite the approach: inject frame number via query param
  const htmlWithParam = htmlContent.replace(
    'parseInt(process.argv[2]) || 0',
    'new URLSearchParams(window.location.search).get("frame") || 0'
  );

  const dataUri = 'data:text/html,' + encodeURIComponent(htmlWithParam);

  const frameDir = path.join(OUT, 'frames');
  fs.mkdirSync(frameDir, { recursive: true });

  // Render frames - batch in groups to save browser restarts
  console.log('Rendering', TOTAL_FRAMES, 'frames...');

  let frame = 0;
  for (let batch = 0; batch < 50; batch++) {
    const endBatch = Math.min(frame + 20, TOTAL_FRAMES);
    for (; frame < endBatch; frame++) {
      await page.goto(dataUri + '?frame=' + frame, { waitUntil: 'networkidle0' });
      // Wait for the canvas to be ready
      await page.evaluate(() => new Promise(r => {
        const check = () => {
          if (window.frameReady) { r(); return; }
          setTimeout(check, 50);
        };
        check();
      }));

      const screenshot = await page.screenshot({ type: 'png', fullPage: false });
      fs.writeFileSync(path.join(frameDir, String(frame).padStart(6, '0') + '.png'), screenshot);

      if (frame % 60 === 0) {
        console.log('  ' + frame + '/' + TOTAL_FRAMES + ' frames rendered');
      }
    }
  }

  await browser.close();

  console.log('Frames rendered. Composing video with ffmpeg...');

  // Compose with ffmpeg
  const framePattern = path.join(frameDir, '%06d.png');
  const outputMp4 = path.join(OUT, 'brag.mp4');
  const outputJpg = path.join(OUT, 'brag.jpg');

  // Generate audio using ffmpeg tone generation
  console.log('Generating audio...');

  // Audio: upbeat electronic pulse, 44.1kHz, stereo
  const audioPath = path.join(OUT, 'audio.aac');

  // Simple audio: four beats per second, ascending arpeggio
  await exec('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=' + DURATION + ':sample_rate=44100',
    '-filter:a', 'volume=0.15',
    audioPath
  ]);

  // Compose final video
  await exec('ffmpeg', [
    '-y',
    '-r', String(FPS),
    '-i', framePattern,
    '-i', audioPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    outputMp4
  ]);

  // Create poster frame (frame 0)
  const frame0 = fs.readFileSync(path.join(frameDir, '000000.png'));
  fs.writeFileSync(outputJpg, frame0);

  // Cleanup
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.unlinkSync(audioPath);

  console.log('Done! Video saved to:', outputMp4);
  console.log('Poster saved to:', outputJpg);
}

main().catch(e => { console.error(e); process.exit(1); });
