// WeBook Background Service Worker v2.0
// Features: Auto-organize, Metadata fetch, Duplicate detection, Tags,
//           Context menu, Weekly digest, Broken link checker, Folder merge

// ── Replace this with your deployed Digital Ocean server URL ──
// e.g. 'https://webook-proxy-xxxxx.ondigitalocean.app'
const PROXY_URL = 'https://webook-proxy-rfdpf.ondigitalocean.app';

// ── Developer Helper: Clear local classification cache on reload to force server classification ──
chrome.storage.local.remove('webookCache', () => {
  console.log('[WeBook] Cache cleared for local testing.');
});

const processingIds = new Set();
const autoMovingIds = new Set();
const folderCreationPromises = new Map();

const pendingAutoOrganizeUrls = new Set();

function normalizeUrlForMatch(urlStr) {
  if (!urlStr) return '';
  try {
    const url = new URL(urlStr);
    return url.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return urlStr.trim().toLowerCase();
  }
}

function getRealFolderId(settingsValue) {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      try {
        const rootChildren = tree[0].children || [];
        if (settingsValue === '2') {
          const otherNode = rootChildren.find(c => {
            const t = (c.title || '').toLowerCase();
            return t.includes('other') || t.includes('unsorted');
          }) || rootChildren[1] || { id: '2' };
          resolve(otherNode.id);
        } else {
          const barNode = rootChildren.find(c => {
            const t = (c.title || '').toLowerCase();
            return (t.includes('bar') || t.includes('favorites') || t.includes('bookmark')) && !t.includes('other');
          }) || rootChildren[0] || { id: '1' };
          resolve(barNode.id);
        }
      } catch (e) {
        resolve(settingsValue === '2' ? '2' : '1');
      }
    });
  });
}

// Words that are too generic, vague, or meaningless as tags
const STOP_WORDS = new Set([
  'with','your','from','this','that','and','the','for','its','are','was',
  'not','can','all','has','have','will','just','into','more','also','but',
  'web','internet','online','website','site','page','pages','portal','domain',
  'url','http','https','www','html','link','links','browse','browsing',
  'new','best','top','free','open','fast','easy','full','live','real','main',
  'home','show','view','list','get','now','try','use','make','need','find',
  'let','our','you','how','why','what','when','where','who','more','most',
  'app','apps','tool','tools','service','services','product','products','item',
  'platform','solution','solutions','system','systems','resource','resources',
  'hub','info','data','base','index','detail','details','dashboard','portal',
  'addon','addons','extension','extensions','chrome','store','edge','microsoft',
  'bookmark','bookmarks','saved','general','uncategorized','utility','utilities',
  'launches','launch','launched','release','released','update','updates','updated',
  'intern','internal','invisible','common','standard','simple','basic','official',
  'about','contact','terms','privacy','policy','blog','news','post','posts',
  'sign','login','signup','register','account','settings','profile','search',
  'welcome','overview','intro','introduction','guide',
  'tech','reference','browsing','service',
]);

function enrichTags(existingTags, title, url, folderName) {
  const enriched = new Set();

  // 1. AI-generated tags (most specific — keep up to 15)
  if (Array.isArray(existingTags)) {
    for (const t of existingTags) {
      if (enriched.size >= 15) break;
      const clean = t.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
      if (clean.length >= 2 && !STOP_WORDS.has(clean)) enriched.add(clean);
    }
  }

  // 2. Domain brand name (e.g. 'animmaster', 'uiverse', 'openai')
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const brand = host.split('.')[0];
    if (brand && brand.length >= 3 && !['com','org','net','edu','gov'].includes(brand) && !STOP_WORDS.has(brand)) {
      if (enriched.size < 15) enriched.add(brand);
    }
  } catch {}

  // 3. Meaningful words from folder name
  const folderWords = (folderName || '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  for (const w of folderWords) {
    if (enriched.size >= 15) break;
    enriched.add(w);
  }

  // 4. Title words — used to reach minimum 15 tags
  if (enriched.size < 15) {
    const titleWords = (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
    for (const w of titleWords) {
      if (enriched.size >= 15) break;
      enriched.add(w);
    }
  }

  // Return up to 15 tags (best effort minimum 15)
  return Array.from(enriched).slice(0, 15);
}

function getFallbackTags(title, url) {
  const combined = `${title || ''} ${url || ''}`.toLowerCase();
  const tags = new Set();
  
  // 1. Keyword check for popular categories
  if (/youtube|netflix|twitch|spotify|vimeo|tiktok|movies|cinema|cinesubz|yts|1337x/.test(combined)) {
    tags.add('entertainment'); tags.add('media'); tags.add('streaming');
  }
  if (/github|stackoverflow|codepen|dev\.to|npm|docs\.|api\./.test(combined)) {
    tags.add('development'); tags.add('dev'); tags.add('code');
  }
  if (/news|cnn|bbc|reuters|techcrunch|verge|wired|nytimes/.test(combined)) {
    tags.add('news'); tags.add('media');
  }
  if (/twitter|x\.com|reddit|linkedin|facebook|instagram/.test(combined)) {
    tags.add('social'); tags.add('social-media');
  }
  if (/amazon|ebay|etsy|shopify|aliexpress|shop|store/.test(combined)) {
    tags.add('shopping'); tags.add('ecommerce');
  }
  if (/chatgpt|openai|gemini|claude|midjourney|huggingface|gpt|krea|fal/.test(combined)) {
    tags.add('ai'); tags.add('artificial-intelligence'); tags.add('tools');
  }
  if (/google|drive|notion|trello|slack|figma|canva|accounting/.test(combined)) {
    tags.add('productivity'); tags.add('tools');
  }
  if (/telegram|whatsapp|messenger|viber|wechat|signal|line|skype|teams/.test(combined)) {
    tags.add('messaging'); tags.add('chat'); tags.add('communication');
  }
  if (/mail|gmail|zoho|proton|tuta/.test(combined)) {
    tags.add('email'); tags.add('communication'); tags.add('mail');
  }
  if (/college|university|school|education|learning|course|qualification|cim|cambridge/.test(combined)) {
    tags.add('learning'); tags.add('education');
  }
  if (/visa|government|gov\./.test(combined)) {
    tags.add('government');
  }
  if (/ca sri lanka|finance|bank|invest|stripe/.test(combined)) {
    tags.add('finance'); tags.add('money');
  }

  // 2. Add domain brand name
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const brand = host.split('.')[0];
    if (brand && brand.length >= 3 && !['com','org','net','edu','gov'].includes(brand)) {
      tags.add(brand);
    }
  } catch {}

  // 3. Add clean words from title
  const titleWords = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  for (const w of titleWords) {
    if (tags.size >= 15) break;
    tags.add(w);
  }

  return Array.from(tags).slice(0, 15);
}

async function scrapeMetadataTags(url, title) {
  const tags = new Set();
  const licenseKey = await new Promise(r => chrome.storage.local.get({ licenseKey: '' }, data => r(data.licenseKey || '')));
  
  try {
    const res = await fetch(`${PROXY_URL}/api/scrape-metadata`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-license-key': licenseKey
      },
      body: JSON.stringify({ url })
    });
    
    if (res.ok) {
      const data = await res.json();
      
      if (data.title) {
        const titleWords = data.title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/);
        titleWords.forEach(w => {
          if (w.length >= 4 && !STOP_WORDS.has(w)) tags.add(w);
        });
      }
      
      if (data.description) {
        const descWords = data.description.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/);
        descWords.forEach(w => {
          if (w.length >= 4 && !STOP_WORDS.has(w)) tags.add(w);
        });
      }
    }
  } catch (e) {
    console.warn('[WeBook Scraper] Scrape failed for:', url, e.message);
  }

  const fallback = getFallbackTags(title, url);
  fallback.forEach(t => tags.add(t));

  return Array.from(tags).slice(0, 15);
}

