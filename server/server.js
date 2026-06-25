// WeBook Proxy Server v2 — with License Key Management, Security & Credit Saving
import 'dotenv/config'; // load .env before anything else (local dev)
import express from 'express';
import cors from 'cors';
import dns from 'dns';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import pg from 'pg';
import { randomBytes, createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import metascraper from 'metascraper';
import metascraperAuthor from 'metascraper-author';
import metascraperDescription from 'metascraper-description';
import metascraperPublisher from 'metascraper-publisher';
import metascraperTitle from 'metascraper-title';
import metascraperUrl from 'metascraper-url';
import metascraperLang from 'metascraper-lang';
import metascraperReadability from 'metascraper-readability';
import metascraperYoutube from 'metascraper-youtube';
import metascraperAmazon from 'metascraper-amazon';
import metascraperLogoFavicon from 'metascraper-logo-favicon';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize metascraper with all rule bundles
const scraper = metascraper([
  metascraperYoutube(),
  metascraperAmazon(),
  metascraperAuthor(),
  metascraperDescription(),
  metascraperPublisher(),
  metascraperTitle(),
  metascraperUrl(),
  metascraperLang(),
  metascraperReadability(),  // Mozilla Readability — extracts full article text
  metascraperLogoFavicon()
]);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Environment Variables ──
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || 'google/gemini-2.5-flash';

if (!OPENROUTER_API_KEY) {
  console.warn('⚠️ WARNING: OPENROUTER_API_KEY not set. AI classification will fall back to local keyword classification.');
}

// Helper to retrieve the current model name
function getWorkingModelName() {
  return MODEL_NAME;
}

// ─────────────────────────────────────────────────────────────────────────────
// #6 — SERVER-SIDE CLASSIFY CACHE (24h TTL, max 1000 entries)
// ─────────────────────────────────────────────────────────────────────────────
const CLASSIFY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CLASSIFY_CACHE_MAX = 1000;
const classifyCache = new Map(); // key: `${url}::${title}` → { result, ts }

function getClassifyCache(url, title) {
  const key = `${url}::${title}`;
  const entry = classifyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CLASSIFY_CACHE_TTL) { classifyCache.delete(key); return null; }
  return entry.result;
}

