import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const API_URL = process.env.WORKER_API_URL;
const TOKEN = process.env.WORKER_TOKEN;
const WORKER_ID =
  process.env.WORKER_ID || `splatt-render-${os.hostname()}`;
const POLL_MS = Number(process.env.POLL_MS || 3000);
const MAX_RETRIES = 3;

if (!API_URL || !TOKEN) {
  throw new Error(
    'WORKER_API_URL and WORKER_TOKEN are required'
  );
}

const ASSETS = {
  noslimethemovie: new URL(
    './assets/overlay_noslimethemovie.png',
    import.meta.url
  ).pathname,

  saucewalka102: new URL(
    './assets/overlay_saucewalka102.png',
    import.meta.url
  ).pathname,

  voochiep: new URL(
    './assets/overlay_voochiep.png',
    import.meta.url
  ).pathname,
};

const OUTROS = {
  saucewalka102: new URL(
    './assets/splatt_kick_outro.mp4',
    import.meta.url
  ).pathname,

  voochiep: new URL(
    './assets/outro_voochiep.mp4',
    import.meta.url
  ).pathname,

  noslimethemovie: new URL(
    './assets/outro_noslimethemovie.mp4',
    import.meta.url
  ).pathname,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCreatorSlug(job) {
  return String(job?.creator_slug || '')
    .trim()
    .toLowerCase();
}

function getOverlay(job) {
  const creator = getCreatorSlug(job);
  const overlay = ASSETS[creator];

  if (!overlay) {
    throw new Error(
      `No overlay mapped for creator ${creator || 'unknown'}`
    );
  }

  return overlay;
}

function getOutro(job) {
  const creator = getCreatorSlug(job);
  const outro = OUTROS[creator];

  if (!outro) {
    throw new Error(
      `No outro mapped for creator ${creator || 'unknown'}`
    );
  }

  return outro;
}

async function call(action, body = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',

    headers: {
      'content-type': 'application/json',
      'x-worker-token': TOKEN,
    },

    body: JSON.stringify({
      action,
      worker_id: WORKER_ID,
      ...body,
    }),
  });

  const text = await res.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      error: text,
    };
  }

  if (!res.ok) {
    throw new Error(
      `worker-api ${res.status}: ${
        data?.error || text
      }`
    );
  }

  return data;
}

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    let p;

    try {
      p = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(
        new Error(
          `spawn ${cmd} failed: ${e.message}`
        )
      );
    }

    let stdout = '';
    let stderr = '';

    p.stdout.on('data', d => {
      stdout += d.toString();
    });

    p.stderr.on('data', d => {
      stderr += d.toString();

      if (stderr.length > 16000) {
        stderr = stderr.slice(-16000);
      }
    });

    p.on('error', e => {
      reject(
        new Error(`${cmd} error: ${e.message}`)
      );
    });

    p.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      if (signal) {
        reject(
          new Error(
            `${cmd} terminated by signal ${signal}. stderr: ${stderr.slice(
              -2000
            )}`
          )
        );

        return;
      }

      reject(
        new Error(
          `${cmd} exited ${code}. stderr: ${stderr.slice(
            -2000
          )}`
        )
      );
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
      return reject(
        new Error(
          `spawn ffprobe failed: ${e.message}`
        )
      );
    }

    let out = '';
    let err = '';

    p.stdout.on('data', d => {
      out += d.toString();
    });

    p.stderr.on('data', d => {
      err += d.toString();
    });

    p.on('error', e => {
      reject(
        new Error(
          `ffprobe error: ${e.message}`
        )
      );
    });

    p.on('close', (code, signal) => {
      if (code === 0) {
        const duration = Number(
          out.trim()
        );

        if (!Number.isFinite(duration)) {
          reject(
            new Error(
              `ffprobe returned invalid duration: ${out}`
            )
          );

          return;
        }

        resolve(duration);
        return;
      }

      if (signal) {
        reject(
          new Error(
            `ffprobe terminated by signal ${signal}: ${err}`
          )
        );

        return;
      }

      reject(
        new Error(
          `ffprobe exited ${code}: ${err}`
        )
      );
    });
  });
}

