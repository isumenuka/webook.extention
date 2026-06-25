# WeBook Security Guidelines (Developer to User/Client)

Hello! As the developer of WeBook, your privacy and data security are my top priorities. Below is an overview of how the extension protects your information and what steps you should take to keep your environment secure.

---

## 🔒 How WeBook Protects You

### 1. Zero Personal Data Tracking
- WeBook does **not** collect, track, or store your bookmarks, browsing history, or personal details on any external database.
- All bookmarks and saved tab groups are saved locally on your machine using Chrome's secure storage (`chrome.storage.local`).

### 2. Secure AI Classification & Metadata Scraping
- The proxy server only receives the URL, title, and existing folder structure to generate smart folders and tags.
- The server uses **Metascraper** to pull webpage details (like description or author) directly from public links to improve AI results.
- **Private and local links** (e.g. `localhost`, local IP ranges, or custom ports) are detected automatically and are **never** queried or sent to external scrapers.
- No personal user identifiers, session cookies, or account credentials are sent during this process.

### 3. Safety Measures
- Input size limits are enforced on the server to prevent malicious inputs.
- CORS (Cross-Origin Resource Sharing) is configured to ensure only the extension and approved development domains can communicate with your proxy server.

---

## ⚠️ Action Items for You (Client Checklist)

### 1. Protect Your License Key
- **Never share your WeBook license key** with anyone. It acts as your authorization to use the AI classification services.
- Keep your license key safe. If someone else uses it, your usage quota might be consumed.

### 2. Weekly Free License Key Updates
- The free license key updates **every week on Sunday at 00:00 UTC**.
- To keep using the extension for free, visit your local server landing page (`http://localhost:3000`) weekly to grab the new active free license key and paste it into the extension Settings (under **License Key**).

### 3. Report Issues Safely
If you notice any unusual behavior or think you found a security flaw, please contact me directly or open a GitHub Issue marked **[Security Query]**. Do **not** post your API keys or sensitive server logs in public issues.

Thank you for using WeBook!