function setClassifyCache(url, title, result) {
  const key = `${url}::${title}`;
  if (classifyCache.size >= CLASSIFY_CACHE_MAX) {
    // Evict oldest entry
    const firstKey = classifyCache.keys().next().value;
    classifyCache.delete(firstKey);
  }
  classifyCache.set(key, { result, ts: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// #8 — SERVER-SIDE FOLDER HASH CACHE (1h TTL)
// ─────────────────────────────────────────────────────────────────────────────
const FOLDER_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const folderHashCache = new Map(); // key: sha1(folderNames) → { mapping, ts }

function getFolderHashCache(hash) {
  const entry = folderHashCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.ts > FOLDER_CACHE_TTL) { folderHashCache.delete(hash); return null; }
  return entry.mapping;
}

function setFolderHashCache(hash, mapping) {
  folderHashCache.set(hash, { mapping, ts: Date.now() });
}

function hashFolderNames(folderNames) {
  return createHash('sha1').update(folderNames.join(','), 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// #9 — REQUEST DEDUPLICATION for /api/classify
// ─────────────────────────────────────────────────────────────────────────────
const pendingClassify = new Map(); // key: url → Promise

// ─────────────────────────────────────────────────────────────────────────────
// #11 — OPENROUTER FETCH WITH RETRY (max 2 retries on 429/5xx) + per-attempt 25s timeout
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWithRetry(url, opts, maxRetries = 2, timeoutMs = 25000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 1500; // 1.5s, 3s
      console.warn(`[WeBook] Retry attempt ${attempt} for ${url} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
    // Add a per-attempt AbortController so the request never hangs beyond timeoutMs
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      // Retry on rate-limit or server errors; fail fast on 4xx client errors
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) continue;
        return res; // Return last response if retries exhausted
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

const STANDARD_CATEGORIES = [
  "Social Media", "AI Tools", "Dev Tools", "Entertainment", "Productivity",
  "Finance", "Shopping", "News", "Learning", "Design",
  "Communication", "Travel", "Health", "Sports", "Gaming",
  "Technology", "Music", "Videos", "Books", "Real Estate",
  "Government", "Cryptocurrency", "Cloud Services", "Reference", "Utilities",
  "Jobs & Careers", "Marketing", "Business", "Recipes & Food", "Blogs",
  "Forums & Communities", "Art & Photography", "Science & Research", "Education", "E-Books",
  "Search Engines", "Programming Languages", "Databases", "DevOps & Sysadmin", "Cybersecurity",
  "Hardware", "Mobile Apps", "Web Development", "APIs & Data", "Open Source",
  "Tutorials", "Documentation", "Hosting & Domains", "Templates", "UI & UX",
  "Fonts & Icons", "Stock Media", "3D & Animation", "Audio & Podcasts", "Streaming Services",
  "Anime & Manga", "Movies & TV", "Newsletters", "Personal Finance", "Investing",
  "Banking", "Tax & Accounting", "Insurance", "Deals & Coupons", "Fashion & Apparel",
  "Home & Living", "Electronics", "Books & Literature", "Office Supplies", "Gifts & Cards",
  "Travel Booking", "Maps & Navigation", "Hotels & Lodging", "Car Rental & Transit", "Local Guides",
  "Medical & Clinics", "Mental Health", "Nutrition & Diet", "Fitness & Gym", "Yoga & Meditation",
  "Sports News", "Outdoor Activities", "Board Games", "PC Gaming", "Console Gaming",
  "Game Development", "Politics & Law", "History & Culture", "Space & Astronomy", "Biology & Nature",
  "Physics & Chemistry", "Mathematics", "Philosophy", "Languages & Translation", "Writing & Blogging",
  "Notes & Archiving", "Task Management", "File Sharing", "Weather", "Miscellaneous"
];

// ── Built-in Site Knowledge Mapping ──
const SITE_KNOWLEDGE = {
  'chat.openai.com':         'ChatGPT AI assistant by OpenAI for general Q&A and code support',
  'chatgpt.com':             'ChatGPT AI assistant by OpenAI for general Q&A and code support',
  'claude.ai':               'Claude AI assistant by Anthropic for coding, analysis, and writing',
  'gemini.google.com':       'Gemini AI assistant by Google for multimodal tasks and search',
  'poe.com':                 'Poe platform for interacting with various AI chatbots',
  'perplexity.ai':           'AI search engine and research assistant',
  'v0.dev':                  'AI generator by Vercel for UI designs and React code',
  'midjourney.com':          'AI text-to-image generator platform',
  'suno.com':                'AI text-to-music and audio generator platform',
  'suno.ai':                 'AI text-to-music and audio generator platform',
  'elevenlabs.io':           'AI realistic text-to-speech voice generation',
  'murf.ai':                 'AI text-to-speech voice generation',
  'openrouter.ai':           'AI API aggregator and model router for developers',
  'huggingface.co':          'AI model hub and machine learning community platform',
  'replicate.com':           'Cloud API for running AI models',
  'together.ai':             'AI API platform for running open-source models',
  'groq.com':                'Ultra-fast AI inference API platform',
  'github.com':              'Code hosting, version control, and collaboration platform',
  'gitlab.com':              'Code hosting, DevOps, and CI/CD platform',
  'stackoverflow.com':       'Q&A community for programmers and developers',
  'codepen.io':              'Online code editor and frontend playground',
  'replit.com':              'Online code editor and cloud development environment',
  'vercel.com':              'Cloud platform for deploying frontend web apps',
  'netlify.com':             'Cloud platform for deploying web apps and static sites',
  'supabase.com':            'Open-source Firebase alternative with Postgres database',
  'firebase.google.com':     'Google app development platform with database and auth',
  'aws.amazon.com':          'Amazon Web Services cloud computing platform',
  'console.cloud.google.com':'Google Cloud computing platform and infrastructure',
  'portal.azure.com':        'Microsoft Azure cloud computing platform',
  'notion.so':               'All-in-one workspace for notes, docs, and project management',
  'trello.com':              'Kanban-style project management board',
  'linear.app':              'Issue tracking and project management for software teams',
  'asana.com':               'Project and task management platform',
  'clickup.com':             'Project management and productivity platform',
  'airtable.com':            'Spreadsheet-database hybrid for project management',
  'slack.com':               'Business messaging and team collaboration platform',
  'discord.com':             'Community messaging and voice chat platform',
  'zoom.us':                 'Video conferencing and meeting platform',
  'mail.google.com':         'Gmail email service by Google',
  'gmail.com':               'Gmail email service by Google',
  'drive.google.com':        'Google Drive cloud file storage',
  'docs.google.com':         'Google Docs online word processing tool',
  'sheets.google.com':       'Google Sheets online spreadsheet tool',
  'calendar.google.com':     'Google Calendar scheduling tool',
  'twitter.com':             'Social media platform for short posts and news',
  'x.com':                   'Social media platform formerly known as Twitter',
  'linkedin.com':            'Professional networking and job search platform',
  'reddit.com':              'Community forum and content aggregation platform',
  'youtube.com':             'Video sharing and streaming platform',
  'instagram.com':           'Photo and video social media platform',
  'figma.com':               'Collaborative UI/UX design tool for teams',
  'canva.com':               'Online graphic design and image creation tool',
  'adobe.com':               'Creative software suite including Photoshop and Illustrator',
  'stripe.com':              'Online payment processing platform for businesses',
  'proton.me':               'Encrypted email and privacy-focused services by Proton',
  'protonmail.com':          'Encrypted email service by Proton',
  'mail.zoho.com':           'Zoho Mail business email service',
  'zoho.com':                'Zoho business productivity suite including email and CRM',
  'tuta.com':                'Encrypted email service (Tutanota)',
  'tuta.io':                 'Encrypted email service (Tutanota)',
  'tutanota.com':            'Encrypted email service',
  'temp-mail.org':           'Temporary disposable email service',
  'coursera.org':            'Online learning platform with university courses',
  'udemy.com':               'Online course marketplace for professionals',
  'leetcode.com':            'Coding interview practice and algorithm challenges',
  'news.ycombinator.com':    'Hacker News - tech and startup news community',
  'amazon.com':              'Online shopping and e-commerce marketplace',
  // AI Image / Video Generation
  'krea.ai':                 'AI image and video generation and real-time creative tool',
  'fal.ai':                  'AI image and video generation API and platform',
  'fli.so':                  'AI video generation platform',
  'pikzels.com':             'AI image generation and creative tool',
  'promptfolder.com':        'AI prompt management and organization tool',
  'imageprompt.org':         'Free AI image prompt generator tool',
  'freepik.com':             'Free stock photos, vectors, and AI image generation',
  'lexica.art':              'AI image search engine and stable diffusion gallery',
  'playground.com':          'AI image generation and creative canvas',
  'ideogram.ai':             'AI text-to-image generation platform',
  'tensor.art':              'AI image generation community platform',
  'civitai.com':             'AI model sharing hub for Stable Diffusion',
  // Streaming & Content Creation
  'streamlabs.com':          'Streaming software and tools for content creators',
  'obs-project.com':         'Open Broadcaster Software for live streaming and recording',
  'restream.io':             'Multi-platform live streaming service',
  'riverside.fm':            'Podcast and video recording studio platform',
  'descript.com':            'AI-powered audio and video editing platform',
  // URL & Productivity Utilities
  'bitly.com':               'URL shortening and link management service',
  'tinyurl.com':             'URL shortening service',
  'linktree.ee':             'Link in bio page for social media profiles',
  'linktr.ee':               'Link in bio page for social media profiles',
  'zapier.com':              'Automation platform for connecting apps and workflows',
  'make.com':                'Visual automation and integration platform',
  'ifttt.com':               'If This Then That automation platform',
  // Cloud Gaming
  'shadow.tech':             'Cloud gaming PC streaming service',
  'geforce.com':             'NVIDIA GeForce NOW cloud gaming service',
  'xbox.com':                'Microsoft Xbox gaming platform and Game Pass',
  // Movies, TV & Entertainment
  'yts.mx':                  'YTS movie torrent download site',
  'yts.am':                  'YTS movie torrent download site',
  '1337x.to':                'Torrent search engine for movies, TV and software',
  'cineru.lk':               'Sri Lankan movie and TV streaming website',
  'cinesubz.co':             'Movie and TV subtitles download site',
  'baiscopedownloads.info':  'Movie download site (Sinhala/Sri Lankan)',
  'imdb.com':                'Internet Movie Database for movies and TV ratings',
  'rottentomatoes.com':      'Movie and TV show review aggregator',
  'themoviedb.org':          'Community movie and TV show database',
  'animalmond.com':          'Animal and wildlife content platform',
  // Other utilities
  'skibsbyooma.com':         'Utility or productivity service',
  'hyperlink.app':           'Offline AI agent for document search and productivity',
  'console.dev':             'Developer tools and productivity newsletter',
};

function enrichTags(existingTags, title, url, folderName) {
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
  ]);

  const enriched = new Set();

  // 1. Start with AI-generated tags — already specific
  if (Array.isArray(existingTags)) {
    for (const t of existingTags) {
      if (enriched.size >= 8) break;
      const clean = t.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
      if (clean.length >= 2 && !STOP_WORDS.has(clean)) enriched.add(clean);
    }
  }

  // 2. Domain brand name (e.g. 'quarkdown', 'pluely', 'openai')
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const brand = host.split('.')[0];
    if (brand && brand.length >= 3 && !['com','org','net','edu','gov'].includes(brand) && !STOP_WORDS.has(brand)) {
      if (enriched.size < 8) enriched.add(brand);
    }
  } catch {}

  // 3. Meaningful words from folder name
  const folderWords = (folderName || '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  for (const w of folderWords) {
    if (enriched.size >= 8) break;
    enriched.add(w);
  }

  // 4. Pull meaningful words from title to reach minimum of 5
  if (enriched.size < 5) {
    const titleWords = (title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
    for (const w of titleWords) {
      if (enriched.size >= 8) break;
      enriched.add(w);
    }
  }

  // Return 5–8 tags (best effort minimum 5)
  return Array.from(enriched).slice(0, 8);
}


function getSiteDescription(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (SITE_KNOWLEDGE[host]) return SITE_KNOWLEDGE[host];
    for (const [key, desc] of Object.entries(SITE_KNOWLEDGE)) {
      if (host === key || host.endsWith('.' + key)) return desc;
    }
    return null;
  } catch { return null; }
}

// Fallback: derive context clues purely from the URL structure + title
// Used when metascraper cannot fetch metadata
function extractUrlContext(url, title) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const tld = host.split('.').pop();
    const domainParts = host.replace(/^www\./, '').split('.');
    const subdomain = domainParts.length > 2 ? domainParts[0] : null;
    const pathParts = parsed.pathname.split('/').map(s => s.toLowerCase()).filter(s => s.length > 2 && isNaN(s));
    const hints = [];

    // TLD hints
    if (tld === 'edu') hints.push('educational institution or university');
    if (tld === 'gov') hints.push('government or public sector website');
    if (tld === 'org') hints.push('non-profit organization or community');

    // Subdomain hints
    const subHints = { docs: 'documentation', api: 'API reference', mail: 'email service', shop: 'online store', store: 'online store', blog: 'blog', news: 'news', forum: 'forum or community', wiki: 'wiki or knowledge base', learn: 'learning or education', app: 'web application', dev: 'developer resource', status: 'service status page' };
    if (subdomain && subHints[subdomain]) hints.push(subHints[subdomain]);

    // Path hints
    const pathHints = { docs: 'documentation', pricing: 'pricing page', blog: 'blog post', tutorial: 'tutorial or learning', download: 'download page', login: 'login page', signup: 'signup page', forum: 'forum', wiki: 'wiki', 'open-source': 'open source project', github: 'code repository', jobs: 'job listings', careers: 'job listings', shop: 'e-commerce', store: 'e-commerce', news: 'news article' };
    for (const seg of pathParts) {
      if (pathHints[seg]) { hints.push(pathHints[seg]); break; }
    }

    // Domain name as brand hint
    const brand = domainParts[domainParts.length - 2];
    if (brand && brand.length > 2) hints.push(`site brand: ${brand}`);

    // Title analysis — extract meaningful nouns
    if (title) {
      const SKIP = new Set(['the','and','for','with','from','this','that','your','are','not','can','all']);
      const titleWords = title.toLowerCase().split(/[\s\-–|·:,]+/).filter(w => w.length > 3 && !SKIP.has(w));
      if (titleWords.length > 0) hints.push(`page topic keywords: ${titleWords.slice(0, 5).join(', ')}`);
    }

    return hints.length > 0 ? hints.join('; ') : null;
  } catch { return null; }
}

// Pick the best STANDARD_CATEGORY from URL + title when AI returns nothing useful
function inferCategoryFromUrl(url, title, folders) {
  const combined = `${url} ${title || ''}`.toLowerCase();
  const checks = [
    { keywords: ['github','gitlab','stackoverflow','codepen','replit','vscode','npm','webpack','babel','eslint'], cat: 'Dev Tools' },
    { keywords: ['openai','claude','gemini','mistral','llama','chatgpt','gpt','midjourney','stable-diffusion','huggingface','ai','ml','diffusion'], cat: 'AI Tools' },
    { keywords: ['youtube','netflix','twitch','spotify','soundcloud','podcast','movie','torrent','yts','1337x','stream','watch','anime'], cat: 'Entertainment' },
    { keywords: ['mail','gmail','outlook','proton','tuta','zoho','inbox','email'], cat: 'Communication' },
    { keywords: ['amazon','ebay','aliexpress','shopify','shop','store','cart','buy','price','deal','coupon'], cat: 'Shopping' },
    { keywords: ['udemy','coursera','edx','khan','learn','course','tutorial','lesson','education','school','university'], cat: 'Learning' },
    { keywords: ['notion','trello','asana','linear','clickup','todoist','task','project','kanban','jira'], cat: 'Productivity' },
    { keywords: ['figma','canva','adobe','sketch','dribbble','behance','design','ui','ux','prototype'], cat: 'Design' },
    { keywords: ['twitter','x.com','facebook','instagram','linkedin','reddit','discord','social','community','forum'], cat: 'Social Media' },
    { keywords: ['vercel','netlify','digitalocean','aws','azure','heroku','render','railway','cloud','hosting','deploy'], cat: 'Cloud Services' },
    { keywords: ['news','bbc','cnn','techcrunch','reuters','guardian','nytimes','bloomberg','article','press'], cat: 'News' },
    { keywords: ['bitcoin','ethereum','crypto','defi','nft','blockchain','coinbase','binance','trading'], cat: 'Cryptocurrency' },
    { keywords: ['bank','finance','invest','stock','fund','paypal','stripe','payment','money','wallet'], cat: 'Finance' },
    { keywords: ['gaming','steam','xbox','playstation','nintendo','game','esport','twitch'], cat: 'Gaming' },
    { keywords: ['health','medical','clinic','hospital','doctor','medicine','fitness','gym','yoga','nutrition'], cat: 'Health' },
    { keywords: ['travel','hotel','flight','booking','airbnb','tripadvisor','visa','airport','trip'], cat: 'Travel' },
    { keywords: ['recipe','food','cook','restaurant','meal','diet','kitchen'], cat: 'Recipes & Food' },
    { keywords: ['photo','photography','image','gallery','picture','camera','unsplash','pexels'], cat: 'Art & Photography' },
    { keywords: ['music','song','album','artist','concert','lyrics','playlist'], cat: 'Music' },
  ];

  // Also prefer existing user folders by keyword match
  for (const f of (folders || [])) {
    if (combined.includes(f.toLowerCase())) return f;
  }

  for (const { keywords, cat } of checks) {
    if (keywords.some(k => combined.includes(k))) return cat;
  }

  // Last resort: derive from TLD
  try {
    const tld = new URL(url).hostname.split('.').pop();
    if (tld === 'edu') return 'Learning';
    if (tld === 'gov') return 'Government';
  } catch {}

  return 'Miscellaneous'; // Never return Uncategorized
}

// Helper to identify local, private, or custom-port URLs that cannot or should not be scraped
function isPrivateOrUnscrapableUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    
    // 1. Local/private domain suffixes
    if (hostname === 'localhost' ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.test') ||
        hostname.endsWith('.example') ||
        hostname.endsWith('.invalid') ||
        hostname.endsWith('.onion')) {
      return true;
    }
    
    // 2. Private IPv4/IPv6 ranges
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) {
      return true;
    }
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) {
      return true;
    }
    if (hostname === '::1' || hostname.startsWith('fe80:') || hostname.startsWith('fd00:')) {
      return true;
    }

    // 3. Custom ports (any port other than default HTTP/HTTPS ports 80/443)
    if (url.port && url.port !== '80' && url.port !== '443') {
      return true;
    }
  } catch (e) {
    // Ignore URL parsing errors
  }
  return false;
}

// Fetch page HTML using gotScraping with auto-rotated browser headers & TLS fingerprints
async function fetchHtmlGot(url) {
  const options = {
    url,
    timeout: { request: 3000 },
    retry: { limit: 1 }
  };
  // Optional proxy routing support (e.g. residental proxy from .env)
  if (process.env.SCRAPING_PROXY) {
    options.proxyUrl = process.env.SCRAPING_PROXY;
  }
  const response = await gotScraping(options);
  return response.body;
}

// Fetch metadata from Microlink Cloud API as a powerful fallback (auto JS rendering + proxies)
async function fetchFromMicrolink(url) {
  try {
    console.log(`[metascraper] ☁️ Using Microlink API fallback for: ${url}`);
    const res = await gotScraping({
      url: `https://api.microlink.io?url=${encodeURIComponent(url)}&prerender=true`,
      timeout: { request: 4000 },
      responseType: 'json'
    });
    const data = res.body;
    if (data && data.status === 'success' && data.data) {
      const info = data.data;
      return {
        title: info.title || null,
        description: info.description || null,
        keywords: null,
        siteName: info.publisher || null,
        author: info.author || null,
        publisher: info.publisher || null,
        lang: info.lang || null,
        logo: info.logo?.url || null
      };
    }
  } catch (err) {
    console.log(`[metascraper] ❌ Microlink API fallback failed: ${err.message}`);
  }
  return null;
}

async function fetchPageMetadata(url) {
  if (isPrivateOrUnscrapableUrl(url)) {
    console.log(`[metascraper] 🚫 Skipping scraping for local/private/custom-port URL: ${url}`);
    return null;
  }
  let html = '';
  let usedMicrolink = false;

  try {
    // 1. Attempt static got-scraping fetch (very fast)
    html = await fetchHtmlGot(url);
  } catch (err) {
    console.log(`[metascraper] ⚠️ Direct gotScraping failed for ${url} (${err.message}) — falling back to Microlink API`);
    // 2. If direct gotScraping fails (e.g. Cloudflare block or network timeout), use Microlink API
    const microlinkData = await fetchFromMicrolink(url);
    if (microlinkData) return microlinkData;
    return null;
  }

  try {
    // 3. Extract standard metascraper tags
    const scraped = await scraper({ html, url });

    // ── Cheerio fallback parser for JSON-LD & Headings (H1/H2) ──
    const $ = cheerio.load(html);
    let extraDescription = null;
    let extraTitle = null;

    // A. Parse JSON-LD script blocks for structured description/title
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json) {
          // Can be object or array of objects
          const items = Array.isArray(json) ? json : [json];
          for (const item of items) {
            if (item.description && !extraDescription) extraDescription = item.description;
            if (item.name && !extraTitle) extraTitle = item.name;
            if (item.headline && !extraTitle) extraTitle = item.headline;
          }
        }
      } catch (_) {}
    });

    // B. Parse H1/H2 headings if title/description are completely empty
    if (!scraped.description && !extraDescription) {
      const headings = [];
      $('h1, h2').slice(0, 3).each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text.length > 15 && text.length < 150) headings.push(text);
      });
      if (headings.length > 0) {
        extraDescription = `Page headings: ${headings.join(' | ')}`;
      }
    }

    // C. Keywords extraction
    let keywords = null;
    const kwMatch = html.match(/<meta\b[^>]*?name\s*=\s*["']?keywords["']?[^>]*?content\s*=\s*["']([^"']+)["']|<meta\b[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?name\s*=\s*["']?keywords["']?/i);
    if (kwMatch) keywords = (kwMatch[1] || kwMatch[2] || '').trim();

    // ── Debug: show what metascraper extracted ──
    console.log(`[metascraper] ✅ ${url}`);
    console.log(`  title       : ${scraped.title || extraTitle || '(none)'}`);
    console.log(`  description : ${(scraped.description || extraDescription || '').slice(0, 80)}…`);
    console.log(`  publisher   : ${scraped.publisher || '(none)'}`);
    if (scraped.readability) console.log(`  readability : ${scraped.readability.slice(0, 100).replace(/\s+/g,' ')}…`);

    const finalDesc = scraped.description || extraDescription || scraped.readability?.slice(0, 300) || null;

    // 4. If description is still completely empty, fallback to Microlink API to get JS-rendered content
    if (!finalDesc && !scraped.title) {
      console.log(`[metascraper] ⚠️ Extracted metadata is empty, retrying with Microlink API`);
      const microlinkData = await fetchFromMicrolink(url);
      if (microlinkData) return microlinkData;
    }

    return {
      title: scraped.title || extraTitle || null,
      description: finalDesc,
      keywords,
      siteName: scraped.publisher || null,
      author: scraped.author || null,
      publisher: scraped.publisher || null,
      lang: scraped.lang || null,
      logo: scraped.logo || null
    };
  } catch (err) {
    console.log(`[metascraper] ❌ parsing failed for ${url}: ${err.message}`);
    return null;
  }
}
const dbType = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
let pgPool = null;
let sqliteDb = null;

if (dbType === 'postgres') {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    pgPool = new pg.Pool({
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      host: dbUrl.hostname,
      port: dbUrl.port,
      database: dbUrl.pathname.slice(1),
      ssl: { rejectUnauthorized: false }
    });
  } catch (e) {
    console.error('Failed to parse DATABASE_URL, fallback to direct connectionString:', e);
    pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  console.log('🔌 Database: PostgreSQL connected via DATABASE_URL');
} else {
  let dbPath = process.env.DATABASE_PATH 
    || (process.env.NODE_ENV === 'production' ? '/data/keys.db' : join(__dirname, 'keys.db'));

  // Ensure parent directory exists
  const dbDir = dirname(dbPath);
  try {
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
  } catch (e) {
    console.warn(`⚠️ Could not create directory ${dbDir}, falling back to local directory:`, e);
    dbPath = join(__dirname, 'keys.db');
  }

  console.log(`📂 Database path: ${dbPath}`);
  sqliteDb = new Database(dbPath);
}

// ── Initialize Database Table ──
async function initDb() {
  if (dbType === 'postgres') {
    // Smart Categorization: User Corrections Table
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS user_corrections (
        license_key      VARCHAR(255) NOT NULL DEFAULT 'selfhost',
        url              TEXT NOT NULL,
        domain           VARCHAR(255) NOT NULL,
        corrected_folder VARCHAR(255) NOT NULL,
        original_folder  VARCHAR(255),
        timestamp        TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_corrections_key_url ON user_corrections (license_key, url)
    `).catch(() => {});
  } else {
    // Smart Categorization: User Corrections Table
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS user_corrections (
        license_key      TEXT NOT NULL DEFAULT 'selfhost',
        url              TEXT NOT NULL,
        domain           TEXT NOT NULL,
        corrected_folder TEXT NOT NULL,
        original_folder  TEXT,
        timestamp        TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    try { sqliteDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_corrections_key_url ON user_corrections (license_key, url)`); } catch (_) {}
  }
}
await initDb();