async function startSearchIndexing() {
  chrome.storage.local.get({ bookmarkTags: {} }, async (storageData) => {
    try {
      updateSearchIndexStatus({ status: 'processing', current: 0, total: 100, progress: 0, details: 'Scanning bookmarks...' });
      
      const tree = await chrome.bookmarks.getTree();
      const allBookmarks = [];
      function scan(node) {
        if (node.url) {
          allBookmarks.push(node);
        }
        if (node.children) {
          node.children.forEach(scan);
        }
      }
      tree.forEach(scan);

      const bookmarkTags = storageData.bookmarkTags || {};
      
      // Only include bookmarks that don't already have tags in bookmarkTags
      const queue = allBookmarks.filter(bm => !bookmarkTags[bm.id] || bookmarkTags[bm.id].length === 0);
      const total = queue.length;

      if (total === 0) {
        updateSearchIndexStatus({ status: 'completed', current: 0, total: 0, progress: 100, details: 'Search index is up to date!' });
        chrome.storage.local.set({ initialAnalysisDone: true });
        return;
      }

      isSearchIndexCancelled = false;
      let processed = 0;
      const batchSize = 3;

      for (let i = 0; i < queue.length; i += batchSize) {
        if (isSearchIndexCancelled) {
          console.log('[WeBook] Search indexing cancelled by user.');
          break;
        }

        const batch = queue.slice(i, i + batchSize);
        updateSearchIndexStatus({
          status: 'processing',
          current: processed,
          total,
          progress: Math.round((processed / total) * 100),
          details: `Indexing: ${batch.map(b => b.title || b.url).join(', ')}`
        });

        const promises = batch.map(async (bm) => {
          try {
            const tags = await scrapeMetadataTags(bm.url, bm.title);
            if (tags && tags.length > 0) {
              bookmarkTags[bm.id] = tags;
            }
          } catch (e) {
            console.error('[WeBook] Error indexing bookmark:', bm.url, e);
          }
        });

        await Promise.all(promises);
        processed += batch.length;

        // Save progress incrementally
        await new Promise(r => chrome.storage.local.set({ bookmarkTags }, r));

        // Wait a short delay to avoid overwhelming the network
        await new Promise(r => setTimeout(r, 200));
      }

      if (isSearchIndexCancelled) {
        updateSearchIndexStatus({ status: 'completed', current: processed, total, progress: 100, details: 'Cancelled' });
      } else {
        updateSearchIndexStatus({ status: 'completed', current: total, total, progress: 100, details: 'Done! Search index prepared.' });
        chrome.storage.local.set({ initialAnalysisDone: true });
      }

    } catch (err) {
      console.error('[WeBook] Search index failed:', err);
      updateSearchIndexStatus({ status: 'error', details: err.message });
    }
  });
}

let isBulkOrganizeCancelled = false;
let isLinkCheckCancelled = false;
let isSearchIndexCancelled = false;

