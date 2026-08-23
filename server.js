"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const dns = require("dns").promises;
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3000);

const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const DOWNLOAD_DIR = path.join(os.tmpdir(), "mediafetch-downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const jobs = new Map();

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const YTDLP_COMMAND =
  process.env.YTDLP_PATH ||
  (process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

const FFMPEG_COMMAND =
  process.env.FFMPEG_PATH ||
  (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

/*
|--------------------------------------------------------------------------
| HTTP helpers
|--------------------------------------------------------------------------
*/

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain") {
  res.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Length": Buffer.byteLength(text)
  });

  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > 64 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });

    req.on("error", reject);
  });
}

/*
|--------------------------------------------------------------------------
| URL validation
|--------------------------------------------------------------------------
*/

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);

  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return false;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();

  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

async function validatePublicUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Please provide a valid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  const hostname = parsed.hostname;

  if (!hostname) {
    throw new Error("URL hostname is missing.");
  }

  const lowerHost = hostname.toLowerCase();

  const blockedHostnames = new Set([
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata",
    "host.docker.internal"
  ]);

  if (blockedHostnames.has(lowerHost)) {
    throw new Error("Local/internal URLs are not allowed.");
  }

  if (isPrivateIPv4(lowerHost) || isPrivateIPv6(lowerHost)) {
    throw new Error("Private/internal IP addresses are not allowed.");
  }

  try {
    const addresses = await dns.lookup(hostname, {
      all: true,
      verbatim: true
    });

    for (const entry of addresses) {
      if (
        isPrivateIPv4(entry.address) ||
        isPrivateIPv6(entry.address)
      ) {
        throw new Error("The destination resolves to a private address.");
      }
    }
  } catch (error) {
    if (
      error.message ===
      "The destination resolves to a private address."
    ) {
      throw error;
    }

    throw new Error("Unable to resolve the URL hostname.");
  }

  return parsed.toString();
}

/*
|--------------------------------------------------------------------------
| Process helper
|--------------------------------------------------------------------------
*/

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      ...options
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
          code
        });
      } else {
        const error = new Error(
          stderr.trim() ||
          stdout.trim() ||
          `Process exited with code ${code}.`
        );

        error.code = code;
        reject(error);
      }
    });
  });
}

/*
|--------------------------------------------------------------------------
| Metadata helpers
|--------------------------------------------------------------------------
*/

function normalizeExtractor(extractor) {
  if (!extractor) {
    return "Unknown source";
  }

  const names = {
    youtube: "YouTube",
    instagram: "Instagram",
    tiktok: "TikTok",
    twitter: "X / Twitter",
    facebook: "Facebook",
    vimeo: "Vimeo",
    twitch: "Twitch",
    reddit: "Reddit",
    soundcloud: "SoundCloud",
    dailymotion: "Dailymotion"
  };

  const key = extractor.toLowerCase();

  return names[key] || extractor;
}

function getCreator(info) {
  return (
    info.uploader ||
    info.channel ||
    info.creator ||
    info.artist ||
    info.uploader_id ||
    "Unknown creator"
  );
}

function getSafeTitle(title) {
  const cleaned = String(title || "media")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 160) || "media";
}

async function getVideoInfo(url) {
  const result = await runProcess(YTDLP_COMMAND, [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--ignore-config",
    url
  ]);

  let info;

  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new Error("yt-dlp returned invalid metadata.");
  }

  return {
    id: info.id || null,
    title: info.title || "Unknown title",
    creator: getCreator(info),
    thumbnail: info.thumbnail || null,
    duration: Number.isFinite(Number(info.duration))
      ? Number(info.duration)
      : null,
    source: normalizeExtractor(
      info.extractor_key || info.extractor
    ),
    webpage_url: info.webpage_url || url
  };
}

/*
|--------------------------------------------------------------------------
| Format selection
|--------------------------------------------------------------------------
*/

function getVideoFormat(quality) {
  const heightMap = {
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360
  };

  const height = heightMap[quality] || 1080;

  return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
}

/*
|--------------------------------------------------------------------------
| Jobs
|--------------------------------------------------------------------------
*/

function createJob(url, type, quality) {
  const id = crypto.randomUUID();

  const job = {
    id,
    url,
    type,
    quality,
    status: "starting",
    percent: 0,
    message: "Starting...",
    file: null,
    filename: null,
    mime: null,
    clients: new Set(),
    process: null,
    createdAt: Date.now()
  };

  jobs.set(id, job);

  return job;
}

function publish(job, payload = {}) {
  const data = JSON.stringify({
    status: job.status,
    percent: job.percent,
    message: job.message,
    ...payload
  });

  for (const res of job.clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      job.clients.delete(res);
    }
  }
}