// ── Key Helpers ──
function generateKey() {
  const part = () => randomBytes(2).toString('hex').toUpperCase();
  return `WB-${part()}-${part()}-${part()}-${part()}`;
}

async function isValidKey(key) {
  return true; // Always valid in self-hosted mode
}

// ── Middleware ──
app.use(cors({
  origin: '*', // Allow all origins for easy self-hosting
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true }));

// ── License Key Validation Middleware ──
async function checkLicenseKey(req, res, next) {
  req.licenseKey = req.headers['x-license-key'] || 'selfhost';
  req.keyValid = true;
  next();
}

// ── Rate Limiter ──
const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 6000,
  message: { error: 'Rate limit exceeded. Try again in an hour.', code: 'RATE_LIMIT_EXCEEDED' },
  skip: (req) => true // Skip rate limiting in self-hosted mode
});



// ────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS (used by the extension)
// ────────────────────────────────────────────────────────────────

// Root endpoint returning a clean status message for self-hosted setup
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'WeBook Self-Hosted Proxy API Server',
    version: '3.0'
  });
});

// Health check + version
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', version: '2.0' });
});

// Validate a license key (stubbed for self-hosting)
app.post('/api/validate-key', async (req, res) => {
  return res.json({ valid: true, note: 'Self-hosted Mode' });
});

