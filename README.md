# PDF → Base64 API

Takes a public PDF URL and returns the file's base64 contents.

## Run locally

```bash
npm install
npm start          # listens on PORT (default 3000)
```

## Endpoint

`POST /api/pdf-to-base64`

Request body:

```json
{
  "url": "https://example.com/files/invoice.pdf",
  "dataUri": false
}
```

- `url` (required): public http/https link to the PDF
- `dataUri` (optional): `true` returns `data:application/pdf;base64,...` instead of raw base64

Success (200):

```json
{
  "success": true,
  "fileName": "invoice.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 48213,
  "base64": "JVBERi0xLjcKJ..."
}
```

Errors return `{ "success": false, "error": "..." }`:

| Status | When |
|---|---|
| 400 | Missing/invalid URL, non-http(s) URL, private/internal host, unknown host |
| 401 | `API_KEY` is set and `x-api-key` header is wrong or missing |
| 413 | PDF larger than `MAX_PDF_BYTES` |
| 422 | URL didn't return a real PDF (checked by `%PDF-` file signature) |
| 502 | Source server returned an error / too many redirects |
| 504 | Fetch timed out |

## Example

```bash
curl -X POST http://localhost:3000/api/pdf-to-base64 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"}'
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `MAX_PDF_BYTES` | 20971520 (20 MB) | Max PDF size |
| `FETCH_TIMEOUT_MS` | 30000 | Overall timeout for downloading the PDF |
| `CONNECT_TIMEOUT_MS` | 8000 | Connect timeout per IP address (the API tries each IPv4, then IPv6, address of the host) |
| `API_KEY` | _(empty)_ | If set, requests must send `x-api-key: <value>` |

## Deploy on Render

New Web Service → connect repo → Build command `npm install` → Start command `npm start`. Optionally set `API_KEY`.

`GET /health` is available for Render's health check.
