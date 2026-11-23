const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const http = require("http");
const https = require("https");

const app = express();
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const MAX_BYTES = Number(process.env.MAX_PDF_BYTES || 20 * 1024 * 1024); // 20 MB default
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000); // whole download
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 8000); // per IP address
const API_KEY = process.env.API_KEY || ""; // optional: set to require x-api-key header
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === "true"; // local testing only

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
  "Accept-Encoding": "identity",
};

// ---------- helpers ----------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.replace("::ffff:", ""));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

// Resolve the host, block private/internal IPs (SSRF protection), IPv4 first
async function resolvePublicAddresses(hostname) {
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw httpError(400, "Host not found");
  }
  if (!records.length || (!ALLOW_PRIVATE && records.some((r) => isPrivateIp(r.address)))) {
    throw httpError(400, "URL must point to a public host");
  }
  return records.sort((a, b) => a.family - b.family); // 4 before 6
}

function fileNameFrom(url, headers) {
  const cd = headers["content-disposition"] || "";
  const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }
  const last = url.pathname.split("/").filter(Boolean).pop();
  try { return last ? decodeURIComponent(last) : "document.pdf"; } catch { return last; }
}

const NET_ERRORS = {
  CONNECT_TIMEOUT: "Could not connect to the source host (connection timed out)",
  ECONNREFUSED: "Source host refused the connection",
  ECONNRESET: "Source host closed the connection",
  ETIMEDOUT: "Connection to the source host timed out",
  EHOSTUNREACH: "Source host is unreachable",
  ENETUNREACH: "Network unreachable to the source host",
  CERT_HAS_EXPIRED: "Source host's SSL certificate has expired",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "Source host's SSL certificate chain is incomplete",
  SELF_SIGNED_CERT_IN_CHAIN: "Source host uses a self-signed SSL certificate",
  DEPTH_ZERO_SELF_SIGNED_CERT: "Source host uses a self-signed SSL certificate",
  ERR_TLS_CERT_ALTNAME_INVALID: "Source host's SSL certificate doesn't match the domain",
};

// One GET request pinned to a specific IP (the one we validated), resolves on response headers
function requestVia(url, address, family) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    let connected = false;

    const req = lib.get(
      url,
      {
        headers: REQUEST_HEADERS,
        servername: url.hostname, // correct SSL certificate / SNI
        lookup: (_host, opts, cb) =>
          opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family),
      },
      (res) => {
        clearTimeout(connectTimer);
        resolve({ res, req });
      }
    );

    const connectTimer = setTimeout(() => {
      if (!connected) {
        const e = new Error("connect timeout");
        e.code = "CONNECT_TIMEOUT";
        req.destroy(e);
      }
    }, CONNECT_TIMEOUT_MS);

    req.on("socket", (socket) => {
      const evt = url.protocol === "https:" ? "secureConnect" : "connect";
      socket.once(evt, () => (connected = true));
    });
    req.on("error", (err) => {
      clearTimeout(connectTimer);
      err.connected = connected;
      reject(err);
    });
  });
}

// Try each resolved IP until one connects
async function openConnection(url) {
  const addresses = await resolvePublicAddresses(url.hostname);
  let lastErr;
  for (const { address, family } of addresses) {
    try {
      return await requestVia(url, address, family);
    } catch (err) {
      lastErr = err;
      console.error(`connect ${url.hostname} via ${address} failed:`, err.code || err.message);
      if (err.connected) break; // connected but failed later (SSL/reset) - other IPs won't help
    }
  }
  const code = lastErr && lastErr.code;
  throw httpError(502, NET_ERRORS[code] || `Failed to fetch the PDF (${code || (lastErr && lastErr.message)})`);
}

async function fetchPdf(rawUrl, deadline = Date.now() + TIMEOUT_MS, redirectsLeft = 5) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, "Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw httpError(400, "Only http and https URLs are allowed");
  }

  const { res, req } = await openConnection(url);

  // Redirects: each hop is re-validated against private IPs
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    if (redirectsLeft <= 0) throw httpError(502, "Too many redirects");
    return fetchPdf(new URL(res.headers.location, url).toString(), deadline, redirectsLeft - 1);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw httpError(502, `Source returned HTTP ${res.statusCode}`);
  }

  const declared = Number(res.headers["content-length"] || 0);
  if (declared > MAX_BYTES) {
    req.destroy();
    throw httpError(413, `PDF exceeds ${MAX_BYTES} bytes`);
  }

  // Read body with size limit and overall deadline
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(httpError(504, "Timed out downloading the PDF"));
    }, Math.max(deadline - Date.now(), 1000));

    res.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        clearTimeout(timer);
        req.destroy();
        return reject(httpError(413, `PDF exceeds ${MAX_BYTES} bytes`));
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (err) => {
      clearTimeout(timer);
      reject(httpError(502, `Download interrupted (${err.code || err.message})`));
    });
  });

  // Verify it's actually a PDF (magic bytes "%PDF-"), not just the content-type
  if (buffer.subarray(0, 1024).indexOf("%PDF-") === -1) {
    throw httpError(422, "The URL did not return a valid PDF file");
  }

  return { buffer, fileName: fileNameFrom(url, res.headers) };
}

// ---------- routes ----------

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/pdf-to-base64", async (req, res) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const { url, dataUri = false } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ success: false, error: "'url' (string) is required in the request body" });
  }

  try {
    const { buffer, fileName } = await fetchPdf(url.trim());
    const base64 = buffer.toString("base64");
    return res.json({
      success: true,
      fileName,
      mimeType: "application/pdf",
      sizeBytes: buffer.length,
      base64: dataUri ? `data:application/pdf;base64,${base64}` : base64,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("pdf-to-base64 error:", err.message);
    return res.status(status).json({ success: false, error: err.message || "Internal error" });
  }
});

// Malformed JSON body
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, error: "Invalid JSON body" });
  }
  res.status(500).json({ success: false, error: "Internal error" });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`pdf-to-base64 API listening on :${PORT}`));
}

module.exports = { app, isPrivateIp };