async function uploadSigned(
  pathName,
  token,
  filePath
) {
  const direct = API_URL.replace(
    '/functions/v1/clip-workstation-worker-api',
    ''
  );

  const url =
    `${direct}/storage/v1/object/upload/sign/clip-workstation-output/` +
    `${encodeURI(pathName)}` +
    `?token=${encodeURIComponent(token)}`;

  const size = (
    await stat(filePath)
  ).size;

  const res = await fetch(url, {
    method: 'PUT',

    headers: {
      'content-type': 'video/mp4',
      'content-length': String(size),
      'x-upsert': 'false',
    },

    body: Readable.toWeb(
      createReadStream(filePath)
    ),

    duplex: 'half',
  });

  if (!res.ok) {
    throw new Error(
      `storage upload ${res.status}: ${await res.text()}`
    );
  }

  return size;
}

async function validateAssets() {
  const required = [
    ...Object.entries(ASSETS).map(
      ([creator, file]) => ({
        type: 'overlay',
        creator,
        file,
      })
    ),

    ...Object.entries(OUTROS).map(
      ([creator, file]) => ({
        type: 'outro',
        creator,
        file,
      })
    ),
  ];

  for (const item of required) {
    try {
      await access(item.file);
    } catch (e) {
      throw new Error(
        `Missing ${item.type} for ${item.creator}: ${item.file}`
      );
    }
  }

  console.log(
    '✓ Creator overlays and creator outros validated'
  );

  for (const creator of Object.keys(
    ASSETS
  )) {
    console.log(
      `✓ ${creator}: overlay + outro ready`
    );
  }
}

/**
 * Render preview clip with adaptive resolution/fps/bitrate.
 * Target: ≤8.5MB (hard cap 9MB) for full clip duration up to 176s.
 * 
 * Strategy:
 * ≤60s: 480p @ 30fps
 * 60-120s: 480p @ 24fps (or 360p @ 30fps)
 * >120s: 360p @ 20fps
 * 
 * Audio: AAC 48-64kbps
 * Video bitrate: calculated to fit target with buffer
 */
async function renderPreview(job) {
  const dur = Number(
    job.source_duration_seconds
  );

  if (
    !(dur > 0 && dur <= 176)
  ) {
    throw new Error(
      `Invalid source duration ${dur}`
    );
  }

  const source =
    job.source_media_url ||
    job.source_url;

  if (!source) {
    throw new Error(
      'Job has no source media URL'
    );
  }

  const tmp = path.join(
    os.tmpdir(),

    `splatt-preview-${job.id}-${crypto.randomUUID()}`
  );

  await mkdir(tmp, {
    recursive: true,
  });

  const out = path.join(
    tmp,
    'preview.mp4'
  );

  // Adaptive encoding based on duration
  let resolution = '640:360';
  let fps = 30;
  let audioBitrate = 56;

  if (dur <= 60) {
    // ≤60s: 480p @ 30fps
    resolution = '854:480';
    fps = 30;
    audioBitrate = 64;
  } else if (dur <= 120) {
    // 60-120s: 480p @ 24fps
    resolution = '854:480';
    fps = 24;
    audioBitrate = 56;
  } else {
    // >120s: 360p @ 20fps
    resolution = '640:360';
    fps = 20;
    audioBitrate = 48;
  }

  // Calculate video bitrate from 8.5MB target
  // 8500000 bytes = 8500000 * 8 bits = 68,000,000 bits
  // Over duration in seconds, minus audio allocation
  const targetBytes = 8500000;
  const totalBitsAvailable = targetBytes * 8;
  const audioTotalBits = audioBitrate * 1000 * dur;
  const videoTotalBits = totalBitsAvailable - audioTotalBits;
  let videoBitrate = Math.floor(videoTotalBits / (dur * 1000));

  // Ensure reasonable minimums
  videoBitrate = Math.max(200, Math.min(2500, videoBitrate));

  // Add -maxrate and -bufsize for constrained bitrate
  const maxrate = Math.floor(videoBitrate * 1.2);
  const bufsize = Math.floor(videoBitrate * 2);

  const args = [
    '-hide_banner',

    '-loglevel',
    'warning',

    '-threads',
    '2',

    '-filter_threads',
    '2',

    '-i',
    source,

    '-vf',
    `scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setsar=1`,

    '-c:v',
    'libx264',

    '-preset',
    'veryfast',

    '-b:v',
    `${videoBitrate}k`,

    '-maxrate',
    `${maxrate}k`,

    '-bufsize',
    `${bufsize}k`,

    '-pix_fmt',
    'yuv420p',

    '-c:a',
    'aac',

    '-b:a',
    `${audioBitrate}k`,

    '-movflags',
    '+faststart',

    '-y',
    out,
  ];

  console.log(
    `[preview] job=${job.id} dur=${dur.toFixed(
      2
    )}s res=${resolution} fps=${fps} vbitrate=${videoBitrate}k abitrate=${audioBitrate}k`
  );

  await run('ffmpeg', args);

  const outputStat = await stat(out);

  if (!outputStat.size) {
    throw new Error(
      'Rendered preview file is empty'
    );
  }

  const sizeBytes = outputStat.size;

  if (sizeBytes > 9000000) {
    throw new Error(
      `Preview size ${(sizeBytes / 1024 / 1024).toFixed(
        2
      )}MB exceeds 9MB limit`
    );
  }

  console.log(
    `[preview] success job=${job.id} size=${(
      sizeBytes /
      1024 /
      1024
    ).toFixed(2)}MB`
  );

  return {
    tmp,
    out,
    sizeBytes,
  };
}