function updateJob(job, status, percent, message) {
  job.status = status;
  job.percent = Math.max(
    0,
    Math.min(100, Number(percent) || 0)
  );

  job.message = message || "";

  publish(job);
}

function parseProgress(line) {
  const match = line.match(
    /\[download\]\s+(\d+(?:\.\d+)?)%/
  );

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

/*
|--------------------------------------------------------------------------
| Find output
|--------------------------------------------------------------------------
*/

function findJobFiles(job) {
  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((name) =>
      name.startsWith(`${job.id}.`)
    )
    .map((name) => ({
      name,
      path: path.join(DOWNLOAD_DIR, name)
    }));
}

/*
|--------------------------------------------------------------------------
| Force MP4 conversion/remux
|--------------------------------------------------------------------------
*/

async function forceMp4(inputFile, outputFile) {
  /*
   * First attempt: stream copy.
   *
   * This is fast and works when the source codecs are already
   * compatible with MP4.
   */

  try {
    await runProcess(FFMPEG_COMMAND, [
      "-y",
      "-i",
      inputFile,

      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",

      "-c:v",
      "copy",

      "-c:a",
      "aac",
      "-b:a",
      "192k",

      "-movflags",
      "+faststart",

      outputFile
    ]);

    return;
  } catch (copyError) {
    /*
     * Some sources contain codecs that cannot be safely
     * stream-copied into MP4.
     *
     * Fall back to real H.264/AAC conversion.
     */

    try {
      await runProcess(FFMPEG_COMMAND, [
        "-y",
        "-i",
        inputFile,

        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",

        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",

        "-c:a",
        "aac",
        "-b:a",
        "192k",

        "-pix_fmt",
        "yuv420p",

        "-movflags",
        "+faststart",

        outputFile
      ]);
    } catch (encodeError) {
      throw new Error(
        encodeError.message ||
        copyError.message ||
        "FFmpeg could not create the MP4 file."
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| Download
|--------------------------------------------------------------------------
*/

async function startDownload(job) {
  const rawTemplate = path.join(
    DOWNLOAD_DIR,
    `${job.id}.%(ext)s`
  );

  try {
    updateJob(
      job,
      "downloading",
      0,
      "yt-dlp is preparing the media..."
    );

    const args = [
      "--no-playlist",
      "--newline",
      "--progress",
      "--no-warnings",
      "--ignore-config",
      "--restrict-filenames",
      "--ffmpeg-location",
      FFMPEG_COMMAND
    ];

    if (job.type === "mp3") {
      args.push(
        "-f",
        "bestaudio/best",

        "-x",

        "--audio-format",
        "mp3",

        "--audio-quality",
        "320K"
      );
    } else {
      /*
       * Download the best available video/audio pair.
       *
       * We do NOT rely on --merge-output-format alone.
       * After yt-dlp finishes, we explicitly create MP4 below.
       */
      args.push(
        "-f",
        getVideoFormat(job.quality),

        "--merge-output-format",
        "mkv"
      );
    }

    args.push(
      "-o",
      rawTemplate,
      job.url
    );

    const child = spawn(YTDLP_COMMAND, args, {
      cwd: ROOT,
      windowsHide: true
    });

    job.process = child;

    let stderrBuffer = "";
    let stdoutBuffer = "";

    const handleLine = (line) => {
      const clean = line.trim();

      if (!clean) {
        return;
      }

      const progress = parseProgress(clean);

      if (progress !== null) {
        updateJob(
          job,
          "downloading",
          progress,
          `Downloading media... ${progress.toFixed(1)}%`
        );

        return;
      }

      if (
        clean.includes("[Merger]") ||
        clean.includes("[ExtractAudio]") ||
        clean.includes("[VideoRemuxer]") ||
        clean.includes("[FFmpeg]")
      ) {
        updateJob(
          job,
          "processing",
          Math.max(job.percent, 99),
          "Preparing final media..."
        );

        return;
      }

      if (
        clean.includes("[download]") ||
        clean.includes("[info]")
      ) {
        job.message = clean.slice(0, 500);
        publish(job);
      }
    };

    const processChunk = (buffer, chunk) => {
      buffer += chunk.toString();

      const lines = buffer.split(/\r?\n/);
      const remainder = lines.pop();

      for (const line of lines) {
        handleLine(line);
      }

      return remainder || "";
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer = processChunk(
        stdoutBuffer,
        chunk
      );
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer = processChunk(
        stderrBuffer,
        chunk
      );
    });

    const exitCode = await new Promise(
      (resolve, reject) => {
        child.on("error", reject);

        child.on("close", (code) => {
          resolve(code);
        });
      }
    );

    if (exitCode !== 0) {
      throw new Error(
        stderrBuffer.trim() ||
        stdoutBuffer.trim() ||
        "yt-dlp failed to download this media."
      );
    }

    /*
     * Find the file created by yt-dlp.
     */

    let files = findJobFiles(job);

    if (!files.length) {
      throw new Error(
        "Download completed but the output file was not found."
      );
    }

    /*
     * MP3 path.
     */

    if (job.type === "mp3") {
      const mp3File =
        files.find((file) =>
          file.name.toLowerCase().endsWith(".mp3")
        ) || files[0];

      const finalName =
        `${job.id}.mp3`;

      const finalPath =
        path.join(DOWNLOAD_DIR, finalName);

      if (mp3File.path !== finalPath) {
        fs.renameSync(
          mp3File.path,
          finalPath
        );
      }

      job.file = finalPath;
      job.filename = "download.mp3";
      job.mime = "audio/mpeg";

      updateJob(
        job,
        "complete",
        100,
        "MP3 download completed successfully."
      );
    } else {
      /*
       * Video path.
       *
       * Explicitly convert/remux the downloaded file
       * into a real MP4 container.
       */

      const sourceFile =
        files.find((file) =>
          !file.name.toLowerCase().endsWith(".part")
        );

      if (!sourceFile) {
        throw new Error(
          "Downloaded video file was not found."
        );
      }

      updateJob(
        job,
        "processing",
        99,
        "FFmpeg is creating the MP4 file..."
      );

      const mp4Path =
        path.join(
          DOWNLOAD_DIR,
          `${job.id}.mp4`
        );

      await forceMp4(
        sourceFile.path,
        mp4Path
      );

      /*
       * Verify that FFmpeg actually created MP4.
       */

      if (
        !fs.existsSync(mp4Path) ||
        fs.statSync(mp4Path).size === 0
      ) {
        throw new Error(
          "FFmpeg did not create a valid MP4 file."
        );
      }

      /*
       * Remove the temporary source file.
       */

      if (
        sourceFile.path !== mp4Path &&
        fs.existsSync(sourceFile.path)
      ) {
        try {
          fs.unlinkSync(sourceFile.path);
        } catch {}
      }

      /*
       * Remove any other temporary files belonging
       * to this job.
       */

      for (const file of findJobFiles(job)) {
        if (file.path !== mp4Path) {
          try {
            fs.unlinkSync(file.path);
          } catch {}
        }
      }

      job.file = mp4Path;
      job.filename = "download.mp4";
      job.mime = "video/mp4";

      updateJob(
        job,
        "complete",
        100,
        "MP4 download completed successfully."
      );
    }

    /*
     * Keep completed file temporarily.
     */

    setTimeout(() => {
      cleanupJob(job.id);
    }, 10 * 60 * 1000);

  } catch (error) {
    if (job.status === "complete") {
      return;
    }

    job.status = "error";
    job.message =
      error?.message ||
      "Download failed.";

    publish(job);

    cleanupJob(job.id, false);
  }
}

/*
|--------------------------------------------------------------------------
| Cleanup
|--------------------------------------------------------------------------
*/

function cleanupJob(id, removeFromMap = true) {
  const job = jobs.get(id);

  if (!job) {
    return;
  }

  if (job.process && !job.process.killed) {
    try {
      job.process.kill("SIGTERM");
    } catch {}
  }

  /*
   * Remove all files belonging to this job.
   */

  try {
    const files = findJobFiles(job);

    for (const file of files) {
      try {
        fs.unlinkSync(file.path);
      } catch {}
    }
  } catch {}

  if (removeFromMap) {
    jobs.delete(id);
  }
}

/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
*/

async function handleRequest(req, res) {
  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const pathname = parsedUrl.pathname;

    // Railway health check
  if (
    req.method === "GET" &&
    pathname === "/health"
  ) {
    sendJson(res, 200, {
      status: "ok"
    });

    return;
  }


  /*
   * Home page
   */

  if (
    req.method === "GET" &&
    pathname === "/"
  ) {
    try {
      const html = fs.readFileSync(
        INDEX_FILE
      );

      res.writeHead(200, {
        "Content-Type":
          "text/html; charset=utf-8",
        "Content-Length": html.length
      });

      res.end(html);
    } catch {
      sendText(
        res,
        500,
        "index.html not found."
      );
    }

    return;
  }

  /*
   * Analyze URL
   */

  if (
    req.method === "POST" &&
    pathname === "/api/info"
  ) {
    try {
      const body =
        await parseBody(req);

      if (
        !body.url ||
        typeof body.url !== "string"
      ) {
        sendJson(res, 400, {
          error: "A URL is required."
        });

        return;
      }

      const url =
        await validatePublicUrl(
          body.url
        );

      const info =
        await getVideoInfo(url);

      sendJson(res, 200, info);
    } catch (error) {
      sendJson(res, 400, {
        error:
          error.message ||
          "Unable to analyze URL."
      });
    }

    return;
  }

  /*
   * Start download
   */

  if (
    req.method === "POST" &&
    pathname === "/api/download"
  ) {
    try {
      const body =
        await parseBody(req);

      if (
        !body.url ||
        typeof body.url !== "string"
      ) {
        sendJson(res, 400, {
          error: "A URL is required."
        });

        return;
      }

      const url =
        await validatePublicUrl(
          body.url
        );

      const type =
        body.type === "mp3"
          ? "mp3"
          : "video";

      const allowedQualities =
        new Set([
          "2160p",
          "1440p",
          "1080p",
          "720p",
          "480p",
          "360p"
        ]);

      const quality =
        allowedQualities.has(
          body.quality
        )
          ? body.quality
          : "1080p";

      const job =
        createJob(
          url,
          type,
          quality
        );

      sendJson(res, 202, {
        jobId: job.id
      });

      setImmediate(() => {
        startDownload(job);
      });

    } catch (error) {
      sendJson(res, 400, {
        error:
          error.message ||
          "Unable to start download."
      });
    }

    return;
  }

  /*
   * Progress
   */

  const progressMatch =
    pathname.match(
      /^\/api\/progress\/([^/]+)$/
    );

  if (
    req.method === "GET" &&
    progressMatch
  ) {
    const jobId =
      decodeURIComponent(
        progressMatch[1]
      );

    const job =
      jobs.get(jobId);

    if (!job) {
      sendJson(res, 404, {
        error:
          "Download job not found."
      });

      return;
    }

    res.writeHead(200, {
      "Content-Type":
        "text/event-stream; charset=utf-8",
      "Cache-Control":
        "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    res.write(
      `data: ${JSON.stringify({
        status: job.status,
        percent: job.percent,
        message: job.message
      })}\n\n`
    );

    job.clients.add(res);

    const keepAlive =
      setInterval(() => {
        try {
          res.write(
            ": keep-alive\n\n"
          );
        } catch {}
      }, 15000);

    req.on("close", () => {
      clearInterval(
        keepAlive
      );

      job.clients.delete(res);
    });

    return;
  }

  /*
   * Download file
   */

  const fileMatch =
    pathname.match(
      /^\/api\/file\/([^/]+)$/
    );

  if (
    req.method === "GET" &&
    fileMatch
  ) {
    const jobId =
      decodeURIComponent(
        fileMatch[1]
      );

    const job =
      jobs.get(jobId);

    if (!job) {
      sendJson(res, 404, {
        error:
          "Download job not found or expired."
      });

      return;
    }

    if (
      job.status !== "complete" ||
      !job.file
    ) {
      sendJson(res, 409, {
        error:
          "The download is not ready yet."
      });

      return;
    }

    if (!fs.existsSync(job.file)) {
      sendJson(res, 404, {
        error:
          "The downloaded file has expired."
      });

      cleanupJob(job.id);
      return;
    }

    const stat =
      fs.statSync(job.file);

    /*
     * IMPORTANT:
     * Video downloads are explicitly advertised
     * as video/mp4 and download.mp4.
     */

    res.writeHead(200, {
      "Content-Type":
        job.mime ||
        "application/octet-stream",

      "Content-Length":
        stat.size,

      "Content-Disposition":
        `attachment; filename="${job.filename || "download"}"`,

      "Cache-Control":
        "no-store",

      "X-Content-Type-Options":
        "nosniff"
    });

    const stream =
      fs.createReadStream(
        job.file
      );

    stream.on("error", () => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error:
            "Unable to read downloaded file."
        });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);

    return;
  }

  sendJson(res, 404, {
    error: "Not found."
  });
}

/*
|--------------------------------------------------------------------------
| Server
|--------------------------------------------------------------------------
*/

const server =
  http.createServer(
    (req, res) => {
      handleRequest(
        req,
        res
      ).catch((error) => {
        console.error(error);

        if (!res.headersSent) {
          sendJson(res, 500, {
            error:
              "Internal server error."
          });
        } else {
          res.destroy();
        }
      });
    }
  );

server.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "        MediaFetch is running"
    );
    console.log(
      "=========================================="
    );
    console.log(
      `Local: http://localhost:${PORT}`
    );
    console.log("");
    console.log(
      `yt-dlp:  ${YTDLP_COMMAND}`
    );
    console.log(
      `ffmpeg:  ${FFMPEG_COMMAND}`
    );
    console.log(
      `files:   ${DOWNLOAD_DIR}`
    );
    console.log(
      "=========================================="
    );
    console.log("");
  }
);

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

function shutdown() {
  console.log(
    "\nShutting down..."
  );

  for (const job of jobs.values()) {
    if (
      job.process &&
      !job.process.killed
    ) {
      try {
        job.process.kill(
          "SIGTERM"
        );
      } catch {}
    }
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);