// ── Smart Categorization: User Corrections Helpers & Endpoint ──
async function getCorrectionForUrl(licenseKey, url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const domain = host.replace(/^www\./, '');
    if (dbType === 'postgres') {
      const res = await pgPool.query(
        'SELECT corrected_folder FROM user_corrections WHERE license_key = $1 AND (url = $2 OR domain = $3) ORDER BY timestamp DESC LIMIT 1',
        [licenseKey, url, domain]
      );
      return res.rows[0]?.corrected_folder || null;
    } else {
      const row = sqliteDb.prepare(
        'SELECT corrected_folder FROM user_corrections WHERE license_key = ? AND (url = ? OR domain = ?) ORDER BY timestamp DESC LIMIT 1'
      ).get(licenseKey, url, domain);
      return row?.corrected_folder || null;
    }
  } catch (e) {
    return null;
  }
}

async function getRecentCorrections(licenseKey, limit = 15) {
  try {
    if (dbType === 'postgres') {
      const res = await pgPool.query(
        'SELECT domain, corrected_folder FROM user_corrections WHERE license_key = $1 ORDER BY timestamp DESC LIMIT $2',
        [licenseKey, limit]
      );
      return res.rows;
    } else {
      return sqliteDb.prepare(
        'SELECT domain, corrected_folder FROM user_corrections WHERE license_key = ? ORDER BY timestamp DESC LIMIT ?'
      ).all(licenseKey, limit);
    }
  } catch (e) {
    return [];
  }
}