/**
 * Render final clip with creator overlay and outro.
 * Preserves current behavior for all three creators.
 */
async function render(
  job,
  template
) {
  const creator =
    getCreatorSlug(job);

  const overlay =
    getOverlay(job);

  const outro =
    getOutro(job);

  const dur = Number(
    job.source_duration_seconds
  );

  if (
    !(dur > 0 && dur <= 176)
  ) {
    throw new Error(
      `Invalid source duration ${dur}`
    );
  }

  const source =
    job.source_media_url ||
    job.source_url;

  if (!source) {
    throw new Error(
      'Job has no source media URL'
    );
  }

  const tmp = path.join(
    os.tmpdir(),

    `splatt-${job.id}-${crypto.randomUUID()}`
  );

  await mkdir(tmp, {
    recursive: true,
  });

  const out = path.join(
    tmp,
    'final.mp4'
  );

  const y = Number(
    template?.foreground_y ??
      580
  );

  const ox = Number(
    template?.overlay_x ??
      70
  );

  const oy = Number(
    template?.overlay_y ??
      1200
  );

  const ow = Number(
    template?.overlay_width ??
      780
  );

  const sigma = Number(
    template?.blur_sigma ??
      32
  );

  const outroDur =
    await probeDuration(outro);

  console.log(
    `[render] creator=${creator} source=${dur.toFixed(
      2
    )}s outro=${outroDur.toFixed(
      2
    )}s`
  );

  if (
    dur + outroDur >
    180.05
  ) {
    throw new Error(
      `Source ${dur.toFixed(
        2
      )}s + outro ${outroDur.toFixed(
        2
      )}s exceeds 3:00`
    );
  }

  const graph = [
    `[0:v]trim=duration=${dur},setpts=PTS-STARTPTS,split=2[fg0][bg0]`,

    `[bg0]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,setsar=1,gblur=sigma=${Math.max(
      8,
      sigma / 2
    )},scale=1080:1920:flags=bilinear,fps=30[bg]`,

    `[fg0]scale=1080:-2:flags=lanczos,setsar=1,fps=30[fg]`,

    `[bg][fg]overlay=(W-w)/2:${y}:shortest=1[base]`,

    `[1:v]scale=${ow}:-2:flags=lanczos,setsar=1[brand]`,

    `[base][brand]overlay=${ox}:${oy}:shortest=1,setsar=1[srcv]`,

    `[0:a]atrim=duration=${dur},asetpts=PTS-STARTPTS[srca]`,

    `[2:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,setpts=PTS-STARTPTS[outv]`,

    `[2:a]asetpts=PTS-STARTPTS[outa]`,

    `[srcv][srca][outv][outa]concat=n=2:v=1:a=1[v][a]`,
  ].join(';');

  const args = [
    '-hide_banner',

    '-loglevel',
    'warning',

    '-threads',
    '2',

    '-filter_threads',
    '2',

    '-i',
    source,

    '-loop',
    '1',

    '-i',
    overlay,

    '-i',
    outro,

    '-filter_complex',
    graph,

    '-map',
    '[v]',

    '-map',
    '[a]',

    '-c:v',
    'libx264',

    '-preset',
    'veryfast',

    '-crf',
    '21',

    '-pix_fmt',
    'yuv420p',

    '-r',
    '30',

    '-c:a',
    'aac',

    '-b:a',
    '128k',

    '-movflags',
    '+faststart',

    '-y',
    out,
  ];

  console.log(
    `[render] job=${job.id} creator=${creator} dur=${dur}s`
  );

  console.log(
    `[render] overlay=${path.basename(
      overlay
    )}`
  );

  console.log(
    `[render] outro=${path.basename(
      outro
    )}`
  );

  await run(
    'ffmpeg',
    args
  );

  const finalDur =
    await probeDuration(out);

  if (
    finalDur >
    180.05
  ) {
    throw new Error(
      `Rendered duration ${finalDur.toFixed(
        2
      )} exceeds 3:00`
    );
  }

  const outputStat =
    await stat(out);

  if (
    !outputStat.size
  ) {
    throw new Error(
      'Rendered file is empty'
    );
  }

  console.log(
    `[render] success job=${job.id} creator=${creator} finalDur=${finalDur.toFixed(
      2
    )}s size=${(
      outputStat.size /
      1024 /
      1024
    ).toFixed(2)}MB`
  );

  return {
    tmp,
    out,
    finalDur,
  };
}