// ─────────────────────────────────────────────────────────────────────────────
// #11 — RETRY HELPER: Retries on network error or 502/503/429 with backoff + 28s per-attempt timeout
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWithRetry(url, opts, maxRetries = 2, timeoutMs = 28000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 1500; // 1.5s, then 3s
      console.warn(`[WeBook] Retry attempt ${attempt} for ${url} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status === 502 || res.status === 503) {
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) continue;
        return res; // Return last response after retries exhausted
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < maxRetries) continue;
      throw lastError;
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// #8 — FOLDER CLEAN HASH CACHE: Skip API call if folder list unchanged
// ─────────────────────────────────────────────────────────────────────────────
async function simpleHash(str) {
  // Simple fast djb2-style hash for folder names list (no crypto API needed in SW)
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit int
  }
  return hash.toString(16);
}

async function getFolderCleanCache(folderNames) {
  const key = await simpleHash(folderNames.join(','));
  return new Promise(resolve => {
    chrome.storage.local.get({ folderCleanCache: {} }, (data) => {
      const entry = data.folderCleanCache[key];
      const ONE_HOUR = 60 * 60 * 1000;
      if (entry && (Date.now() - entry.ts < ONE_HOUR)) {
        resolve({ hash: key, mapping: entry.mapping });
      } else {
        resolve({ hash: key, mapping: null });
      }
    });
  });
}

async function setFolderCleanCache(hash, mapping) {
  return new Promise(resolve => {
    chrome.storage.local.get({ folderCleanCache: {} }, (data) => {
      const cache = data.folderCleanCache;
      cache[hash] = { mapping, ts: Date.now() };
      // Keep cache small: max 20 entries
      const keys = Object.keys(cache);
      if (keys.length > 20) {
        const oldest = keys.sort((a, b) => cache[a].ts - cache[b].ts)[0];
        delete cache[oldest];
      }
      chrome.storage.local.set({ folderCleanCache: cache }, resolve);
    });
  });
}



// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC URL & TITLE CLEANING
// ─────────────────────────────────────────────────────────────────────────────
const UTILITY_PATH_PATTERNS = [
  /^\/c\/[a-f0-9-]{8,}/i,
  /^\/chat\/[a-f0-9-]{8,}/i,
  /^\/conversations?\//i,
  /^\/projects?\b/i,
  /^\/dashboard\b/i,
  /^\/logs?\b/i,
  /^\/settings?\b/i,
  /^\/console\b/i,
  /^\/workspace(s)?\b/i,
  /^\/portal\b/i,
  /^\/home\b/i,
  /^\/feed\b/i,
  /^\/inbox\b/i,
  /^\/verify\b/i,
  /^\/auth\b/i,
  /^\/login\b/i,
  /^\/signin\b/i,
  /^\/signup\b/i,
  /^\/register\b/i,
  /^\/admin\b/i,
  /^\/account\b/i,
  /^\/profile\b/i,
  /^\/billing\b/i,
  /^\/keys?\b/i,
  /^\/tokens?\b/i,
  /^\/analytics\b/i,
  /^\/reports?\b/i,
  /^\/explore\b/i,
  /^\/library\b/i,
  /^\/overview\b/i,
];

const BRAND_NAMES = {
  'chatgpt.com': 'ChatGPT', 'openai.com': 'OpenAI', 'claude.ai': 'Claude',
  'anthropic.com': 'Anthropic', 'openrouter.ai': 'OpenRouter',
  'mail.google.com': 'Gmail', 'gmail.com': 'Gmail', 'github.com': 'GitHub',
  'gitlab.com': 'GitLab', 'notion.so': 'Notion', 'figma.com': 'Figma',
  'linear.app': 'Linear', 'vercel.com': 'Vercel', 'netlify.com': 'Netlify',
  'supabase.com': 'Supabase', 'airtable.com': 'Airtable',
  'huggingface.co': 'Hugging Face', 'perplexity.ai': 'Perplexity',
  'google.com': 'Google', 'youtube.com': 'YouTube', 'twitter.com': 'Twitter',
  'x.com': 'X', 'linkedin.com': 'LinkedIn', 'facebook.com': 'Facebook',
  'instagram.com': 'Instagram', 'reddit.com': 'Reddit', 'discord.com': 'Discord',
  'slack.com': 'Slack', 'zoom.us': 'Zoom', 'drive.google.com': 'Google Drive',
  'docs.google.com': 'Google Docs', 'sheets.google.com': 'Google Sheets',
  'calendar.google.com': 'Google Calendar', 'meet.google.com': 'Google Meet',
  'trello.com': 'Trello', 'asana.com': 'Asana', 'stripe.com': 'Stripe',
  'recraft.ai': 'Recraft', 'midjourney.com': 'Midjourney', 'leonardo.ai': 'Leonardo AI',
  'suno.ai': 'Suno', 'udio.com': 'Udio', 'elevenlabs.io': 'ElevenLabs',
  'canva.com': 'Canva', 'adobe.com': 'Adobe', 'proton.me': 'Proton Mail',
  'protonmail.com': 'Proton Mail', 'mail.zoho.com': 'Zoho Mail',
  'tuta.com': 'Tuta Mail', 'temp-mail.org': 'Temp Mail',
  'aws.amazon.com': 'AWS', 'console.cloud.google.com': 'Google Cloud',
  'portal.azure.com': 'Azure', 'pika.art': 'Pika', 'kling.ai': 'Kling',
  'heygen.com': 'HeyGen', 'murf.ai': 'Murf AI', 'groq.com': 'Groq',
};

function extractBrandName(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (BRAND_NAMES[host]) return BRAND_NAMES[host];
    for (const [key, brand] of Object.entries(BRAND_NAMES)) {
      if (host === key || host.endsWith('.' + key)) return brand;
    }
    const stripped = host.replace(/^(www\.|app\.|mail\.|my\.|m\.|go\.|get\.|beta\.|new\.|dev\.)/, '');
    const name = stripped.split('.')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { return null; }
}

function getCleanedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/' || parsed.pathname === '') return null;
    return UTILITY_PATH_PATTERNS.some(p => p.test(parsed.pathname)) ? parsed.origin + '/' : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATIC DETERMINISTIC CLASSIFICATIONS & CACHING
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_CLASSIFICATION_MAP = {
  'chatgpt.com': { folderName: 'AI Tools', tags: ['ai', 'chatgpt', 'assistant'] },
  'chat.openai.com': { folderName: 'AI Tools', tags: ['ai', 'chatgpt', 'assistant'] },
  'openai.com': { folderName: 'AI Tools', tags: ['ai', 'openai'] },
  'claude.ai': { folderName: 'AI Tools', tags: ['ai', 'claude', 'assistant'] },
  'anthropic.com': { folderName: 'AI Tools', tags: ['ai', 'anthropic'] },
  'gemini.google.com': { folderName: 'AI Tools', tags: ['ai', 'gemini', 'assistant'] },
  'perplexity.ai': { folderName: 'AI Tools', tags: ['ai', 'search', 'perplexity'] },
  'poe.com': { folderName: 'AI Tools', tags: ['ai', 'chatbots'] },
  'openrouter.ai': { folderName: 'AI Tools', tags: ['ai', 'api', 'openrouter'] },
  'v0.dev': { folderName: 'AI Tools', tags: ['ai', 'ui', 'react'] },
  'suno.com': { folderName: 'AI Tools', tags: ['ai', 'music', 'suno'] },
  'suno.ai': { folderName: 'AI Tools', tags: ['ai', 'music', 'suno'] },
  'elevenlabs.io': { folderName: 'AI Tools', tags: ['ai', 'voice', 'elevenlabs'] },
  
  'github.com': { folderName: 'Dev Tools', tags: ['development', 'git', 'code'] },
  'gitlab.com': { folderName: 'Dev Tools', tags: ['development', 'git', 'ci-cd'] },
  'stackoverflow.com': { folderName: 'Dev Tools', tags: ['programming', 'q&a', 'help'] },
  'codepen.io': { folderName: 'Dev Tools', tags: ['development', 'frontend', 'playground'] },
  'replit.com': { folderName: 'Dev Tools', tags: ['development', 'ide', 'online'] },
  
  'vercel.com': { folderName: 'Hosting & Domains', tags: ['hosting', 'deployment', 'vercel'] },
  'netlify.com': { folderName: 'Hosting & Domains', tags: ['hosting', 'deployment', 'netlify'] },
  'supabase.com': { folderName: 'Databases', tags: ['database', 'postgres', 'supabase'] },
  'firebase.google.com': { folderName: 'Cloud Services', tags: ['cloud', 'backend', 'firebase'] },
  'aws.amazon.com': { folderName: 'Cloud Services', tags: ['cloud', 'hosting', 'aws'] },
  'console.cloud.google.com': { folderName: 'Cloud Services', tags: ['cloud', 'google-cloud'] },
  'portal.azure.com': { folderName: 'Cloud Services', tags: ['cloud', 'azure'] },
  
  'notion.so': { folderName: 'Productivity', tags: ['notes', 'workspace', 'notion'] },
  'trello.com': { folderName: 'Productivity', tags: ['kanban', 'tasks', 'trello'] },
  'linear.app': { folderName: 'Productivity', tags: ['tasks', 'bugs', 'linear'] },
  'asana.com': { folderName: 'Productivity', tags: ['tasks', 'collaboration', 'asana'] },
  'airtable.com': { folderName: 'Productivity', tags: ['database', 'spreadsheet', 'airtable'] },
  
  'slack.com': { folderName: 'Communication', tags: ['chat', 'team', 'slack'] },
  'discord.com': { folderName: 'Communication', tags: ['chat', 'community', 'discord'] },
  'zoom.us': { folderName: 'Communication', tags: ['video', 'meetings', 'zoom'] },
  'mail.google.com': { folderName: 'Communication', tags: ['email', 'gmail'] },
  'gmail.com': { folderName: 'Communication', tags: ['email', 'gmail'] },
  'translate.google.com': { folderName: 'Languages & Translation', tags: ['translation', 'languages', 'google'] },
  'maps.google.com': { folderName: 'Maps & Navigation', tags: ['maps', 'navigation', 'google'] },
  'drive.google.com': { folderName: 'Productivity', tags: ['cloud', 'storage', 'google'] },
  
  'google.com': { folderName: 'Search Engines', tags: ['search', 'google'] },
  'bing.com': { folderName: 'Search Engines', tags: ['search', 'bing'] },
  'duckduckgo.com': { folderName: 'Search Engines', tags: ['search', 'privacy'] },
  
  'youtube.com': { folderName: 'Videos', tags: ['video', 'streaming', 'youtube'] },
  'youtu.be': { folderName: 'Videos', tags: ['video', 'streaming', 'youtube'] },
  
  'twitter.com': { folderName: 'Social Media', tags: ['social', 'news', 'twitter'] },
  'x.com': { folderName: 'Social Media', tags: ['social', 'news', 'x'] },
  'linkedin.com': { folderName: 'Social Media', tags: ['social', 'professional', 'jobs'] },
  'reddit.com': { folderName: 'Forums & Communities', tags: ['forum', 'community', 'reddit'] },
  'instagram.com': { folderName: 'Social Media', tags: ['social', 'photos', 'instagram'] },
  'facebook.com': { folderName: 'Social Media', tags: ['social', 'facebook'] },
  
  'figma.com': { folderName: 'Design', tags: ['design', 'ui', 'figma'] },
  'canva.com': { folderName: 'Design', tags: ['design', 'templates', 'canva'] }
};

function getDeterministicClassification(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    
    // Check local protocols
    if (protocol === 'file:') {
      return { folderName: 'Utilities', tags: ['local', 'file'], confidence: 1.0, isNew: false, deterministic: true };
    }
    if (protocol === 'chrome:' || protocol === 'chrome-extension:' || protocol === 'about:') {
      return { folderName: 'Utilities', tags: ['system', 'browser'], confidence: 1.0, isNew: false, deterministic: true };
    }
    
    const host = parsed.hostname.toLowerCase();
    
    // Check local domains
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
      return { folderName: 'Development/Localhost', tags: ['local', 'dev', 'testing'], confidence: 1.0, isNew: false, deterministic: true };
    }
    
    // If it's a search results page (e.g. google.com/search?q=..., duckduckgo.com/?q=...), 
    // do NOT categorize it deterministically as a Search Engine. Let it go to the AI/scraper 
    // so we classify the actual topic of the search (e.g. "wonder.so figma" -> Design).
    const isSearchQuery = parsed.pathname.includes('/search') || parsed.searchParams.has('q') || parsed.searchParams.has('query');
    if (isSearchQuery) {
      return null;
    }

    // Match against static list
    if (STATIC_CLASSIFICATION_MAP[host]) {
      return { ...STATIC_CLASSIFICATION_MAP[host], confidence: 1.0, isNew: false, deterministic: true };
    }
    for (const [key, mapping] of Object.entries(STATIC_CLASSIFICATION_MAP)) {
      if (key === 'google.com') {
        if (host === 'google.com' || host === 'www.google.com') {
          return { ...mapping, confidence: 1.0, isNew: false, deterministic: true };
        }
        continue;
      }
      if (host === key || host.endsWith('.' + key)) {
        return { ...mapping, confidence: 1.0, isNew: false, deterministic: true };
      }
    }
  } catch (e) {
    // Ignore invalid/malformed URLs
  }
  return null;
}

async function getUserCorrection(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const domain = host.replace(/^www\./, '');
    
    const data = await new Promise(r => chrome.storage.local.get({ userCorrections: {} }, r));
    const corrections = data.userCorrections || {};
    
    if (corrections[url]) {
      return { folderName: corrections[url], confidence: 1.0, tags: [], isNew: false, source: 'user-correction-url' };
    }
    if (corrections[domain]) {
      return { folderName: corrections[domain], confidence: 1.0, tags: [], isNew: false, source: 'user-correction-domain' };
    }
  } catch (e) {
    // Ignore invalid url
  }
  return null;
}

async function getAllFolderPaths(rootFolderId) {
  try {
    const tree = await chrome.bookmarks.getSubTree(rootFolderId || '1');
    const paths = [];
    function traverse(node, currentPath) {
      if (!node.url && node.id !== '0' && node.id !== '1' && node.id !== '2') {
        const nodePath = currentPath ? `${currentPath}/${node.title}` : node.title;
        if (node.title && node.id !== rootFolderId) {
          paths.push(nodePath);
        }
        if (node.children) {
          node.children.forEach(child => traverse(child, node.id === rootFolderId ? '' : nodePath));
        }
      }
    }
    if (tree && tree[0]) {
      traverse(tree[0], '');
    }
    return paths;
  } catch (err) {
    return [];
  }
}

async function getCachedClassification(url) {
  return new Promise(resolve => {
    chrome.storage.local.get({ webookCache: {} }, (data) => {
      resolve(data.webookCache[url] || null);
    });
  });
}

async function setCachedClassification(url, classification) {
  return new Promise(resolve => {
    chrome.storage.local.get({ webookCache: {} }, (data) => {
      data.webookCache[url] = {
        folderName: classification.folderName,
        tags: classification.tags || [],
        timestamp: Date.now()
      };
      chrome.storage.local.set({ webookCache: data.webookCache }, resolve);
    });
  });
}

async function invalidateCachedClassification(url) {
  return new Promise(resolve => {
    chrome.storage.local.get({ webookCache: {} }, (data) => {
      if (data.webookCache[url]) {
        delete data.webookCache[url];
        chrome.storage.local.set({ webookCache: data.webookCache }, resolve);
      } else {
        resolve();
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBFOLDER RESOLUTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function resolveFolderPath(pathString, rootFolderId) {
  const currentRoot = rootFolderId || '1';
  if (!pathString || pathString.trim() === '') return currentRoot;
  
  // Split path by "/", "\", or ">"
  const segments = pathString.split(/\s*[\/\\>]\s*/).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return currentRoot;
  
  let currentParentId = currentRoot;
  for (const segment of segments) {
    const cacheKey = `${currentParentId}:${segment.toLowerCase()}`;
    
    // If a folder creation promise is already active for this parent+title, reuse it
    if (folderCreationPromises.has(cacheKey)) {
      currentParentId = await folderCreationPromises.get(cacheKey);
      continue;
    }
    
    const resolveSegmentPromise = (async () => {
      const children = await chrome.bookmarks.getChildren(currentParentId);
      const folder = children.find(child => !child.url && child.title.toLowerCase() === segment.toLowerCase());
      
      if (folder) {
        return folder.id;
      } else {
        const newFolder = await chrome.bookmarks.create({
          parentId: currentParentId,
          title: segment
        });
        return newFolder.id;
      }
    })();
    
    folderCreationPromises.set(cacheKey, resolveSegmentPromise);
    try {
      currentParentId = await resolveSegmentPromise;
    } finally {
      folderCreationPromises.delete(cacheKey);
    }
  }
  return currentParentId;
}

async function getBookmarkLevel(bookmarkId, configRoot) {
  let level = 0;
  let currentId = bookmarkId;
  const stopIds = new Set(['0', '1', '2', '3', 'root________']);
  
  while (currentId && currentId !== configRoot && !stopIds.has(currentId)) {
    try {
      const node = (await chrome.bookmarks.get(currentId))[0];
      if (node) {
        level++;
        currentId = node.parentId;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return level;
}

async function getFolderPath(folderId, rootFolderId) {
  const pathSegments = [];
  let currentId = folderId;
  const stopIds = new Set(['0', '1', '2', 'root________', rootFolderId]);

  try {
    while (currentId && !stopIds.has(currentId)) {
      const node = (await chrome.bookmarks.get(currentId))[0];
      if (node && !node.url) {
        pathSegments.unshift(node.title);
        currentId = node.parentId;
      } else {
        break;
      }
    }
  } catch (e) {
    // Parent folder might be deleted or inaccessible
  }
  return pathSegments;
}

function pathsMatch(path1, path2) {
  const segments1 = Array.isArray(path1) ? path1 : path1.split(/\s*[\/\\>]\s*/).map(s => s.trim()).filter(Boolean);
  const segments2 = Array.isArray(path2) ? path2 : path2.split(/\s*[\/\\>]\s*/).map(s => s.trim()).filter(Boolean);
  
  if (segments1.length !== segments2.length) return false;
  for (let i = 0; i < segments1.length; i++) {
    if (normalizeFolderName(segments1[i]) !== normalizeFolderName(segments2[i])) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZER
// NORMALIZER
// ─────────────────────────────────────────────────────────────────────────────
function normalizeFolderName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, '')
    .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL / STARTUP
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Seed sensible defaults on installation
    chrome.storage.local.set({
      rootFolder: '1',
      autoOrganize: true,
      showNotifications: true,
      weeklyDigest: true,
      bookmarkTags: {},
      webookCache: {},
      userCorrections: {},
      activityLogs: [],
      installedAt: Date.now(),
      bulkOrganizeStatus: null,
      linkCheckStatus: null,
      keepUserFolders: true
    });
  } else {
    // On update/re-install, just clear any hung states and record/keep installedAt
    chrome.storage.local.get({ installedAt: Date.now(), bulkOrganizeState: null, linkCheckState: null }, (data) => {
      const updates = { installedAt: data.installedAt };
      if (!data.bulkOrganizeState) updates.bulkOrganizeStatus = null;
      if (!data.linkCheckState) updates.linkCheckStatus = null;
      chrome.storage.local.set(updates, () => {
        resumeInterruptedTasks();
      });
    });
  }

  // Feature 9: Context Menu - clear first to prevent duplicate ID errors (idempotent)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'webook-save',
      title: 'Save to WeBook',
      contexts: ['page', 'link']
    });
  });

  // Feature 10: Weekly Digest alarm
  chrome.alarms.get('weekly-digest', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('weekly-digest', { periodInMinutes: 10080 });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['bulkOrganizeState', 'linkCheckState'], (data) => {
    const updates = {};
    if (!data.bulkOrganizeState) updates.bulkOrganizeStatus = null;
    if (!data.linkCheckState) updates.linkCheckStatus = null;
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates, () => {
        resumeInterruptedTasks();
      });
    } else {
      resumeInterruptedTasks();
    }
  });

  chrome.alarms.get('weekly-digest', (alarm) => {
    if (!alarm) chrome.alarms.create('weekly-digest', { periodInMinutes: 10080 });
  });
});

// Feature 10: Weekly digest notification
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'weekly-digest') return;
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  chrome.storage.local.get({ activityLogs: [] }, (data) => {
    const weekLogs = data.activityLogs.filter(l => l.timestamp > oneWeekAgo && l.success);
    if (weekLogs.length === 0) return;
    const folders = {};
    weekLogs.forEach(l => { if (l.folderName) folders[l.folderName] = (folders[l.folderName] || 0) + 1; });
    const topFolder = Object.entries(folders).sort((a, b) => b[1] - a[1])[0];
    chrome.notifications.create('weekly-digest', {
      type: 'basic', iconUrl: 'icon.png',
      title: '📚 WeBook Weekly Digest',
      message: `You organized ${weekLogs.length} bookmark${weekLogs.length !== 1 ? 's' : ''} this week!${topFolder ? ` Most active: "${topFolder[0]}"` : ''}`,
      priority: 1
    });
  });
});

// Feature 9: Context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'webook-save') return;
  const url = info.linkUrl || info.pageUrl;
  const title = info.linkUrl ? url : (tab.title || url);
  try {
    // Add the normalized URL to pending set so that onCreated listener will process it
    const normalized = normalizeUrlForMatch(url);
    if (normalized) {
      pendingAutoOrganizeUrls.add(normalized);
    }
    // Just create the bookmark. The chrome.bookmarks.onCreated listener
    // will catch it and run auto-organization, avoiding double processing.
    await chrome.bookmarks.create({ parentId: '2', title, url });
  } catch (e) {
    const normalized = normalizeUrlForMatch(url);
    if (normalized) {
      pendingAutoOrganizeUrls.delete(normalized);
    }
    console.error('WeBook context menu error:', e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOKMARK CREATION LISTENER
// ─────────────────────────────────────────────────────────────────────────────
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (!bookmark.url) return;

  const normalized = normalizeUrlForMatch(bookmark.url);
  // Only auto-organize bookmarks created via WeBook's right-click context menu
  if (!pendingAutoOrganizeUrls.has(normalized)) {
    console.log('[WeBook] Skipping auto-organization for bookmark created outside WeBook context menu:', bookmark.title);
    return;
  }
  // Remove from the set so we don't leak memory or trigger on subsequent duplicate actions
  pendingAutoOrganizeUrls.delete(normalized);

  chrome.storage.local.get({ rootFolder: '1', autoOrganize: true, showNotifications: true, keepUserFolders: true, installedAt: 0 }, async (settings) => {
    if (!settings.autoOrganize) return;

    if (settings.keepUserFolders) {
      const configRoot = await getRealFolderId('1');
      const level = await getBookmarkLevel(bookmark.parentId, configRoot);
      if (level >= 2) {
        console.log('[WeBook] Skipping auto-organization because bookmark is inside a deep custom/pre-existing folder:', bookmark.title);
        return;
      }
    }

    let installedAt = settings.installedAt;
    if (!installedAt) {
      installedAt = Date.now();
      chrome.storage.local.set({ installedAt });
    }

    // Ignore bookmarks created before installation (e.g. syncing existing bookmarks)
    // We add a 10-second margin to prevent race conditions during install.
    if (bookmark.dateAdded && bookmark.dateAdded < installedAt - 10000) {
      console.log('WeBook: Skipping auto-organization for pre-existing/sync bookmark:', bookmark.title);
      return;
    }

    if (processingIds.has(id)) return;
    processingIds.add(id);
    setTimeout(async () => {
      try {
        const updated = await chrome.bookmarks.get(id);
        if (!updated || updated.length === 0) { processingIds.delete(id); return; }
        await processSingleBookmark(updated[0], settings);
      } catch (error) {
        console.error('WeBook Error:', error);
        logActivity({ id, title: bookmark.title || bookmark.url, url: bookmark.url, success: false, error: error.message, timestamp: Date.now() });
      } finally { processingIds.delete(id); }
    }, 5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CACHE INVALIDATION LISTENERS (onChanged / onRemoved)
// ─────────────────────────────────────────────────────────────────────────────
chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  try {
    const bmList = await chrome.bookmarks.get(id);
    if (bmList && bmList.length > 0) {
      const bm = bmList[0];
      if (bm.url) {
        const localCleanUrl = getCleanedUrl(bm.url);
        const effectiveUrl = localCleanUrl || bm.url;
        await invalidateCachedClassification(effectiveUrl);
        console.log(`[WeBook] Cache invalidated (onChanged) for URL: ${effectiveUrl}`);
      }
    }
  } catch (e) {
    // Ignore error if bookmark is deleted/missing
  }
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  triggerRemoveEmptyFolders();
  try {
    if (removeInfo && removeInfo.node && removeInfo.node.url) {
      const localCleanUrl = getCleanedUrl(removeInfo.node.url);
      const effectiveUrl = localCleanUrl || removeInfo.node.url;
      await invalidateCachedClassification(effectiveUrl);
      console.log(`[WeBook] Cache invalidated (onRemoved) for URL: ${effectiveUrl}`);
    }
  } catch (e) {
    // Ignore error
  }
});

chrome.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  triggerRemoveEmptyFolders();

  if (autoMovingIds.has(id)) return;

  try {
    const session = await new Promise(r => chrome.storage.local.get({ systemActionInProgress: false }, r));
    if (session.systemActionInProgress) return;

    const bmList = await chrome.bookmarks.get(id);
    if (!bmList || bmList.length === 0) return;
    const bm = bmList[0];
    if (!bm.url) return;

    const settings = await new Promise(r => chrome.storage.local.get({ licenseKey: '' }, r));
    const licenseKey = settings.licenseKey || '';
    const rootFolderId = await getRealFolderId('1');

    const newPathSegments = await getFolderPath(moveInfo.parentId, rootFolderId);
    const oldPathSegments = await getFolderPath(moveInfo.oldParentId, rootFolderId);

    const newPath = newPathSegments.join('/');
    const oldPath = oldPathSegments.join('/');

    if (newPath === oldPath) return;

    console.log(`[WeBook] User correction detected: "${bm.title}" moved from "${oldPath}" to "${newPath}"`);

    const localCleanUrl = getCleanedUrl(bm.url);
    const effectiveUrl = localCleanUrl || bm.url;
    await invalidateCachedClassification(effectiveUrl);

    const data = await new Promise(r => chrome.storage.local.get({ userCorrections: {} }, r));
    const corrections = data.userCorrections || {};
    const host = new URL(bm.url).hostname.toLowerCase();
    const domain = host.replace(/^www\./, '');

    corrections[bm.url] = newPath;
    corrections[domain] = newPath;
    await new Promise(r => chrome.storage.local.set({ userCorrections: corrections }, r));

    if (licenseKey) {
      fetch(`${PROXY_URL}/api/correct-category`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-license-key': licenseKey
        },
        body: JSON.stringify({
          url: bm.url,
          correctedFolder: newPath,
          originalFolder: oldPath
        })
      }).then(res => {
        if (res.ok) console.log(`[WeBook] Correction successfully sync'd to server`);
        else console.warn(`[WeBook] Failed to sync correction to server:`, res.status);
      }).catch(err => {
        console.error(`[WeBook] Network error syncing correction:`, err);
      });
    }
  } catch (err) {
    console.error('[WeBook] Error in onMoved listener:', err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate that the message is sent from our own extension
  if (sender.id && sender.id !== chrome.runtime.id) {
    console.warn(`[WeBook] Ignored message from untrusted sender: ${sender.id}`);
    return;
  }

  if (message.action === 'organize_existing') {
    organizeAllExistingBookmarks();
  } else if (message.action === 'check_broken_links') {
    checkBrokenLinks();
  } else if (message.action === 'cancel_bulk_organize') {
    isBulkOrganizeCancelled = true;
  } else if (message.action === 'cancel_link_check') {
    isLinkCheckCancelled = true;
  } else if (message.action === 'start_search_index') {
    startSearchIndexing();
  } else if (message.action === 'cancel_search_index') {
    isSearchIndexCancelled = true;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PROCESSING LOGIC
// ─────────────────────────────────────────────────────────────────────────────
async function processSingleBookmark(bookmark, settings) {
  const { showNotifications, keepUserFolders } = settings;
  const configRoot = await getRealFolderId('1');

  // 1. Deterministic URL & title cleaning
  const localCleanUrl = getCleanedUrl(bookmark.url);
  const localCleanTitle = localCleanUrl !== null ? extractBrandName(bookmark.url) : null;
  const effectiveUrl = localCleanUrl || bookmark.url;
  let effectiveTitle = localCleanTitle || bookmark.title;

  // Force YouTube URLs to have the title "YouTube"
  if (isYouTubeUrl(bookmark.url)) {
    effectiveTitle = "YouTube";
  }

  // Feature 2: Duplicate detection
  const existingMatches = await chrome.bookmarks.search({ url: effectiveUrl });
  const duplicates = existingMatches.filter(b => b.id !== bookmark.id && b.url === effectiveUrl);
  if (duplicates.length > 0) {
    console.log(`WeBook: Duplicate detected for "${effectiveTitle}" — skipping.`);
    if (showNotifications) {
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icon.png', title: 'Already Saved!',
        message: `"${effectiveTitle}" is already in your bookmarks.`, priority: 0
      });
    }
    // Still clean title/URL even on duplicate
    const updateData = {};
    if (effectiveTitle && effectiveTitle.trim().toLowerCase() !== bookmark.title.trim().toLowerCase()) updateData.title = effectiveTitle;
    if (effectiveUrl && effectiveUrl.trim().toLowerCase() !== bookmark.url.trim().toLowerCase()) updateData.url = effectiveUrl;
    if (Object.keys(updateData).length > 0) await chrome.bookmarks.update(bookmark.id, updateData);
    return;
  }

  // 3. Get existing folder paths recursively
  const originalFolderPaths = await getAllFolderPaths(configRoot);

  // 4. Classification (deterministic -> user correction -> cache -> AI classification)
  let classification = getDeterministicClassification(effectiveUrl);
  if (classification) {
    console.log(`[WeBook] Deterministic classification used for: ${effectiveUrl} -> Folder: "${classification.folderName}"`);
  } else {
    classification = await getUserCorrection(effectiveUrl);
    if (classification) {
      console.log(`[WeBook] User correction used for: ${effectiveUrl} -> Folder: "${classification.folderName}"`);
    } else {
      classification = await getCachedClassification(effectiveUrl);
      if (classification) {
        console.log(`[WeBook] Cached classification used for: ${effectiveUrl} -> Folder: "${classification.folderName}"`);
      } else {
        console.log(`[WeBook] AI classification requested for: ${effectiveUrl}`);
        classification = await classifyBookmark(effectiveTitle, effectiveUrl, originalFolderPaths);
        // Save to cache
        await setCachedClassification(effectiveUrl, classification);
      }
    }
  }

  let targetFolderName = classification.folderName.trim();

  if (keepUserFolders) {
    const level = await getBookmarkLevel(bookmark.parentId, configRoot);
    if (level === 1) {
      try {
        const parentNode = (await chrome.bookmarks.get(bookmark.parentId))[0];
        if (parentNode && parentNode.title) {
          // Prevent duplicating the folder name if the target folder matches the parent folder
          const firstSegment = targetFolderName.split(/[\/\\>]/)[0].trim();
          if (normalizeFolderName(parentNode.title) !== normalizeFolderName(firstSegment)) {
            targetFolderName = `${parentNode.title}/${targetFolderName}`;
          }
        }
      } catch (e) {
        console.error('[WeBook] Error getting parent folder name:', e);
      }
    }
  }

  const tags = enrichTags(classification.tags, effectiveTitle, effectiveUrl, targetFolderName);

  // 5. Find or create folder (handles nested subfolders)
  const targetFolderId = await resolveFolderPath(targetFolderName, configRoot);

  // 6. Apply updates
  const updateData = {};
  if (effectiveTitle && effectiveTitle.trim().toLowerCase() !== bookmark.title.trim().toLowerCase()) updateData.title = effectiveTitle;
  if (effectiveUrl && effectiveUrl.trim().toLowerCase() !== bookmark.url.trim().toLowerCase()) updateData.url = effectiveUrl;
  if (Object.keys(updateData).length > 0) await chrome.bookmarks.update(bookmark.id, updateData);

  const finalTitle = updateData.title || bookmark.title;
  const finalUrl = updateData.url || bookmark.url;

  // 7. Move
  if (bookmark.parentId !== targetFolderId) {
    autoMovingIds.add(bookmark.id);
    try {
      await chrome.bookmarks.move(bookmark.id, { parentId: targetFolderId });
    } finally {
      setTimeout(() => {
        autoMovingIds.delete(bookmark.id);
      }, 1000);
    }
  }

  // Feature 5: Store tags
  if (tags.length > 0) {
    chrome.storage.local.get({ bookmarkTags: {} }, (data) => {
      if (!data.bookmarkTags[bookmark.id] || data.bookmarkTags[bookmark.id].length === 0) {
        data.bookmarkTags[bookmark.id] = tags;
        chrome.storage.local.set({ bookmarkTags: data.bookmarkTags });
      }
    });
  }

  // 8. Log + notify
  await logActivity({ id: bookmark.id, title: finalTitle, url: finalUrl, folderName: targetFolderName, tags, success: true, timestamp: Date.now() });

  if (showNotifications) {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icon.png', title: 'Bookmark Organized',
      message: `"${finalTitle}" → "${targetFolderName}"`, priority: 0
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CLASSIFICATION (folder + tags)
// ─────────────────────────────────────────────────────────────────────────────
async function classifyBookmark(title, url, existingFolders) {
  // Get license key from storage
  const settings = await new Promise(r => chrome.storage.local.get({ licenseKey: '' }, r));
  const licenseKey = settings.licenseKey || '';

  try {
    // #11 — Use fetchWithRetry with 1 retry and 28s timeout
    const response = await fetchWithRetry(`${PROXY_URL}/api/classify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-license-key': licenseKey
      },
      body: JSON.stringify({ title, url, existingFolders })
    }, 1, 28000); // 1 retry, 28s timeout each

    if (!response.ok) {
      // On 504 (gateway timeout) or other server errors, use local fallback
      console.warn(`[WeBook] AI classify returned ${response.status} for "${title}" — using local fallback`);
      return buildLocalFallback(title, url, existingFolders);
    }

    return response.json();
  } catch (err) {
    // On network timeout or connection failure, use local fallback silently
    const isTimeout = err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('abort'));
    console.warn(`[WeBook] AI classify ${isTimeout ? 'timed out' : 'failed'} for "${title}" — using local fallback. Error: ${err.message}`);
    return buildLocalFallback(title, url, existingFolders);
  }
}

// Local keyword-based fallback used when AI server is unavailable or times out
function buildLocalFallback(title, url, existingFolders) {
  const combined = `${title} ${url}`.toLowerCase();
  let folderName = 'Miscellaneous'; // NEVER fallback to 'Uncategorized'

  if (/youtube|netflix|twitch|spotify|vimeo|tiktok|movies|cinema|cinesubz|yts|1337x/.test(combined)) folderName = 'Entertainment';
  else if (/github|stackoverflow|codepen|dev\.to|npm|docs\.|api\./.test(combined))  folderName = 'Dev Tools';
  else if (/news|cnn|bbc|reuters|techcrunch|verge|wired|nytimes/.test(combined)) folderName = 'News';
  else if (/twitter|x\.com|reddit|linkedin|facebook|instagram/.test(combined)) folderName = 'Social Media';
  else if (/amazon|ebay|etsy|shopify|aliexpress|shop|store/.test(combined))               folderName = 'Shopping';
  else if (/chatgpt|openai|gemini|claude|midjourney|huggingface|gpt|krea|fal/.test(combined)) folderName = 'AI Tools';
  else if (/google|drive|notion|trello|slack|figma|canva|accounting/.test(combined))      folderName = 'Productivity';
  else if (/telegram|whatsapp|mail|gmail|zoho|proton|tuta/.test(combined))                folderName = 'Communication';
  else if (/college|university|school|education|learning|course|qualification|cim|cambridge/.test(combined)) folderName = 'Learning';
  else if (/visa|government|gov\./.test(combined))                                        folderName = 'Government';
  else if (/ca sri lanka|finance|bank|invest|stripe/.test(combined))                      folderName = 'Finance';

  // If the user already has a similar folder, try to match it
  if (Array.isArray(existingFolders)) {
    for (const f of existingFolders) {
      if (combined.includes(f.toLowerCase())) {
        folderName = f;
        break;
      }
    }
  }

  return {
    folderName,
    confidence: 0.4,
    tags: [],
    isNew: !Array.isArray(existingFolders) || !existingFolders.some(f => f.toLowerCase() === folderName.toLowerCase()),
    source: 'local-fallback'
  };
}

// ── Helpers for Task State Tracking ──
function updateBulkStatus(statusData) {
  chrome.storage.local.set({ bulkOrganizeStatus: statusData });
  chrome.runtime.sendMessage({ action: 'bulk_progress', data: statusData }, () => {
    // Suppress error when popup is closed and no listener exists
    const err = chrome.runtime.lastError;
  });
}

function updateLinkCheckStatus(statusData) {
  chrome.storage.local.set({ linkCheckStatus: statusData });
  chrome.runtime.sendMessage({ action: 'link_check_progress', data: statusData }, () => {
    const err = chrome.runtime.lastError;
  });
}

function updateSearchIndexStatus(statusData) {
  chrome.storage.local.set({ searchIndexStatus: statusData });
  chrome.runtime.sendMessage({ action: 'search_index_progress', data: statusData }, () => {
    const err = chrome.runtime.lastError;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 4: BROKEN LINK CHECKER
// ─────────────────────────────────────────────────────────────────────────────
async function checkBrokenLinks() {
  const tree = await chrome.bookmarks.getTree();
  const allBookmarks = [];
  function scanAll(node) {
    if (node.url) allBookmarks.push(node);
    if (node.children) node.children.forEach(scanAll);
  }
  tree.forEach(scanAll);

  const total = allBookmarks.length;
  const dead = [];
  let checked = 0;

  isLinkCheckCancelled = false;
  updateLinkCheckStatus({ status: 'scanning', checked: 0, total, dead: [] });

  const settings = await new Promise(r => chrome.storage.local.get({ licenseKey: '' }, r));
  const licenseKey = settings.licenseKey || '';

  // Group bookmarks by unique URL
  const urlMap = new Map();
  const webUrls = [];
  
  for (const bm of allBookmarks) {
    const url = bm.url || '';
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      checked++; // Mark non-HTTP/HTTPS links as checked immediately
      continue;
    }
    if (!urlMap.has(url)) {
      urlMap.set(url, []);
      webUrls.push(url);
    }
    urlMap.get(url).push(bm);
  }

  // Report initial progress for skipped non-web links
  if (checked > 0) {
    updateLinkCheckStatus({ status: 'scanning', checked, total, dead });
  }

  const poolSize = 5;
  const queue = [...webUrls];
  const activePromises = [];
  let consecutiveErrors = 0;

  async function worker() {
    while (queue.length > 0 && !isLinkCheckCancelled) {
      const url = queue.shift();
      if (!url) continue;

      const associated = urlMap.get(url) || [];
      let isApiError = false;
      let deadStatus = null;

      try {
        const res = await fetch(`${PROXY_URL}/api/check-link`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-license-key': licenseKey
          },
          body: JSON.stringify({ url })
        });
        if (res.ok) {
          consecutiveErrors = 0; // reset
          const data = await res.json();
          if (data.status === 'error' || data.status >= 400) {
            deadStatus = data.status;
          }
        } else {
          isApiError = true;
          deadStatus = res.status;
        }
      } catch (e) {
        isApiError = true;
        deadStatus = 'timeout/error';
      }

      if (deadStatus !== null) {
        associated.forEach(bm => {
          dead.push({ id: bm.id, title: bm.title, url: bm.url, status: deadStatus });
        });
      }

      if (isApiError) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          console.error('[WeBook] Aborting link check due to consecutive API/network failures.');
          isLinkCheckCancelled = true;
          updateLinkCheckStatus({ status: 'error', checked, total, dead, error: 'Multiple network/API failures. Please verify connection.' });
          chrome.storage.local.remove('linkCheckState');
          return;
        }
      }

      checked += associated.length;
      updateLinkCheckStatus({ status: 'scanning', checked: Math.min(checked, total), total, dead });

      // Save state for resumability
      chrome.storage.local.set({
        linkCheckState: {
          status: 'scanning',
          checked: Math.min(checked, total),
          total,
          dead,
          queue,
          urlMapArray: Array.from(urlMap.entries())
        }
      });
    }
  }

  for (let i = 0; i < Math.min(poolSize, queue.length); i++) {
    activePromises.push(worker());
  }

  await Promise.all(activePromises);

  if (!isLinkCheckCancelled && checked >= total) {
    updateLinkCheckStatus({ status: 'done', checked: total, total, dead });
    chrome.storage.local.remove('linkCheckState');
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────
async function logActivity(logEntry) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ activityLogs: [] }, (data) => {
      const logs = [logEntry, ...data.activityLogs].slice(0, 200);
      chrome.storage.local.set({ activityLogs: logs }, resolve);
    });
  });
}

function isYouTubeUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be') || host.includes('youtube-nocookie.com');
  } catch {
    return false;
  }
}

async function getAllUserFolders() {
  const tree = await chrome.bookmarks.getTree();
  const folders = [];
  function scan(node) {
    if (!node.url && node.id !== '0' && node.id !== '1' && node.id !== '2') {
      folders.push(node);
    }
    if (node.children) node.children.forEach(scan);
  }
  tree.forEach(scan);
  return folders;
}

async function cleanExistingFolders(settings) {
  try {
    const folders = await getAllUserFolders();
    if (folders.length === 0) return;

    const folderNames = folders.map(f => f.title);
    const licenseKey = settings.licenseKey || '';

    // #8 — Client-side folder hash cache: skip API if folders unchanged
    const { hash, mapping: cachedMapping } = await getFolderCleanCache(folderNames);
    let mapping;
    if (cachedMapping) {
      console.log('[WeBook] Folder clean cache hit — skipping /api/clean-folders call');
      mapping = cachedMapping;
    } else {
      const response = await fetch(`${PROXY_URL}/api/clean-folders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-license-key': licenseKey
        },
        body: JSON.stringify({ folderNames })
      });

      if (!response.ok) {
        console.warn('cleanExistingFolders response not ok:', response.status);
        return;
      }

      const data = await response.json();
      mapping = data.mapping;
      if (!mapping) return;
      // #8 — Save to client-side cache
      await setFolderCleanCache(hash, mapping);
    }
    
    for (const folder of folders) {
      const originalTitle = folder.title;
      const cleanTitle = mapping[originalTitle];
      if (cleanTitle && cleanTitle.trim() !== '' && cleanTitle !== originalTitle) {
        const parentId = folder.parentId;
        const siblings = await chrome.bookmarks.getChildren(parentId);
        const duplicateFolder = siblings.find(s => !s.url && s.title.toLowerCase() === cleanTitle.toLowerCase());
        
        if (duplicateFolder) {
          // Merge
          const children = await chrome.bookmarks.getChildren(folder.id);
          for (const child of children) {
            await chrome.bookmarks.move(child.id, { parentId: duplicateFolder.id });
          }
          await chrome.bookmarks.remove(folder.id);
        } else {
          // Rename in-place
          await chrome.bookmarks.update(folder.id, { title: cleanTitle });
        }
      }
    }
  } catch (err) {
    console.error('Error cleaning existing folders:', err);
  }
}
// ── Remove Empty Folders ──
async function removeEmptyFolders() {
  const tree = await chrome.bookmarks.getTree();
  const systemFolderIds = new Set(['0', '1', '2', '3', 'root________']);

  async function cleanNode(node) {
    if (!node.children) return;
    
    for (const child of node.children) {
      await cleanNode(child);
    }
    
    try {
      const updatedNode = (await chrome.bookmarks.getSubTree(node.id))[0];
      if (!systemFolderIds.has(updatedNode.id) && updatedNode.title !== 'WeBook Tab Groups' && (!updatedNode.children || updatedNode.children.length === 0)) {
        await chrome.bookmarks.remove(updatedNode.id);
        console.log(`Deleted empty folder: ${updatedNode.title} (ID: ${updatedNode.id})`);
      }
    } catch (err) {
      // Node may already be deleted or missing
    }
  }

  for (const rootNode of tree) {
    await cleanNode(rootNode);
  }
}