app.post('/api/correct-category', checkLicenseKey, apiLimiter, async (req, res) => {
  const { url, correctedFolder, originalFolder } = req.body;
  const licenseKey = req.licenseKey;

  if (!url || !correctedFolder) {
    return res.status(400).json({ error: 'Missing url or correctedFolder.' });
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    const domain = host.replace(/^www\./, '');

    if (dbType === 'postgres') {
      await pgPool.query(`
        INSERT INTO user_corrections (license_key, url, domain, corrected_folder, original_folder, timestamp)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (license_key, url)
        DO UPDATE SET corrected_folder = EXCLUDED.corrected_folder, original_folder = EXCLUDED.original_folder, timestamp = NOW()
      `, [licenseKey, url, domain, correctedFolder, originalFolder || null]);
    } else {
      sqliteDb.prepare(`
        INSERT INTO user_corrections (license_key, url, domain, corrected_folder, original_folder, timestamp)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(license_key, url)
        DO UPDATE SET corrected_folder = excluded.corrected_folder, original_folder = excluded.original_folder, timestamp = datetime('now')
      `).run(licenseKey, url, domain, correctedFolder, originalFolder || null);
    }

    // Invalidate server-side classify cache for this URL
    for (const key of classifyCache.keys()) {
      if (key.startsWith(`${url}::`)) {
        classifyCache.delete(key);
      }
    }

    console.log(`[WeBook] Saved user correction: ${url} -> ${correctedFolder}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving user correction:', err);
    res.status(500).json({ error: 'Server error. Could not save correction.' });
  }
});

// Main AI classify endpoint — requires a valid license key
app.post('/api/classify', checkLicenseKey, apiLimiter, async (req, res) => {
  const { title, url, existingFolders } = req.body;
  if (!title || !url) {
    return res.status(400).json({ error: 'Missing title or url.' });
  }

  // #4 — Input length validation
  if (typeof title !== 'string' || title.length > 500) {
    return res.status(400).json({ error: 'Title too long (max 500 characters).' });
  }
  if (typeof url !== 'string' || url.length > 2000) {
    return res.status(400).json({ error: 'URL too long (max 2000 characters).' });
  }

  console.log(`\n[WeBook] 📥 Classifying: "${title}"\n  URL: ${url}`);

  // #6 — Check server-side classify cache first
  const cached = getClassifyCache(url, title);
  if (cached) {
    console.log(`[WeBook] Server cache hit: "${cached.folderName}"`);
    return res.json(cached);
  }

  // Smart Categorization: Check user corrections database first
  const dbCorrection = await getCorrectionForUrl(req.licenseKey, url);
  if (dbCorrection) {
    console.log(`[WeBook] DB correction hit: "${dbCorrection}"`);
    const result = {
      folderName: dbCorrection,
      confidence: 1.0,
      tags: enrichTags([], title, url, dbCorrection),
      isNew: !Array.isArray(existingFolders) || !existingFolders.some(f => f.toLowerCase() === dbCorrection.toLowerCase()),
      source: 'db-correction'
    };
    setClassifyCache(url, title, result);
    return res.json(result);
  }

  // Fallback if OpenRouter API Key is not set
  if (!OPENROUTER_API_KEY) {
    console.warn(`[WeBook] OPENROUTER_API_KEY not configured — using local fallback classification`);
    const folders = Array.isArray(existingFolders) ? existingFolders : [];
    const fallbackFolder = inferCategoryFromUrl(url, title, folders);
    const fallback = {
      folderName: fallbackFolder,
      confidence: 0.4,
      reasoning: 'API Key not configured — local fallback classification used',
      tags: enrichTags([], title, url, fallbackFolder),
      isNew: !folders.some(f => f.toLowerCase() === fallbackFolder.toLowerCase()),
      source: 'local-fallback'
    };
    setClassifyCache(url, title, fallback);
    return res.json(fallback);
  }

  // #9 — Request deduplication: if same URL is already in-flight, wait for it
  if (pendingClassify.has(url)) {
    console.log(`[WeBook] Dedup: waiting for in-flight classify request for: ${url}`);
    try {
      const result = await pendingClassify.get(url);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Server error. Try again.' });
    }
  }

  // 1. Fetch site description context (on the server side!)
  const knownDesc = getSiteDescription(url);
  let siteContext = knownDesc;
  let pageTitle = null;
  let pageKeywords = null;
  let pageSiteName = null;
  let pageAuthor = null;
  let pagePublisher = null;

  if (knownDesc) {
    console.log(`[WeBook] 🧠 Site Knowledge hit: "${knownDesc.slice(0, 60)}..."`);
  }

  if (!knownDesc) {
    const meta = await fetchPageMetadata(url);
    if (meta) {
      siteContext = meta.description || null;
      pageTitle = meta.title || null;
      pageKeywords = meta.keywords || null;
      pageSiteName = meta.siteName || null;
      pageAuthor = meta.author || null;
      pagePublisher = meta.publisher || null;
    }
  }

  // If metascraper returned nothing, extract context from URL structure + title
  if (!siteContext) {
    siteContext = extractUrlContext(url, title);
    if (siteContext) console.log(`[WeBook] URL-context fallback for: ${url}`);
  }

  const folders = Array.isArray(existingFolders) ? existingFolders : [];

  // Fetch recent user corrections for in-context prompting
  const recentCorrections = await getRecentCorrections(req.licenseKey);
  let preferencesContext = '';
  if (recentCorrections && recentCorrections.length > 0) {
    preferencesContext = `User's Custom Categorization Preferences (derived from their manual corrections):
${recentCorrections.map(c => `- Websites on domain "${c.domain}" should go to folder "${c.corrected_folder}"`).join('\n')}

Please observe these patterns. If a new bookmark is similar to a domain in these preferences, prefer the folder/path style chosen by the user.`;
  }

  // 2. Build prompt on the server
  const prompt = `You are a highly intelligent browser bookmark organizer. Your goal is to classify the bookmark into the most appropriate category/folder.

Bookmark to classify:
- Provided Title: "${title}"
${pageTitle && pageTitle.toLowerCase() !== title.toLowerCase() ? `- Real Webpage Title: "${pageTitle}"` : ''}
- URL: "${url}"
${pageSiteName ? `- Site/Brand Name: "${pageSiteName}"` : ''}
${pageAuthor ? `- Author: "${pageAuthor}"` : ''}
${pagePublisher ? `- Publisher: "${pagePublisher}"` : ''}
- Description: "${siteContext || 'No description available'}"
${pageKeywords ? `- Keywords: "${pageKeywords}"` : ''}

User's Existing Bookmark Folders:
${folders.length > 0 ? folders.map(f => `- ${f}`).join('\n') : '(None)'}

${preferencesContext}

Standard Reference Categories:
${STANDARD_CATEGORIES.map(c => `- ${c}`).join('\n')}

Categorization Rules:
1. **Reuse Existing Folders**: ALWAYS prefer placing the bookmark into one of the "User's Existing Bookmark Folders" if it fits. Do NOT create a new folder if an existing folder (or parent/subfolder) can represent it.
2. **Merge Similar Categories**: If the user has an existing folder with a similar meaning (e.g., "AI", "AI Tools", "Artificial Intelligence", "Machine Learning"), use that existing folder name to avoid duplicates.
3. **Normalize Folder Names**: Ensure standard capitalization (Title Case), singular form (unless plural is standard, e.g., "Dev Tools"), and correct spelling.
4. **Prefer Broad Categories**: Avoid deep nesting or creating highly specific subcategories unless they already exist in the "User's Existing Bookmark Folders". Do not create new subfolders unless absolutely necessary.
5. **Website Type Focus**: Categorize by what the site IS (its service/brand), not the specific page's transient title.
6. **Always Categorize — NEVER use "Uncategorized"**:
   - **NEVER output "Uncategorized" as the folder name. It is not an acceptable answer.**
   - You MUST always pick the best fitting category, even if you're not fully certain.
   - If the site doesn't perfectly match any category, pick the closest one from STANDARD_CATEGORIES.
   - Use the URL structure, domain name, and title as signals when the description is missing.
   - An imperfect category is always better than no category.
7. **Tags**: Generate 5 to 8 specific, meaningful tags. Requirements:
   - Must include at least 5 tags
   - Tags must be specific named things: brand names, technologies, proper nouns, niche topics (e.g. "gpt-4o", "markdown", "stripe", "pricing", "nextjs", "email", "encryption")
   - NEVER use generic words like: new, launches, tech, internet, web, app, tool, online, free, best, invisible, common, service, platform, product, site, page, update, official
   - Each tag should be something a user would actually search for to find this specific page
   - Prefer: product names, specific feature names, domain-specific terms, company names, category descriptors

Output JSON format only:
{
  "folderName": "exact folder path (e.g. 'Social Media' or 'Dev Tools/GitHub')",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation of classification",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}`;

  // #9 — Register pending promise so duplicate requests await this one
  let resolvePending, rejectPending;
  const pendingPromise = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
  pendingPromise.catch(() => {}); // prevent unhandled promise rejection crashes
  pendingClassify.set(url, pendingPromise);

  try {
    // #11 — Use fetchWithRetry with 25s timeout instead of bare fetch
    const response = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://webook.website',
        'X-Title': 'WeBook'
      },
      body: JSON.stringify({
        model: getWorkingModelName(),
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    }, 1, 25000); // max 1 retry with 25s timeout to stay within DO's 30s gateway limit

    if (!response.ok) {
      const errText = await response.text();
      console.error(`OpenRouter error (${response.status}):`, errText);
      rejectPending(new Error(`HTTP ${response.status}`));
      pendingClassify.delete(url);
      return res.status(502).json({ error: 'AI service error. Try again.' });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      rejectPending(new Error('Empty response'));
      pendingClassify.delete(url);
      return res.status(502).json({ error: 'Empty AI response.' });
    }

    let parsed;
    try {
      let jsonText = content.trim();
      if (jsonText.startsWith('```')) jsonText = jsonText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(jsonText);

      // Determine if folder is new based on actual existing folders
      let folderName = parsed.folderName || '';

      // NEVER allow Uncategorized — override with URL-based inference
      if (!folderName || folderName.toLowerCase() === 'uncategorized') {
        folderName = inferCategoryFromUrl(url, title, folders);
        console.log(`[WeBook] Uncategorized overridden → "${folderName}" for: ${url}`);
      }

      const isNew = !folders.some(f => f.toLowerCase() === folderName.toLowerCase());
      parsed.folderName = folderName;
      parsed.isNew = isNew;
      parsed.confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;
      parsed.tags = enrichTags(parsed.tags, title, url, folderName);
    } catch {
      rejectPending(new Error('Invalid JSON'));
      pendingClassify.delete(url);
      return res.status(502).json({ error: 'AI response was not valid JSON.' });
    }

    // #6 — Store in server-side cache
    setClassifyCache(url, title, parsed);
    resolvePending(parsed);
    pendingClassify.delete(url);

    console.log(`[WeBook] 📤 Classified: "${parsed.folderName}" (conf: ${parsed.confidence})\n  Tags: [${parsed.tags.join(', ')}]`);
    return res.json(parsed);
  } catch (err) {
    rejectPending(err);
    pendingClassify.delete(url);

    // If this was a timeout (AbortError), return a smart fallback so the bookmark is still saved
    const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('abort'));
    if (isTimeout) {
      console.warn(`[WeBook] AI classify timed out for ${url} — using fallback classification`);
      // Pick a rough folder based on title/url keywords
      const combined = `${title} ${url}`.toLowerCase();
      let fallbackFolder = 'Uncategorized';
      if (/youtube|netflix|twitch|spotify|vimeo|tiktok/.test(combined)) fallbackFolder = 'Entertainment';
      else if (/github|stackoverflow|codepen|dev\.to|npm|docs\./.test(combined)) fallbackFolder = 'Dev Tools';
      else if (/news|cnn|bbc|reuters|techcrunch|verge|wired|nytimes/.test(combined)) fallbackFolder = 'News';
      else if (/twitter|x\.com|reddit|linkedin|facebook|instagram/.test(combined)) fallbackFolder = 'Social Media';
      else if (/amazon|ebay|etsy|shopify|aliexpress/.test(combined)) fallbackFolder = 'Shopping';
      else if (/chatgpt|openai|gemini|claude|midjourney|huggingface|gpt/.test(combined)) fallbackFolder = 'AI Tools';
      else if (/google|drive|notion|trello|slack|figma|canva/.test(combined)) fallbackFolder = 'Productivity';
      const fallback = {
        folderName: fallbackFolder,
        confidence: 0.4,
        reasoning: 'AI timed out — fallback classification used',
        tags: enrichTags([], title, url, fallbackFolder),
        isNew: !folders.some(f => f.toLowerCase() === fallbackFolder.toLowerCase()),
        source: 'timeout-fallback'
      };
      return res.json(fallback);
    }

    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Server error. Try again.' });
  }
});

// Endpoint to clean and rename existing folders using AI
app.post('/api/clean-folders', checkLicenseKey, apiLimiter, async (req, res) => {
  const { folderNames } = req.body;
  if (!Array.isArray(folderNames)) {
    return res.status(400).json({ error: 'Missing folderNames array.' });
  }
  if (folderNames.length === 0) {
    return res.json({ mapping: {} });
  }

  // Fallback if OpenRouter API Key is not set
  if (!OPENROUTER_API_KEY) {
    console.warn('[WeBook] OPENROUTER_API_KEY not configured — clean-folders returns identical mapping');
    const mapping = {};
    for (const f of folderNames) {
      mapping[f] = f;
    }
    return res.json({ mapping });
  }

  // #8 — Check folder hash cache first; skip AI if folders haven't changed
  const folderHash = hashFolderNames(folderNames);
  const cachedMapping = getFolderHashCache(folderHash);
  if (cachedMapping) {
    console.log(`[WeBook] Folder hash cache hit (${folderHash.slice(0, 8)}…) — skipping AI call`);
    return res.json({ mapping: cachedMapping, cached: true });
  }

  const prompt = `You are a browser bookmark organizer.
Here is a list of existing folder names created by a user:
${folderNames.map(f => `- "${f}"`).join('\n')}

Your task:
1. Fix any spelling mistakes, typos, or grammatical errors in these folder names.
2. Map/Standardize them to match one of the following 100 Standard Category names if they are similar or represent the same category:
${STANDARD_CATEGORIES.map(c => `- ${c}`).join('\n')}

If a folder name does not represent any of these categories and is highly specific, correct its spelling/grammar, and capitalize it to Title Case.
For each folder in the input, provide the corrected folder name.

Output JSON only in this exact format:
{
  "mapping": {
    "original folder name 1": "corrected folder name 1",
    "original folder name 2": "corrected folder name 2"
  }
}`;

  try {
    // #11 — Use fetchWithRetry
    const response = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://webook.website',
        'X-Title': 'WeBook'
      },
      body: JSON.stringify({
        model: getWorkingModelName(),
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`OpenRouter clean-folders error (${response.status}):`, errText);
      return res.status(502).json({ error: 'AI service error. Try again.' });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'Empty AI response.' });

    let parsed;
    try {
      let jsonText = content.trim();
      if (jsonText.startsWith('```')) jsonText = jsonText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(jsonText);
    } catch {
      return res.status(502).json({ error: 'AI response was not valid JSON.' });
    }

    // #8 — Store in folder hash cache
    if (parsed.mapping) setFolderHashCache(folderHash, parsed.mapping);
    return res.json(parsed);
  } catch (err) {
    console.error('Clean folders proxy error:', err);
    return res.status(500).json({ error: 'Server error. Try again.' });
  }
});