let busy = false;

/**
 * Process preview job: render, upload, and report completion.
 * Do not mark "do_not_reclaim" in local state — rely on API to stop reclaims.
 */
async function processPreviewJob(
  job
) {
  let heartbeat;

  let tmp;

  let attempts = 0;

  try {
    heartbeat = setInterval(
      () =>
        call('preview_heartbeat', {
          job_id: job.id,
        }).catch(() => {}),
      30000
    );

    while (
      attempts < MAX_RETRIES
    ) {
      try {
        const result =
          await renderPreview(job);

        tmp = result.tmp;

        const prep =
          await call(
            'preview_prepare_upload',
            {
              job_id:
                job.id,
            }
          );

        const size =
          await uploadSigned(
            prep.path,
            prep.token,
            result.out
          );

        // FIX: Use correct field names for preview_complete
        await call(
          'preview_complete',
          {
            job_id:
              job.id,

            preview_storage_path:
              prep.path,

            preview_size_bytes:
              size,
          }
        );

        console.log(
          `✓ preview complete ${job.id} ${(size / 1024 / 1024).toFixed(2)}MB`
        );

        return;
      } catch (e) {
        attempts++;

        const msg =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          `[preview attempt ${attempts}/${MAX_RETRIES}] job=${job.id} error: ${msg}`
        );

        if (
          attempts >=
          MAX_RETRIES
        ) {
          console.error(
            `✗ preview failed ${job.id} after ${MAX_RETRIES} attempts`
          );

          await call(
            'preview_fail',
            {
              job_id:
                job.id,

              error_message:
                `Preview failed after ${MAX_RETRIES} attempts: ${msg}`,
            }
          ).catch(() => {});

          return;
        }

        if (tmp) {
          await rm(tmp, {
            recursive: true,
            force: true,
          }).catch(() => {});

          tmp = undefined;
        }

        await sleep(
          2000 * attempts
        );
      }
    }
  } finally {
    if (heartbeat) {
      clearInterval(
        heartbeat
      );
    }

    if (tmp) {
      await rm(tmp, {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }
}

/**
 * Process final render job: render with overlay/outro, upload, and report completion.
 */
async function processJob(
  job,
  template
) {
  let heartbeat;

  let tmp;

  let attempts = 0;

  try {
    heartbeat = setInterval(
      () =>
        call('heartbeat', {
          job_id: job.id,
        }).catch(() => {}),
      30000
    );

    while (
      attempts < MAX_RETRIES
    ) {
      try {
        const result =
          await render(
            job,
            template || {}
          );

        tmp = result.tmp;

        const prep =
          await call(
            'prepare_upload',
            {
              job_id:
                job.id,
            }
          );

        const size =
          await uploadSigned(
            prep.path,
            prep.token,
            result.out
          );

        await call(
          'complete',
          {
            job_id:
              job.id,

            output_storage_path:
              prep.path,

            output_duration_seconds:
              result.finalDur,

            output_size_bytes:
              size,
          }
        );

        console.log(
          `✓ complete ${job.id} ${job.creator_slug} ${result.finalDur.toFixed(
            2
          )}s`
        );

        return;
      } catch (e) {
        attempts++;

        const msg =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          `[attempt ${attempts}/${MAX_RETRIES}] job=${job.id} error: ${msg}`
        );

        if (
          attempts >=
          MAX_RETRIES
        ) {
          console.error(
            `✗ failed ${job.id} after ${MAX_RETRIES} attempts`
          );

          await call(
            'fail',
            {
              job_id:
                job.id,

              error_message:
                `Render failed after ${MAX_RETRIES} attempts: ${msg}`,
            }
          ).catch(() => {});

          return;
        }

        if (tmp) {
          await rm(tmp, {
            recursive: true,
            force: true,
          }).catch(() => {});

          tmp = undefined;
        }

        await sleep(
          2000 * attempts
        );
      }
    }
  } finally {
    if (heartbeat) {
      clearInterval(
        heartbeat
      );
    }

    if (tmp) {
      await rm(tmp, {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }
}

async function loop() {
  try {
    await validateAssets();
  } catch (e) {
    console.error(
      'FATAL: Asset validation failed:',
      e instanceof Error
        ? e.message
        : e
    );

    process.exit(1);
  }

  console.log(
    `✓ SPLATT render worker started as ${WORKER_ID}`
  );

  console.log(
    `✓ Poll interval: ${POLL_MS}ms`
  );

  console.log(
    '✓ Creator-specific outro mapping active'
  );

  console.log(
    '✓ Discord preview pipeline active'
  );

  while (true) {
    if (busy) {
      await sleep(500);
      continue;
    }

    try {
      // Try preview jobs first to drain pending backlog
      let claim = await call(
        'preview_claim'
      );

      if (claim.job) {
        const job = claim.job;

        console.log(
          `[preview_claim] ${job.id}`
        );

        busy = true;

        try {
          await processPreviewJob(job);
        } finally {
          busy = false;
        }

        continue;
      }

      // Fall back to final render jobs
      claim = await call(
        'claim'
      );

      if (!claim.job) {
        await sleep(
          POLL_MS
        );

        continue;
      }

      busy = true;

      const job =
        claim.job;

      console.log(
        `[claim] ${job.id} ${job.creator_slug}`
      );

      try {
        await processJob(
          job,
          claim.template || {}
        );
      } finally {
        busy = false;
      }
    } catch (e) {
      busy = false;

      console.error(
        '[poll]',
        e instanceof Error
          ? e.message
          : e
      );

      await sleep(
        Math.max(
          POLL_MS,
          5000
        )
      );
    }
  }
}

loop().catch(e => {
  console.error(
    'FATAL worker error:',
    e instanceof Error
      ? e.message
      : e
  );

  process.exit(1);
});

