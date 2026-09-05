import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const API_URL = process.env.WORKER_API_URL;
const TOKEN = process.env.WORKER_TOKEN;
const WORKER_ID = process.env.WORKER_ID || `splatt-render-${os.hostname()}`;
const POLL_MS = Number(process.env.POLL_MS || 3000);
const MAX_RETRIES = 3;

if (!API_URL || !TOKEN) throw new Error('WORKER_API_URL and WORKER_TOKEN are required');

const ASSETS = {
  noslimethemovie: new URL('./assets/overlay_noslimethemovie.png', import.meta.url).pathname,
  saucewalka102: new URL('./assets/overlay_saucewalka102.png', import.meta.url).pathname,
  voochiep: new URL('./assets/overlay_voochiep.png', import.meta.url).pathname,
};

const OUTRO = new URL('./assets/splatt_kick_outro.mp4', import.meta.url).pathname;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function call(action, body = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-token': TOKEN,
    },
    body: JSON.stringify({ action, worker_id: WORKER_ID, ...body }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(`worker-api ${res.status}: ${data?.error || text}`);
  return data;
}

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`spawn ${cmd} failed: ${e.message}`));
    }

    let stdout = '';
    let stderr = '';

    p.stdout.on('data', d => (stdout += d.toString()));
    p.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    p.on('error', e => {
      reject(new Error(`${cmd} error: ${e.message}`));
    });

    p.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(new Error(`${cmd} terminated by signal ${signal}. stderr: ${stderr.slice(-2000)}`));
      } else {
        reject(new Error(`${cmd} exited ${code}. stderr: ${stderr.slice(-2000)}`));
      }
    });
  });
}

async function probeDuration(file) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        file,
      ]);
    } catch (e) {
      return reject(new Error(`spawn ffprobe failed: ${e.message}`));
    }

    let out = '',
      err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => reject(new Error(`ffprobe error: ${e.message}`)));
    p.on('close', (c, sig) => {
      if (c === 0) {
        resolve(Number(out.trim()));
      } else if (sig) {
        reject(new Error(`ffprobe terminated by signal ${sig}: ${err}`));
      } else {
        reject(new Error(`ffprobe exited ${c}: ${err}`));
      }
    });
  });
}

async function uploadSigned(pathName, token, filePath) {
  const direct = API_URL.replace('/functions/v1/clip-workstation-worker-api', '');
  const url = `${direct}/storage/v1/object/upload/sign/clip-workstation-output/${encodeURI(pathName)}?token=${encodeURIComponent(token)}`;
  const size = (await stat(filePath)).size;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(size),
      'x-upsert': 'false',
    },
    body: Readable.toWeb(createReadStream(filePath)),
    duplex: 'half',
  });
  if (!res.ok) throw new Error(`storage upload ${res.status}: ${await res.text()}`);
  return size;
}

async function validateAssets() {
  try {
    await access(OUTRO);
    for (const [slug, assetPath] of Object.entries(ASSETS)) {
      await access(assetPath);
    }
    console.log('✓ All assets validated');
  } catch (e) {
    throw new Error(`Asset validation failed: ${e.message}`);
  }
}