// Endpoint to find merge candidates (proxy request from extension)
app.post('/api/merge-candidates', checkLicenseKey, apiLimiter, async (req, res) => {
  const { folders } = req.body;
  if (!Array.isArray(folders)) {
    return res.status(400).json({ error: 'Missing folders array.' });
  }

  if (folders.length < 2) return res.json({ suggestions: [] });

  // Fallback if OpenRouter API Key is not set
  if (!OPENROUTER_API_KEY) {
    console.warn('[WeBook] OPENROUTER_API_KEY not configured — merge-candidates returns empty suggestions');
    return res.json({ suggestions: [] });
  }

  const prompt = `You are a professional bookmark folder organizer.
Analyze this list of bookmark folders (which may include full hierarchical paths):
${folders.map(f => f.path ? `- "${f.path}"` : `- "${f.title}"`).join('\n')}

Identify folders that should be merged to keep the library clean and avoid duplicates.
Rules for Merging:
1. **Near-Duplicates & Spelling**: Merge folders with typos, singular/plural differences, or capitalization variations (e.g., "AI Tool" and "AI Tools" or "github" and "GitHub").
2. **Synonyms & Semantic Overlaps**: Merge folders representing the same semantic concept (e.g., "AI", "Artificial Intelligence", and "Machine Learning" -> "AI Tools").
3. **Unnecessary Subcategories / Overlaps**: If there are overlapping categories like "Communication", "Messaging", "Chat Apps", suggest merging them into a more common, broad category like "Social Media".
4. **Common Standard Names**: Prefer standard, recognizable category names.
5. **Path and Hierarchy Awareness**: If full paths are provided (e.g., "Parent/Child"), only suggest merging folders if they are in the same parent branch or share a similar semantic context. Avoid merging folders with the same child name that belong to completely unrelated categories (e.g. "Work/Invoices" and "Personal/Invoices") unless they should be consolidated globally.

Output JSON only in this exact format:
{
  "suggestions": [
    {
      "keep": "Best folder path/name to keep (preferably a standard/common folder name)",
      "merge": ["folder path/name 1 to merge", "folder path/name 2 to merge"],
      "reason": "Clear explanation of why these are being merged (e.g. semantic duplicates, singular/plural mismatch)"
    }
  ]
}
If no duplicates or overlaps are found, return:
{ "suggestions": [] }`;

  try {
    // #11 — Use fetchWithRetry for merge-candidates
    const response = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://webook.website',
        'X-Title': 'WeBook'
      },
      body: JSON.stringify({
        model: getWorkingModelName(),
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`OpenRouter merge-candidates error (${response.status}):`, errText);
      return res.status(502).json({ error: 'AI service error. Try again.' });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'Empty AI response.' });

    let parsed;
    try {
      let jsonText = content.trim();
      if (jsonText.startsWith('```')) jsonText = jsonText.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      parsed = JSON.parse(jsonText);
    } catch {
      return res.status(502).json({ error: 'AI response was not valid JSON.' });
    }
    return res.json(parsed);
  } catch (err) {
    console.error('Merge candidates proxy error:', err);
    return res.status(500).json({ error: 'Server error. Try again.' });
  }
});