let removeEmptyFoldersTimer = null;
function triggerRemoveEmptyFolders() {
  clearTimeout(removeEmptyFoldersTimer);
  removeEmptyFoldersTimer = setTimeout(async () => {
    try {
      await removeEmptyFolders();
    } catch (err) {
      console.error('[WeBook] Error auto-cleaning empty folders:', err);
    }
  }, 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK ORGANIZER
// ─────────────────────────────────────────────────────────────────────────────
async function organizeAllExistingBookmarks() {
  chrome.storage.local.get({ rootFolder: '1', showNotifications: true, keepUserFolders: true, licenseKey: '' }, async (settings) => {
    try {
      // Set systemActionInProgress to avoid registering correction moves
      await new Promise(r => chrome.storage.local.set({ systemActionInProgress: true }, r));
      updateBulkStatus({ status: 'processing', current: 0, total: 100, progress: 0, details: 'Scanning library...' });
      
      const tree = await chrome.bookmarks.getTree();
      const allBookmarks = [];
      function scan(node, inTabGroupsFolder = false) {
        const isTabGroups = !node.url && node.title === 'WeBook Tab Groups';
        const inside = inTabGroupsFolder || isTabGroups;

        if (node.url && !inside) {
          allBookmarks.push(node);
        }
        if (node.children) {
          node.children.forEach(child => scan(child, inside));
        }
      }
      tree.forEach(node => scan(node, false));

      // Build folder map
      const folderMap = new Map();
      function traverse(node) {
        if (!node.url && node.id !== '0' && node.id !== '1' && node.id !== '2') {
          if (node.title) {
            folderMap.set(normalizeFolderName(node.title), node.id);
          }
        }
        if (node.children) node.children.forEach(traverse);
      }
      tree.forEach(traverse);

      // Retrieve cache
      const cacheObj = await new Promise(r => chrome.storage.local.get({ webookCache: {} }, r));
      const webookCache = cacheObj.webookCache || {};

      const needsWork = [];
      const configRoot = await getRealFolderId('1');
      for (const bm of allBookmarks) {
        if (settings.keepUserFolders) {
          const level = await getBookmarkLevel(bm.parentId, configRoot);
          if (level >= 2) {
            continue;
          }
        }
        const localCleanUrl = getCleanedUrl(bm.url);
        const effectiveUrl = localCleanUrl || bm.url;

        // Check deterministic or user correction or cache
        let classification = getDeterministicClassification(effectiveUrl);
        if (!classification) {
          classification = await getUserCorrection(effectiveUrl);
        }
        if (!classification) {
          classification = webookCache[effectiveUrl] || null;
        }

        if (classification) {
          const currentPathSegments = await getFolderPath(bm.parentId, configRoot);
          if (pathsMatch(currentPathSegments, classification.folderName)) {
            // Already categorized and in the correct nested folder path!
            continue;
          }
        }
        needsWork.push(bm);
      }

      const total = needsWork.length;
      if (total === 0) {
        updateBulkStatus({ status: 'completed', current: 0, total: 0, progress: 100, details: 'All bookmarks are already organized!' });
        chrome.storage.local.set({ initialAnalysisDone: true });
        if (settings.showNotifications) {
          chrome.notifications.create('bulk-organize-noop', {
            type: 'basic', iconUrl: 'icon.png', title: 'WeBook Bulk Organize',
            message: 'All bookmarks are already organized!', priority: 0
          });
        }
        return;
      }

      if (!settings.keepUserFolders) {
        // Clean and rename existing folders first, now that we know we have work to do
        updateBulkStatus({ status: 'processing', current: 0, total, progress: 0, details: 'Standardizing folders...' });
        await cleanExistingFolders(settings);
      }

      isBulkOrganizeCancelled = false;
      updateBulkStatus({ status: 'processing', current: 0, total, progress: 0, details: 'Starting...' });

      if (settings.showNotifications) {
        chrome.notifications.create('bulk-organize-start', {
          type: 'basic', iconUrl: 'icon.png', title: 'WeBook Bulk Organize',
          message: `Starting organization of ${total} bookmarks...`, priority: 0
        });
      }

      let successCount = 0;
      let errorCount = 0;
      let lastErrorMessage = '';

      for (let i = 0; i < total; i++) {
        if (isBulkOrganizeCancelled) {
          console.log('[WeBook] Bulk organize task terminated by user.');
          break;
        }
        const bm = needsWork[i];
        updateBulkStatus({ status: 'processing', current: i + 1, total, progress: Math.round(((i + 1) / total) * 100), details: bm.title || bm.url });
        try {
          const bulkSettings = { ...settings, showNotifications: false };
          await processSingleBookmark(bm, bulkSettings);
          successCount++;
        } catch (err) {
          errorCount++;
          lastErrorMessage = err.message;
          await logActivity({ id: bm.id, title: bm.title || bm.url, url: bm.url, success: false, error: err.message, timestamp: Date.now() });
        }

        // Save state for resumability
        await new Promise(r => chrome.storage.local.set({
          bulkOrganizeState: {
            status: 'processing',
            needsWorkIds: needsWork.map(b => b.id),
            currentIndex: i + 1,
            successCount,
            errorCount,
            lastErrorMessage
          }
        }, r));
      }

      if (isBulkOrganizeCancelled) {
        updateBulkStatus({ status: 'completed', current: successCount, total, progress: 100, details: 'Terminated by user' });
        chrome.storage.local.remove('bulkOrganizeState');
        if (settings.showNotifications) {
          chrome.notifications.create('bulk-organize-end', {
            type: 'basic', iconUrl: 'icon.png', title: 'Bulk Organize Terminated',
            message: `Terminated by user. Successfully organized ${successCount} of ${total} bookmarks.`, priority: 0
          });
        }
      } else {
        if (!settings.keepUserFolders) {
          // Clean up empty folders recursively
          updateBulkStatus({ status: 'processing', current: total, total, progress: 95, details: 'Cleaning up empty folders...' });
          await removeEmptyFolders();
        }

        updateBulkStatus({ status: 'completed', current: total, total, progress: 100 });
        chrome.storage.local.remove('bulkOrganizeState');
        chrome.storage.local.set({ initialAnalysisDone: true });

        if (settings.showNotifications) {
          let messageText = `Successfully organized ${successCount} of ${total} bookmarks.`;
          if (errorCount > 0) {
            messageText += ` (${errorCount} failed. Last error: ${lastErrorMessage})`;
          }
          chrome.notifications.create('bulk-organize-end', {
            type: 'basic', iconUrl: 'icon.png', title: 'Bulk Organize Completed',
            message: messageText, priority: 0
          });
        }
      }
    } catch (error) {
      updateBulkStatus({ status: 'error', details: error.message });
      if (settings.showNotifications) {
        chrome.notifications.create('bulk-organize-error', {
          type: 'basic', iconUrl: 'icon.png', title: 'Bulk Organize Error',
          message: `Failed: ${error.message}`, priority: 0
        });
      }
    } finally {
      // Always reset systemActionInProgress
      await new Promise(r => chrome.storage.local.set({ systemActionInProgress: false }, r));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE: RESUMABLE TASKS (CRASH/CLOSURE RECOVERY)
// ─────────────────────────────────────────────────────────────────────────────
async function resumeInterruptedTasks() {
  chrome.storage.local.get(['bulkOrganizeState', 'linkCheckState', 'searchIndexStatus'], async (data) => {
    if (data.bulkOrganizeState && data.bulkOrganizeState.status === 'processing') {
      console.log('[WeBook] Resuming interrupted bulk organization task...');
      resumeBulkOrganize(data.bulkOrganizeState);
    }
    if (data.linkCheckState && data.linkCheckState.status === 'scanning') {
      console.log('[WeBook] Resuming interrupted link checker task...');
      resumeLinkCheck(data.linkCheckState);
    }
    if (data.searchIndexStatus && data.searchIndexStatus.status === 'processing') {
      console.log('[WeBook] Resuming interrupted search indexing task...');
      startSearchIndexing();
    }
  });
}

async function resumeBulkOrganize(state) {
  const settings = await new Promise(r => chrome.storage.local.get({ rootFolder: '1', showNotifications: true, keepUserFolders: true, licenseKey: '' }, r));
  
  try {
    await new Promise(r => chrome.storage.local.set({ systemActionInProgress: true }, r));
    
    const needsWork = [];
    for (const id of state.needsWorkIds) {
      try {
        const results = await chrome.bookmarks.get(id);
        if (results && results[0]) needsWork.push(results[0]);
      } catch (e) {}
    }

    const total = needsWork.length;
    let successCount = state.successCount || 0;
    let errorCount = state.errorCount || 0;
    let lastErrorMessage = state.lastErrorMessage || '';
    const startIndex = state.currentIndex || 0;

    isBulkOrganizeCancelled = false;
    updateBulkStatus({ status: 'processing', current: startIndex, total, progress: Math.round((startIndex / total) * 100), details: 'Resuming...' });

    for (let i = startIndex; i < total; i++) {
      if (isBulkOrganizeCancelled) {
        console.log('[WeBook] Resumed bulk organize task terminated by user.');
        break;
      }
      const bm = needsWork[i];
      updateBulkStatus({ status: 'processing', current: i + 1, total, progress: Math.round(((i + 1) / total) * 100), details: bm.title || bm.url });
      
      try {
        const bulkSettings = { ...settings, showNotifications: false };
        await processSingleBookmark(bm, bulkSettings);
        successCount++;
      } catch (err) {
        errorCount++;
        lastErrorMessage = err.message;
        await logActivity({ id: bm.id, title: bm.title || bm.url, url: bm.url, success: false, error: err.message, timestamp: Date.now() });
      }

      // Save state for resumability
      await new Promise(r => chrome.storage.local.set({
        bulkOrganizeState: {
          status: 'processing',
          needsWorkIds: state.needsWorkIds,
          currentIndex: i + 1,
          successCount,
          errorCount,
          lastErrorMessage
        }
      }, r));
    }

    if (isBulkOrganizeCancelled) {
      updateBulkStatus({ status: 'completed', current: successCount, total, progress: 100, details: 'Terminated by user' });
      chrome.storage.local.remove('bulkOrganizeState');
    } else {
      if (!settings.keepUserFolders) {
        updateBulkStatus({ status: 'processing', current: total, total, progress: 95, details: 'Cleaning up empty folders...' });
        await removeEmptyFolders();
      }
      updateBulkStatus({ status: 'completed', current: total, total, progress: 100 });
      chrome.storage.local.remove('bulkOrganizeState');

      if (settings.showNotifications) {
        let messageText = `Successfully organized ${successCount} of ${total} bookmarks.`;
        if (errorCount > 0) {
          messageText += ` (${errorCount} failed. Last error: ${lastErrorMessage})`;
        }
        chrome.notifications.create('bulk-organize-end', {
          type: 'basic', iconUrl: 'icon.png', title: 'Bulk Organize Completed',
          message: messageText, priority: 0
        });
      }
    }
  } catch (err) {
    console.error('[WeBook] Error in resumed bulk organize:', err);
    chrome.storage.local.remove('bulkOrganizeState');
  } finally {
    await new Promise(r => chrome.storage.local.set({ systemActionInProgress: false }, r));
  }
}

async function resumeLinkCheck(state) {
  const settings = await new Promise(r => chrome.storage.local.get({ licenseKey: '' }, r));
  const licenseKey = settings.licenseKey || '';

  const dead = state.dead || [];
  let checked = state.checked || 0;
  const total = state.total || 0;
  const queue = state.queue || [];
  const urlMap = new Map(state.urlMapArray || []);

  isLinkCheckCancelled = false;
  updateLinkCheckStatus({ status: 'scanning', checked, total, dead });

  const poolSize = 5;
  const activePromises = [];
  let consecutiveErrors = 0;

  async function worker() {
    while (queue.length > 0 && !isLinkCheckCancelled) {
      const url = queue.shift();
      if (!url) continue;

      const associated = urlMap.get(url) || [];
      let isApiError = false;
      let deadStatus = null;

      try {
        const res = await fetch(`${PROXY_URL}/api/check-link`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-license-key': licenseKey
          },
          body: JSON.stringify({ url })
        });
        if (res.ok) {
          consecutiveErrors = 0;
          const data = await res.json();
          if (data.status === 'error' || data.status >= 400) {
            deadStatus = data.status;
          }
        } else {
          isApiError = true;
          deadStatus = res.status;
        }
      } catch (e) {
        isApiError = true;
        deadStatus = 'timeout/error';
      }

      if (deadStatus !== null) {
        associated.forEach(bm => {
          dead.push({ id: bm.id, title: bm.title, url: bm.url, status: deadStatus });
        });
      }

      if (isApiError) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          console.error('[WeBook] Aborting resumed link check due to consecutive failures.');
          isLinkCheckCancelled = true;
          updateLinkCheckStatus({ status: 'error', checked, total, dead, error: 'Multiple network/API failures. Please verify connection.' });
          chrome.storage.local.remove('linkCheckState');
          return;
        }
      }

      checked += associated.length;
      const statusData = { status: 'scanning', checked: Math.min(checked, total), total, dead };
      updateLinkCheckStatus(statusData);

      // Save state
      chrome.storage.local.set({
        linkCheckState: {
          status: 'scanning',
          checked: Math.min(checked, total),
          total,
          dead,
          queue,
          urlMapArray: Array.from(urlMap.entries())
        }
      });
    }
  }

  for (let i = 0; i < Math.min(poolSize, queue.length); i++) {
    activePromises.push(worker());
  }

  await Promise.all(activePromises);

  if (!isLinkCheckCancelled && checked >= total) {
    updateLinkCheckStatus({ status: 'done', checked: total, total, dead });
    chrome.storage.local.remove('linkCheckState');
  }
}