async function renderPreview(job) {
  const sourceUrl = job.source_media_url || job.source_url;
  if (!sourceUrl) throw new Error('No source URL provided');

  const tmp = path.join(os.tmpdir(), `preview-${job.id}-${crypto.randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  const out = path.join(tmp, 'preview.mp4');

  // Probe duration first
  const dur = await probeDuration(sourceUrl);
  if (!(dur > 0 && dur <= 176))
    throw new Error(`Invalid source duration ${dur}`);

  // Calculate dynamic bitrate to stay under 8.5 MB
  const targetBits = 8.5 * 1024 * 1024 * 8; // bits
  const audioBits = 64000;
  const videoBps = Math.max(250000, Math.min(1200000, Math.floor((targetBits / dur) - audioBits)));

  console.log(`[preview] job=${job.id} dur=${dur.toFixed(2)}s video_bps=${videoBps}`);

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-i',
    sourceUrl,
    '-vf',
    'scale=640:360:force_original_aspect_ratio=increase,crop=640:360,setsar=1,fps=30',
    '-c:v',
    'libx264',
    '-b:v',
    String(videoBps),
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-movflags',
    '+faststart',
    '-y',
    out,
  ];

  await run('ffmpeg', args);
  const size = (await stat(out)).size;
  if (size > 9000000)
    throw new Error(`Preview size ${size} exceeds 9 MB limit`);

  console.log(`[preview] success job=${job.id} size=${(size / 1024 / 1024).toFixed(2)}MB`);
  return { tmp, out, size };
}

async function renderFinal(job, template) {
  const overlay = ASSETS[String(job.creator_slug).toLowerCase()];
  if (!overlay) throw new Error(`No overlay mapped for ${job.creator_slug}`);

  const dur = Number(job.source_duration_seconds);
  if (!(dur > 0 && dur <= 176))
    throw new Error(`Invalid source duration ${dur}`);

  const tmp = path.join(os.tmpdir(), `splatt-${job.id}-${crypto.randomUUID()}`);
  await mkdir(tmp, { recursive: true });
  const out = path.join(tmp, 'final.mp4');

  const y = Number(template?.foreground_y ?? 580);
  const ox = Number(template?.overlay_x ?? 70);
  const oy = Number(template?.overlay_y ?? 1200);
  const ow = Number(template?.overlay_width ?? 780);
  const sigma = Number(template?.blur_sigma ?? 32);

  // Optimized filter graph with low-res blurred background:
  // 1. Scale background to 540x960, apply blur there (lower memory)
  // 2. Upscale back to 1080x1920 before compositing
  // 3. Composite foreground and overlays at final resolution
  const graph = [
    `[0:v]trim=duration=${dur},setpts=PTS-STARTPTS,split=2[fg0][bg0]`,
    // Background: downscale for blur, apply gblur, then upscale for compositing
    `[bg0]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,setsar=1,gblur=sigma=${sigma},scale=1080:1920:flags=lanczos,setsar=1,fps=30[bg]`,
    // Foreground: scale to final width, maintain aspect
    `[fg0]scale=1080:-2:flags=lanczos,setsar=1,fps=30[fg]`,
    // Composite foreground over blurred background
    `[bg][fg]overlay=(W-w)/2:${y}:shortest=1[base]`,
    // Creator overlay/brand
    `[1:v]scale=${ow}:-2:flags=lanczos,setsar=1[brand]`,
    `[base][brand]overlay=${ox}:${oy}:shortest=1,setsar=1[srcv]`,
    // Audio: trim to source duration
    `[0:a]atrim=duration=${dur},asetpts=PTS-STARTPTS[srca]`,
    // Outro video and audio at final resolution
    `[2:v]scale=1080:1920:flags=lanczos,setsar=1,fps=30,setpts=PTS-STARTPTS[outv]`,
    `[2:a]asetpts=PTS-STARTPTS[outa]`,
    // Concatenate source and outro
    `[srcv][srca][outv][outa]concat=n=2:v=1:a=1[v][a]`,
  ].join(';');

  // FFmpeg args: veryfast preset, 2 threads, no bufsize (managed by codec)
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-threads',
    '2',
    '-i',
    job.source_media_url || job.source_url,
    '-loop',
    '1',
    '-i',
    overlay,
    '-i',
    OUTRO,
    '-filter_complex',
    graph,
    '-filter_threads',
    '2',
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',  // Fast enough, lower CPU than "fast"
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-y',
    out,
  ];

  console.log(`[final] job=${job.id} creator=${job.creator_slug} dur=${dur}s`);
  await run('ffmpeg', args);
  const finalDur = await probeDuration(out);
  if (finalDur > 180.05)
    throw new Error(`Rendered duration ${finalDur.toFixed(2)} exceeds 3:00`);

  console.log(`[final] success job=${job.id} finalDur=${finalDur.toFixed(2)}s`);
  return { tmp, out, finalDur };
}

let busy = false;

async function processPreview() {
  try {
    const p = await call('preview_claim');
    if (!p.job) return; // No preview job

    const job = p.job;
    let hb = setInterval(
      () => call('preview_heartbeat', { job_id: job.id }).catch(() => {}),
      30000
    );
    let tmp;

    try {
      const r = await renderPreview(job);
      tmp = r.tmp;
      const prep = await call('preview_prepare_upload', { job_id: job.id });
      await uploadSigned(prep.path, prep.token, r.out);
      await call('preview_complete', {
        job_id: job.id,
        preview_storage_path: prep.path,
        preview_size_bytes: r.size,
      });
      console.log(`✓ preview complete ${job.id} ${(r.size / 1024 / 1024).toFixed(2)}MB`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`✗ preview failed ${job.id}: ${msg}`);
      await call('preview_fail', {
        job_id: job.id,
        error_message: msg,
      }).catch(() => {});
    } finally {
      clearInterval(hb);
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    // Silently skip preview processing if claim fails (no preview work available)
  }
}

async function processFinal() {
  try {
    const c = await call('claim');
    if (!c.job) return false; // No final job

    busy = true;
    const job = c.job;
    let hb = setInterval(
      () => call('heartbeat', { job_id: job.id }).catch(() => {}),
      30000
    );
    let tmp;
    let attempts = 0;

    while (attempts < MAX_RETRIES) {
      try {
        const r = await renderFinal(job, c.template || {});
        tmp = r.tmp;
        const prep = await call('prepare_upload', { job_id: job.id });
        const size = await uploadSigned(prep.path, prep.token, r.out);
        await call('complete', {
          job_id: job.id,
          output_storage_path: prep.path,
          output_duration_seconds: r.finalDur,
          output_size_bytes: size,
        });
        console.log(
          `✓ complete ${job.id} ${job.creator_slug} ${r.finalDur.toFixed(2)}s`
        );
        break; // Success
      } catch (e) {
        attempts++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[attempt ${attempts}/${MAX_RETRIES}] job=${job.id} error: ${msg}`);

        if (attempts >= MAX_RETRIES) {
          console.error(`✗ failed ${job.id} after ${MAX_RETRIES} attempts`);
          await call(
            'fail',
            {
              job_id: job.id,
              error_message: `Render failed after ${MAX_RETRIES} attempts: ${msg}`,
            }
          ).catch(() => {});
        } else {
          // Exponential backoff before retry
          await sleep(2000 * attempts);
        }
      }
    }

    clearInterval(hb);
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    busy = false;
    return true;
  } catch (e) {
    console.error('[poll]', e instanceof Error ? e.message : e);
    return false;
  }
}

async function loop() {
  // Validate assets on startup
  try {
    await validateAssets();
  } catch (e) {
    console.error('FATAL: Asset validation failed:', e);
    process.exit(1);
  }

  while (true) {
    if (busy) {
      await sleep(500);
      continue;
    }

    // Process preview jobs first for faster Discord availability
    await processPreview();

    // Then process final render jobs
    const hadFinalJob = await processFinal();

    // If no work, wait before polling again
    if (!hadFinalJob) {
      await sleep(POLL_MS);
    }
  }
}

loop();

