const express = require("express");
const dns = require("dns").promises;
const net = require("net");

const app = express();
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const MAX_BYTES = Number(process.env.MAX_PDF_BYTES || 20 * 1024 * 1024); // 20 MB default
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const API_KEY = process.env.API_KEY || ""; // optional: set to require x-api-key header

// ---------- helpers ----------

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

// Blocks requests to internal/private hosts (SSRF protection)
async function assertPublicHost(hostname) {
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) {
    throw httpError(400, "URL must point to a public host");
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function fileNameFrom(url, headers) {
  const cd = headers.get("content-disposition") || "";
  const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match) return decodeURIComponent(match[1]);
  const last = url.pathname.split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last) : "document.pdf";
}

async function fetchPdf(rawUrl, redirectsLeft = 5) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, "Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw httpError(400, "Only http and https URLs are allowed");
  }
  await assertPublicHost(url.hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Redirects handled manually so each hop is checked against private IPs
    const res = await fetch(url, { redirect: "manual", signal: controller.signal });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (redirectsLeft <= 0) throw httpError(502, "Too many redirects");
      const next = new URL(res.headers.get("location"), url).toString();
      return fetchPdf(next, redirectsLeft - 1);
    }
    if (!res.ok) throw httpError(502, `Source returned HTTP ${res.status}`);

    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) throw httpError(413, `PDF exceeds ${MAX_BYTES} bytes`);

    // Stream with a running size check
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        controller.abort();
        throw httpError(413, `PDF exceeds ${MAX_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Verify it's actually a PDF (magic bytes "%PDF-"), not just the content-type
    if (buffer.subarray(0, 1024).indexOf("%PDF-") === -1) {
      throw httpError(422, "The URL did not return a valid PDF file");
    }

    return { buffer, fileName: fileNameFrom(url, res.headers) };
  } catch (err) {
    if (err.status) throw err;
    if (err.name === "AbortError") throw httpError(504, "Timed out fetching the PDF");
    // Node's fetch hides the real network error in err.cause
    const cause = err.cause || {};
    const code = cause.code || cause.name || "";
    const reasons = {
      UND_ERR_CONNECT_TIMEOUT: "Could not connect to the source host (connection timed out - it may block this server's IP)",
      ECONNREFUSED: "Source host refused the connection",
      ECONNRESET: "Source host closed the connection",
      ETIMEDOUT: "Connection to the source host timed out",
      EHOSTUNREACH: "Source host is unreachable",
      ENOTFOUND: "Host not found",
      CERT_HAS_EXPIRED: "Source host's SSL certificate has expired",
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: "Source host's SSL certificate chain is incomplete",
      SELF_SIGNED_CERT_IN_CHAIN: "Source host uses a self-signed SSL certificate",
      DEPTH_ZERO_SELF_SIGNED_CERT: "Source host uses a self-signed SSL certificate",
    };
    console.error("fetch failed:", code, cause.message || err.message);
    throw httpError(502, reasons[code] || `Failed to fetch the PDF (${code || cause.message || err.message})`);
  } finally {
    clearTimeout(timer);
  }
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
    const status = err.status || (err.code === "ENOTFOUND" ? 400 : 500);
    const message = err.code === "ENOTFOUND" ? "Host not found" : err.message || "Internal error";
    if (status >= 500) console.error("pdf-to-base64 error:", err);
    return res.status(status).json({ success: false, error: message });
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
