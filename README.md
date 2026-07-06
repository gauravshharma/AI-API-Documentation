# API Docs Assistant

An AI-powered **API Documentation Assistant** — a single-page, zero-dependency static web app (HTML + CSS + vanilla JS, no build step) that turns an API specification into production-ready docs and lets you chat with your API in plain English.

It runs entirely in the browser and deploys to GitHub Pages (or Vercel/Netlify) with no server.

---

## What it does

It has two modes:

- **💬 Chat Assistant** — ask plain-English questions about your API. Answers come **only** from your loaded spec, always cite the endpoint (e.g. `GET /tasks`), include working code samples, and keep full conversation history.
- **📄 Documentation Generator** — one click turns your spec into complete Markdown docs (overview, every endpoint, request/response examples, cURL/fetch/Axios/Python samples, developer notes, test cases) shown in a split-pane editor with **Copy** and **Download .md**.

### Input sources
1. **Paste** raw JSON or YAML (OpenAPI 3.x, Swagger 2.0, or Postman Collection v2.1).
2. **Fetch from a URL** pointing to a raw spec file.
3. **GitHub repo URL** — scans the repo via the GitHub Contents API, auto-detects spec files (`openapi.json`, `swagger.yaml`, …), and if none exist, reads route/controller files (Express, FastAPI, etc.) and uses Claude to **infer** the endpoints.

### Extra features
- **Coverage Report** — automatically scans every endpoint for missing descriptions, schemas, parameter docs, auth, and examples; gives a 0–100 score, a severity-filtered list, and a one-click **Fix with AI** per finding.
- **Export to Confluence** — converts the Markdown to Confluence Storage Format and publishes via `POST /wiki/rest/api/content`, or gives you a **Copy Confluence markup** fallback.
- **Non-technical UX** — 3-step first-visit onboarding, tooltips on every control, plain-English errors with suggested fixes, loading states, and empty states.

---

## Project structure

```
api-assistant/
├── index.html                  # App shell
├── src/
│   ├── styles.css              # Full stylesheet (dark terminal theme)
│   └── app.js                  # All application logic
├── examples/
│   └── taskflow.json           # Sample OpenAPI 3.0 spec (TaskFlow API)
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions → GitHub Pages
├── .gitignore
└── README.md
```

---

## 1. Local setup

No build step, no dependencies. Two options:

**A. Just open the file**

Double-click `index.html`, or open it in your browser. Everything works except fetching `examples/taskflow.json` over `file://` (the app falls back to a built-in embedded sample, so the "Load sample" button still works).

**B. Run a tiny local server (recommended)**

```bash
# Python 3
python3 -m http.server 8000
# then open http://localhost:8000
```

```bash
# Or with Node
npx serve .
```

### Add your Claude API key
The app calls Claude directly from the browser. Open **⚙ Settings** and paste your Anthropic API key (`sk-ant-…`). It's stored only in your browser's `localStorage` on your device.

> If your environment proxies authentication to `api.anthropic.com`, you can leave the key blank — the app sends the request directly to `POST https://api.anthropic.com/v1/messages` (model `claude-sonnet-4-20250514`, `max_tokens: 2000`).

---

## 2. Deploy to GitHub Pages (via the UI)

1. Create a new GitHub repo and push this folder to the `main` branch.
2. Go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick branch **`main`** and folder **`/ (root)`**, then **Save**.
5. Wait ~1 minute; your site appears at `https://<your-username>.github.io/<repo>/`.

---

## 3. Deploy to GitHub Pages (via GitHub Actions)

This repo ships with `.github/workflows/deploy.yml`, which deploys the repo root on every push to `main` using `actions/configure-pages@v4`, `actions/upload-pages-artifact@v3`, and `actions/deploy-pages@v4`.

1. Push the repo to GitHub.
2. Go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
3. Push any commit to `main` (or run the workflow manually from the **Actions** tab via **Run workflow**).
4. The **Deploy to GitHub Pages** workflow builds and publishes automatically. The live URL is shown in the workflow run summary.

---

## 4. Deploy to Vercel or Netlify (one-click)

Because this is a static site with no build step, both are trivial.

**Vercel**
1. Push to GitHub, then import the repo at [vercel.com/new](https://vercel.com/new).
2. Framework preset: **Other**. Build command: *(leave empty)*. Output directory: `./`.
3. Click **Deploy**.

**Netlify**
1. Push to GitHub, then **Add new site → Import an existing project** at [app.netlify.com](https://app.netlify.com).
2. Build command: *(leave empty)*. Publish directory: `.` (root).
3. Click **Deploy site**.

You can also drag-and-drop the folder onto the Netlify dashboard for an instant deploy.

---

## Try it without any setup

Open the app and click **"Or try the sample API"** (or **Load sample** in the loader). It loads the built-in **TaskFlow API** — a complete OpenAPI 3.0 spec with `POST /auth/token`, `GET/POST /tasks`, `GET/PATCH/DELETE /tasks/{task_id}`, and `GET/POST /projects`, all using Bearer JWT auth.

---

## Notes & limitations

- **CORS:** Fetching specs from a URL or publishing to Confluence requires the target server to allow cross-origin browser requests. Confluence Cloud blocks browser CORS by default — use the **Copy Confluence markup** fallback and paste it into a new page if publishing fails.
- **GitHub API:** Anonymous Contents API calls are rate-limited; if you hit a limit, wait a minute or paste the spec directly.
- **Privacy:** Your API key and Confluence credentials live only in this browser's `localStorage`. Don't use the credential fields on a shared computer.
- **YAML:** Parsed by a lightweight built-in parser that handles typical OpenAPI/Swagger YAML. For unusual YAML, convert to JSON first.

---

## License

MIT License

Copyright (c) 2026 Gaurav Sharma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