// Endpoint to check if a link is broken (proxy request from extension)
app.post('/api/check-link', checkLicenseKey, apiLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  
  try {
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return res.json({ status: 404, reason: 'Invalid URL format' });
    }

    // DNS pre-flight check to verify domain exists
    let dnsResolves = true;
    try {
      await dns.promises.lookup(hostname);
    } catch (dnsErr) {
      dnsResolves = false;
    }

    if (!dnsResolves) {
      return res.json({ status: 404, reason: 'DNS_ENOTFOUND' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    
    let status = 200;
    try {
      const headRes = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        redirect: 'follow'
      });
      status = headRes.status;
    } catch {
      try {
        // Fallback to GET if HEAD fails
        const getRes = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          redirect: 'follow'
        });
        status = getRes.status;
      } catch (err) {
        // If domain resolved, but connection refused / network error, inspect the code
        const msg = err.message || '';
        if (msg.includes('ECONNREFUSED') || msg.includes('EHOSTUNREACH') || msg.includes('ENETUNREACH')) {
          status = 404; // Hard connection refusal
        } else {
          status = 200; // SSL warning, reset, or timeout/rate-limiting blocks -> treat as active
        }
      }
    }
    
    clearTimeout(timer);

    // Only flag 404 (Not Found) and 410 (Gone) as actually broken.
    // 403, 401, 405, 429 represent access restrictions or scraper blocking, which are active pages.
    if (status === 404 || status === 410) {
      return res.json({ status });
    } else {
      return res.json({ status: 200 }); // Report as active
    }
  } catch (err) {
    return res.json({ status: 200 }); // General fallback
  }
});



// Record free key usage (no-op in self-hosted mode)
function recordFreeKeyUsage(key, req) {}

// Get the active free key (stubbed for self-hosting)
app.get('/api/free-key', async (req, res) => {
  res.json({
    key: 'WB-SELF-HOSTED',
    timeLeft: 31536000000
  });
});

// Serve the extension zip file directly
app.get('/api/download-extension', (req, res) => {
  try {
    const zipPath = join(__dirname, '..', 'downloads', 'WeBook-v8.2.0.zip');
    if (existsSync(zipPath)) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="WeBook-v8.2.0.zip"');
      res.sendFile(zipPath);
    } else {
      res.status(404).json({
        error: 'Extension build not found on this server.'
      });
    }
  } catch (err) {
    console.error('[WeBook] Error serving extension zip:', err);
    res.status(500).send('Error downloading extension');
  }
});

app.listen(PORT, () => {
  console.log(`✅ WeBook proxy server on port ${PORT}`);
});
