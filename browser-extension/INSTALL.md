# Installing the Mycloneweb Extension in Microsoft Edge

## Step 1 — Start the local server

In your project folder, run:
```
npm run extension-server
```
Leave this terminal running. You'll see:
```
  ✓ Listening on http://localhost:3001
  ✓ Saving to docs/design-references/
```

## Step 2 — Load the extension in Edge

1. Open Edge and go to: `edge://extensions`
2. Turn on **Developer mode** (toggle, top-left)
3. Click **Load unpacked**
4. Browse to your project folder and select the `browser-extension/` folder
5. The **Mycloneweb** extension appears — pin it to your toolbar

## Step 3 — Capture any page

1. Navigate to the website you want to clone (log in if needed — you're in your real browser)
2. Click the **Mycloneweb** extension icon in the toolbar
3. The popup shows a **green dot** when the server is connected
4. Click **Capture This Page** — it sends the screenshot, HTML, CSS, and all links to Claude Code
5. Or click **Crawl Entire Site** to automatically capture every page on the domain

## Step 4 — Clone it with Claude Code

In a Claude Code session (same project folder):
```
/clone-website
```
Claude reads everything in `docs/design-references/` and builds the Next.js clone.

---

## Tips

- The extension works on **any page you're already logged into** — no credentials needed
- **Crawl** navigates your browser tab through each page automatically (3s between pages)
- Hit **Stop Crawl** to stop after the current page
- **Clear All Captured Files** resets `docs/design-references/` to start fresh
- Captured files: `slug-screenshot.png`, `slug.html`, `slug.json` per page
- `SCRAPE_INDEX.md` lists every captured page for Claude Code to reference
