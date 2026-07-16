// WeBook Popup v2 — All 10 Features

document.addEventListener('DOMContentLoaded', () => {
  // ── Proxy URL — must match what is set in background.js ──
  const PROXY_URL = 'https://webook-proxy-rfdpf.ondigitalocean.app';

  // ── Favicon Support ──
  const FALLBACK_FAVICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#4b5563" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>');
  
  function getFaviconUrl(url, size = 16) {
    if (!url) return FALLBACK_FAVICON;
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`;
  }

  // ── Tab Elements ──
  const tabs = {
    logs:     { btn: document.getElementById('tab-logs'),     section: document.getElementById('section-logs') },
    search:   { btn: document.getElementById('tab-search'),   section: document.getElementById('section-search') },
    tools:    { btn: document.getElementById('tab-tools'),    section: document.getElementById('section-tools') },
    groups:   { btn: document.getElementById('tab-groups'),   section: document.getElementById('section-groups') },
    settings: { btn: document.getElementById('tab-settings'), section: document.getElementById('section-settings') },
  };
  Object.entries(tabs).forEach(([name, { btn }]) => btn.addEventListener('click', () => switchTab(name)));

  // ── API Status ──
  const apiStatusBadge = document.getElementById('apiStatusBadge');
  const apiStatusText  = apiStatusBadge.querySelector('.status-text');

  let isApiConnected = false;
  let isLicenseValid = false;

  function refreshStatusBadge(customText = null) {
    if (customText) {
      apiStatusBadge.className = 'api-status-badge disconnected';
      apiStatusText.textContent = customText;
      return;
    }
    if (!isApiConnected) {
      apiStatusBadge.className = 'api-status-badge disconnected';
      apiStatusText.textContent = 'Offline';
    } else if (!isLicenseValid) {
      apiStatusBadge.className = 'api-status-badge disconnected';
      apiStatusText.textContent = 'Inactive';
    } else {
      apiStatusBadge.className = 'api-status-badge connected';
      apiStatusText.textContent = 'Active';
    }
  }

  async function testApiKey() {
    refreshStatusBadge('Testing…');
    try {
      const r = await fetch(`${PROXY_URL}/api/ping`);
      const data = await r.json();
      isApiConnected = r.ok && data.status === 'ok';
    } catch {
      isApiConnected = false;
    }
    refreshStatusBadge();
  }

  // ── Search Index Analysis Elements ──
  const analysisPromptContainer = document.getElementById('analysisPromptContainer');
  const searchControls = document.getElementById('searchControls');
  const btnStartAnalysis = document.getElementById('btnStartAnalysis');
  const analysisProgress = document.getElementById('analysisProgress');
  const analysisProgressBar = document.getElementById('analysisProgressBar');
  const analysisProgressText = document.getElementById('analysisProgressText');
  const analysisProgressCount = document.getElementById('analysisProgressCount');

  function checkSearchIndexStatus() {
    chrome.storage.local.get({ initialAnalysisDone: false }, (data) => {
      if (data.initialAnalysisDone) {
        analysisPromptContainer.classList.add('hidden');
        searchControls.classList.remove('hidden');
      } else {
        analysisPromptContainer.classList.remove('hidden');
        searchControls.classList.add('hidden');
      }
    });
  }

  btnStartAnalysis.addEventListener('click', () => {
    btnStartAnalysis.disabled = true;
    btnStartAnalysis.innerHTML = '<span>Analyzing...</span>';
    analysisProgress.classList.remove('hidden');

    getAllBookmarks((allBookmarks) => {
      const total = allBookmarks.filter(b => b.url).length;
      if (total === 0) {
        chrome.storage.local.set({ initialAnalysisDone: true }, () => {
          checkSearchIndexStatus();
        });
        return;
      }

      let processed = 0;
      chrome.storage.local.get({ bookmarkTags: {} }, (storageData) => {
        const bookmarkTags = storageData.bookmarkTags || {};
        
        allBookmarks.forEach(bm => {
          if (bm.url && (!bookmarkTags[bm.id] || bookmarkTags[bm.id].length === 0)) {
            bookmarkTags[bm.id] = getFallbackTags(bm.title, bm.url);
          }
        });

        analysisProgressCount.textContent = `0/${total}`;
        analysisProgressBar.style.width = '0%';

        chrome.storage.local.set({ bookmarkTags }, () => {
          const queue = allBookmarks.filter(bm => bm.url);
          let index = 0;
          const batchSize = 3;

          async function processNextBatch() {
            if (index >= queue.length) {
              chrome.storage.local.set({ initialAnalysisDone: true }, () => {
                checkSearchIndexStatus();
              });
              return;
            }

            const batch = queue.slice(index, index + batchSize);
            index += batchSize;

            const promises = batch.map(async (bm) => {
              try {
                const tags = await scrapeMetadataTags(bm.url, bm.title);
                if (tags && tags.length > 0) {
                  bookmarkTags[bm.id] = tags;
                }
              } catch (e) {}
            });

            await Promise.all(promises);
            processed = Math.min(total, processed + batch.length);

            chrome.storage.local.set({ bookmarkTags });

            const pct = Math.round((processed / total) * 100);
            analysisProgressBar.style.width = `${pct}%`;
            analysisProgressCount.textContent = `${processed}/${total}`;

            setTimeout(processNextBatch, 200);
          }

          processNextBatch();
        });
      });
    });
  });

  // Scoped helper to resolve the real root folder ID based on browser environment
  function getRealFolderId(settingsValue, callback) {
    chrome.bookmarks.getTree((tree) => {
      try {
        const rootChildren = tree[0].children || [];
        if (settingsValue === '2') {
          const otherNode = rootChildren.find(c => {
            const t = (c.title || '').toLowerCase();
            return t.includes('other') || t.includes('unsorted');
          }) || rootChildren[1] || { id: '2' };
          callback(otherNode.id);
        } else {
          const barNode = rootChildren.find(c => {
            const t = (c.title || '').toLowerCase();
            return (t.includes('bar') || t.includes('favorites') || t.includes('bookmark')) && !t.includes('other');
          }) || rootChildren[0] || { id: '1' };
          callback(barNode.id);
        }
      } catch (e) {
        callback(settingsValue === '2' ? '2' : '1');
      }
    });
  }

  // Scoped helper to find WeBook Tab Groups folder inside a specific parent folder only
  function findTabGroupsFolder(parentId, callback) {
    chrome.bookmarks.getChildren(parentId, (children) => {
      if (chrome.runtime.lastError || !children) {
        callback(null);
        return;
      }
      const folder = children.find(c => !c.url && c.title === 'WeBook Tab Groups');
      callback(folder || null);
    });
  }

  // Scoped helper to clean up the parent folder "WeBook Tab Groups" if it becomes empty
  function cleanEmptyTabGroupsParent() {
    getRealFolderId('2', (rootId) => {
      findTabGroupsFolder(rootId, (parentFolder) => {
        if (parentFolder) {
          chrome.bookmarks.getChildren(parentFolder.id, (children) => {
            if (!chrome.runtime.lastError && children && children.length === 0) {
              chrome.bookmarks.remove(parentFolder.id, () => {
                if (chrome.runtime.lastError) {
                  console.log('[WeBook] Failed to remove empty WeBook Tab Groups folder:', chrome.runtime.lastError);
                } else {
                  console.log('[WeBook] Successfully deleted empty WeBook Tab Groups folder');
                }
              });
            }
          });
        }
      });
    });
  }

  // ── Settings ──
  const settingsForm     = document.getElementById('settingsForm');
  const chkAutoOrganize  = document.getElementById('chkAutoOrganize');
  const chkKeepUserFolders = document.getElementById('chkKeepUserFolders');
  const chkNotifications = document.getElementById('chkNotifications');
  const chkWeeklyDigest  = document.getElementById('chkWeeklyDigest');
  const txtLicenseKey    = document.getElementById('licenseKey');
  const lblLicenseStatus = document.getElementById('licenseStatus');
  const statusMessage    = document.getElementById('statusMessage');

  function setLicenseState(valid) {
    isLicenseValid = valid;
    refreshStatusBadge();
    
    // Disable/enable other tab buttons visually
    const tabLogs = document.getElementById('tab-logs');
    const tabSearch = document.getElementById('tab-search');
    const tabTools = document.getElementById('tab-tools');
    
    if (tabLogs && tabSearch && tabTools) {
      if (!valid) {
        tabLogs.style.opacity = '0.5';
        tabSearch.style.opacity = '0.5';
        tabTools.style.opacity = '0.5';
        // Force settings tab if currently on another tab
        const activeTabBtn = document.querySelector('.tab-btn.active');
        if (activeTabBtn && activeTabBtn.id !== 'tab-settings') {
          switchTab('settings');
        }
      } else {
        tabLogs.style.opacity = '1';
        tabSearch.style.opacity = '1';
        tabTools.style.opacity = '1';
      }
    }
    
    updateButtonLocks();
  }

  function switchTab(name) {
    if (name !== 'settings' && !isLicenseValid) {
      showStatus('Please enter a valid license key in Settings to unlock features!', 'error');
      name = 'settings';
    }
    Object.entries(tabs).forEach(([key, { btn, section }]) => {
      btn.classList.toggle('active', key === name);
      section.classList.toggle('active', key === name);
    });
    if (name === 'logs')   loadLogs();
    if (name === 'search') {
      checkSearchIndexStatus();
      chrome.storage.local.get({ initialAnalysisDone: false }, (data) => {
        if (data.initialAnalysisDone) {
          document.getElementById('searchInput').focus();
        }
      });
    }
    if (name === 'groups') loadGroupsTab();

    // Save tab selection to persist it
    chrome.storage.local.set({ lastActiveTab: name });
  }

  async function checkLicenseKey(key) {
    if (!key) {
      lblLicenseStatus.className = 'license-status-label';
      lblLicenseStatus.textContent = '';
      // Clear cached validity when key is removed
      chrome.storage.local.set({ licenseValid: false });
      setLicenseState(false);
      return;
    }
    lblLicenseStatus.className = 'license-status-label';
    lblLicenseStatus.style.display = 'block';
    lblLicenseStatus.style.color = 'var(--text-muted)';
    lblLicenseStatus.textContent = 'Checking key…';
    try {
      const response = await fetch(`${PROXY_URL}/api/validate-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await response.json();
      if (data.valid) {
        lblLicenseStatus.className = 'license-status-label valid';
        lblLicenseStatus.textContent = 'Valid license key!';
        // Cache the valid result so offline reopens still show Active
        chrome.storage.local.set({ licenseValid: true });
        setLicenseState(true);
      } else {
        lblLicenseStatus.className = 'license-status-label invalid';
        lblLicenseStatus.textContent = 'Invalid license key';
        chrome.storage.local.set({ licenseValid: false });
        setLicenseState(false);
      }
    } catch {
      // Server is offline — fall back to last cached validation result
      chrome.storage.local.get({ licenseValid: false }, (cached) => {
        if (cached.licenseValid) {
          lblLicenseStatus.className = 'license-status-label valid';
          lblLicenseStatus.textContent = 'Active (offline)';
          setLicenseState(true);
        } else {
          lblLicenseStatus.className = 'license-status-label invalid';
          lblLicenseStatus.textContent = 'Offline (Server Error)';
          setLicenseState(false);
        }
      });
    }
  }

  let licenseTimer;
  txtLicenseKey.addEventListener('input', () => {
    clearTimeout(licenseTimer);
    licenseTimer = setTimeout(() => checkLicenseKey(txtLicenseKey.value.trim()), 500);
  });

  function loadSettings() {
    chrome.storage.local.get({ autoOrganize: true, showNotifications: true, weeklyDigest: true, keepUserFolders: true, licenseKey: '', licenseValid: false, lastActiveTab: 'logs' }, (items) => {
      chkAutoOrganize.checked   = items.autoOrganize;
      chkNotifications.checked  = items.showNotifications;
      chkWeeklyDigest.checked   = items.weeklyDigest;
      chkKeepUserFolders.checked = items.keepUserFolders;
      txtLicenseKey.value       = items.licenseKey;

      const startTab = items.lastActiveTab || 'logs';
      if (items.licenseKey) {
        // Apply cached license state immediately so UI doesn't flash Offline
        if (items.licenseValid) {
          setLicenseState(true);
          switchTab(startTab);
        }
        // Then verify with server (and run testApiKey AFTER so it doesn't race)
        checkLicenseKey(items.licenseKey).then(() => {
          if (!items.licenseValid) {
            // First open or previously invalid — navigate based on fresh result
            if (isLicenseValid) {
              switchTab(startTab);
            } else {
              switchTab('settings');
            }
          }
          // Run ping after license check so refreshStatusBadge has final state
          testApiKey();
        });
      } else {
        setLicenseState(false);
        switchTab('settings');
        testApiKey();
      }
    });
  }

  function saveSettingsAuto() {
    chrome.storage.local.set({
      autoOrganize:      chkAutoOrganize.checked,
      showNotifications: chkNotifications.checked,
      weeklyDigest:      chkWeeklyDigest.checked,
      keepUserFolders:   chkKeepUserFolders.checked,
      licenseKey:        txtLicenseKey.value.trim(),
    });
  }

  [chkAutoOrganize, chkNotifications, chkWeeklyDigest, chkKeepUserFolders].forEach(input => {
    input.addEventListener('change', saveSettingsAuto);
  });

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    chrome.storage.local.set({
      autoOrganize:      chkAutoOrganize.checked,
      showNotifications: chkNotifications.checked,
      weeklyDigest:      chkWeeklyDigest.checked,
      keepUserFolders:   chkKeepUserFolders.checked,
      licenseKey:        txtLicenseKey.value.trim(),
    }, () => {
      checkLicenseKey(txtLicenseKey.value.trim()).then(() => {
        showStatus('Settings saved!', 'success');
      });
    });
  });

  function showStatus(msg, type) {
    const defaultText = document.getElementById('defaultFooterText');
    if (defaultText) defaultText.style.display = 'none';
    statusMessage.textContent = msg;
    statusMessage.className = `status-msg ${type}`;
    setTimeout(() => {
      statusMessage.textContent = '';
      statusMessage.className = 'status-msg';
      if (defaultText) defaultText.style.display = 'block';
    }, 3000);
  }

  // ── Helper ──
  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ──────────────────────────────────────────────────
  // FEATURE ACTIVITY TAB
  // ──────────────────────────────────────────────────
  const logContainer   = document.getElementById('logContainer');
  const btnClearLogs   = document.getElementById('btnClearLogs');
  const btnOrganize    = document.getElementById('btnOrganizeExisting');
  const bulkStatus     = document.getElementById('bulkStatus');
  const progressBar    = document.getElementById('progressBar');
  const bulkStatusText = document.getElementById('bulkStatusText');
  const bulkProgCount  = document.getElementById('bulkProgressCount');
  const btnDismissBulk = document.getElementById('btnDismissBulk');
  const btnCancelBulk  = document.getElementById('btnCancelBulk');

  function loadLogs() {
    chrome.storage.local.get({ activityLogs: [] }, (data) => renderLogs(data.activityLogs));
  }

  function renderLogs(logs) {
    logContainer.innerHTML = '';
    if (logs.length === 0) {
      logContainer.innerHTML = `<div class="no-logs">
        <svg viewBox="0 0 24 24" width="28" height="28" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p>No activity yet.</p><span>Organized bookmarks appear here.</span>
      </div>`;
      return;
    }
    logs.forEach(log => {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      const ts = new Date(log.timestamp);
      const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = ts.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const iconSvg = log.success
        ? `<svg class="log-entry-icon success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 8 8 12 12 16"/><line x1="16" y1="12" x2="8" y2="12"/></svg>`
        : `<svg class="log-entry-icon error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
      const tagsHtml = (log.tags && log.tags.length > 0)
        ? `<div class="log-entry-tags">${log.tags.slice(0, 3).map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';
      const details = log.success
        ? `<span class="log-entry-title">${escapeHtml(log.title)}</span>
           <span class="log-entry-path">📁 ${escapeHtml(log.folderName)}</span>
           ${tagsHtml}
           <span class="log-entry-time">${dateStr} ${timeStr}</span>`
        : `<span class="log-entry-title" style="color:var(--error)">${escapeHtml(log.title)}</span>
           <span class="log-entry-path">${escapeHtml(log.error || 'Unknown error')}</span>
           <span class="log-entry-time">${dateStr} ${timeStr}</span>`;
      entry.innerHTML = `${iconSvg}<div class="log-entry-details">${details}</div>`;
      logContainer.appendChild(entry);
    });
  }

  btnClearLogs.addEventListener('click', () => {
    chrome.storage.local.set({ activityLogs: [] }, () => { loadLogs(); showStatus('Logs cleared', 'info'); });
  });

  btnOrganize.addEventListener('click', () => {
    btnDismissBulk.classList.add('hidden');
    bulkStatus.classList.remove('hidden');
    progressBar.style.width = '0%';
    bulkStatusText.textContent = 'Scanning…';
    bulkProgCount.textContent = '';
    
    // Set status to processing immediately to trigger locks
    chrome.storage.local.set({ bulkOrganizeStatus: { status: 'processing', current: 0, total: 100, progress: 0 } }, () => {
      updateButtonLocks();
      chrome.runtime.sendMessage({ action: 'organize_existing' });
    });
  });

  btnDismissBulk.addEventListener('click', () => {
    chrome.storage.local.remove('bulkOrganizeStatus', () => {
      bulkStatus.classList.add('hidden');
      updateButtonLocks();
    });
  });

  btnCancelBulk.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancel_bulk_organize' });
  });

  // ──────────────────────────────────────────────────
  // FEATURE 7: SEARCH TAB
  // ──────────────────────────────────────────────────
  const searchInput   = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  let searchTimer;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(searchInput.value.trim()), 200);
  });

  // Helper to build the bookmark path recursively
  function getBookmarkPath(nodeId, callback, pathParts = []) {
    if (!nodeId || nodeId === '0') {
      callback(pathParts.reverse().join(' > '));
      return;
    }
    chrome.bookmarks.get(nodeId, (results) => {
      if (chrome.runtime.lastError || !results || results.length === 0) {
        callback(pathParts.reverse().join(' > '));
        return;
      }
      const node = results[0];
      if (node.title) {
        pathParts.push(node.title);
      }
      getBookmarkPath(node.parentId, callback, pathParts);
    });
  }

  function getAllBookmarks(callback) {
    chrome.bookmarks.getTree((tree) => {
      const list = [];
      function traverse(node) {
        if (node.url) {
          list.push(node);
        }
        if (node.children) {
          node.children.forEach(traverse);
        }
      }
      if (tree && tree.length > 0) {
        traverse(tree[0]);
      }
      callback(list);
    });
  }

  const STOP_WORDS = new Set([
    'with','your','from','this','that','and','the','for','its','are','was',
    'not','can','all','has','have','will','just','into','more','also','but',
    'web','internet','online','website','site','page','pages','portal','domain',
    'url','http','https','www','html','link','links','browse','browsing'
  ]);

  async function scrapeMetadataTags(url, title) {
    const tags = new Set();
    
    // Retrieve license key from storage for server authentication
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
        
        // Parse words from title
        if (data.title) {
          const titleWords = data.title.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/);
          titleWords.forEach(w => {
            if (w.length >= 4 && !STOP_WORDS.has(w)) tags.add(w);
          });
        }
        
        // Parse words from description
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

    // Combine with fallback tags to guarantee tags
    const fallback = getFallbackTags(title, url);
    fallback.forEach(t => tags.add(t));

    return Array.from(tags).slice(0, 15);
  }

  function startBackgroundEnrichment(allBookmarks, bookmarkTags) {
    const queue = allBookmarks.filter(bm => bm.url && (!bookmarkTags[bm.id] || bookmarkTags[bm.id].length <= 5));
    if (queue.length === 0) return;

    let index = 0;
    const batchSize = 3;

    async function processNextBatch() {
      if (index >= queue.length) return;

      const batch = queue.slice(index, index + batchSize);
      index += batchSize;

      const promises = batch.map(async (bm) => {
        try {
          const tags = await scrapeMetadataTags(bm.url, bm.title);
          if (tags && tags.length > 0) {
            bookmarkTags[bm.id] = tags;
          }
        } catch (e) {}
      });

      await Promise.all(promises);
      chrome.storage.local.set({ bookmarkTags });

      setTimeout(processNextBatch, 1000);
    }

    processNextBatch();
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

  const SYNONYM_MAP = {
    'social': ['social-media', 'twitter', 'instagram', 'facebook', 'linkedin', 'reddit', 'x.com'],
    'chat': ['messaging', 'communication', 'whatsapp', 'telegram', 'messenger', 'slack', 'discord', 'viber', 'wechat', 'signal', 'line'],
    'messaging': ['chat', 'communication', 'whatsapp', 'telegram', 'messenger', 'slack', 'discord', 'viber', 'wechat', 'signal', 'line'],
    'communication': ['chat', 'messaging', 'email', 'gmail', 'mail', 'whatsapp', 'telegram', 'slack', 'discord'],
    'email': ['gmail', 'mail', 'proton', 'outlook', 'zoho', 'communication'],
    'mail': ['gmail', 'email', 'proton', 'outlook', 'zoho', 'communication'],
    'video': ['youtube', 'netflix', 'twitch', 'streaming', 'zoom', 'meetings', 'entertainment'],
    'streaming': ['youtube', 'netflix', 'twitch', 'video', 'entertainment'],
    'movie': ['youtube', 'netflix', 'video', 'streaming', 'entertainment', 'cinema'],
    'code': ['development', 'dev', 'programming', 'github', 'stackoverflow', 'coder', 'replit', 'codepen'],
    'dev': ['development', 'code', 'programming', 'github', 'stackoverflow', 'replit', 'codepen'],
    'development': ['dev', 'code', 'programming', 'github', 'stackoverflow', 'replit', 'codepen'],
    'programming': ['dev', 'code', 'development', 'github', 'stackoverflow'],
    'ai': ['artificial-intelligence', 'chatgpt', 'openai', 'gemini', 'claude', 'copilot', 'llm', 'midjourney', 'huggingface'],
    'artificial-intelligence': ['ai', 'chatgpt', 'openai', 'gemini', 'claude', 'llm'],
    'search': ['google', 'bing', 'duckduckgo', 'engine', 'find'],
    'shop': ['shopping', 'ecommerce', 'store', 'amazon', 'ebay', 'shopify', 'aliexpress'],
    'shopping': ['shop', 'ecommerce', 'store', 'amazon', 'ebay', 'shopify', 'aliexpress'],
    'notes': ['notion', 'productivity', 'document', 'google-docs'],
    'docs': ['google-docs', 'documents', 'notion', 'productivity']
  };

  function getLevenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  function isBookmarkMatch(query, searchString, targetWords) {
    const cleanQuery = query.toLowerCase().trim();
    const tokens = cleanQuery.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return false;

    // Check if the entire query has a synonym (e.g. "artificial intelligence" -> "artificial-intelligence")
    const normalizedQuery = tokens.join('-');
    if (SYNONYM_MAP[normalizedQuery]) {
      const synonyms = SYNONYM_MAP[normalizedQuery];
      const allConcepts = [normalizedQuery, ...synonyms];
      const matchPhrase = allConcepts.some(c => {
        const cleanConcept = c.replace(/-/g, ' ');
        if (searchString.includes(c) || searchString.includes(cleanConcept)) return true;
        return targetWords.includes(c);
      });
      if (matchPhrase) return true;
    }

    // Default: token-by-token matching (AND search)
    return tokens.every(token => {
      const synonyms = SYNONYM_MAP[token] || [];
      const allTokens = [token, ...synonyms];

      return allTokens.some(t => {
        if (searchString.includes(t)) return true;
        if (t.length >= 4) {
          return targetWords.some(word => {
            if (word.length >= 4) {
              const maxEdits = t.length >= 6 ? 2 : 1;
              return getLevenshteinDistance(t, word) <= maxEdits;
            }
            return false;
          });
        }
        return false;
      });
    });
  }

  function renderDetails(title, url, tags) {
    return `
      <span class="search-result-title">${escapeHtml(title || url)}</span>
      <span class="search-result-url">${escapeHtml(url)}</span>
      <span class="search-result-path"></span>
    `;
  }

  function groupAndSortBookmarks(bookmarks, queryTokens, bookmarkTags, searchClicks) {
    const scores = {};
    bookmarks.forEach(bm => {
      let score = 0;
      const title = (bm.title || '').toLowerCase();
      const url = (bm.url || '').toLowerCase();
      let tags = bookmarkTags[bm.id];
      if (!tags || tags.length === 0) {
        tags = getFallbackTags(bm.title, bm.url);
      }

      // Title matches
      queryTokens.forEach(token => {
        if (title === token) score += 15;
        else if (title.includes(token)) score += 8;
      });

      // URL matches
      queryTokens.forEach(token => {
        if (url.includes(token)) score += 4;
      });

      // Tag matches
      queryTokens.forEach(token => {
        const synonyms = SYNONYM_MAP[token] || [];
        const allTokens = [token, ...synonyms];
        allTokens.forEach(t => {
          if (tags.includes(t)) score += 2;
        });
      });

      // Recency Boost
      if (bm.dateAdded) {
        const ageInDays = (Date.now() - bm.dateAdded) / (1000 * 60 * 60 * 24);
        if (ageInDays < 7) score += 3;
        else if (ageInDays < 30) score += 1.5;
      }

      // Click Frequency Boost
      const clickCount = searchClicks[bm.id] || 0;
      score += clickCount * 5;

      scores[bm.id] = score;
    });

    // Group bookmarks by domain
    const groupMap = {};
    const groupList = [];
    bookmarks.forEach(bm => {
      let domain = 'Other';
      try {
        domain = new URL(bm.url).hostname.replace(/^www\./, '');
      } catch {}
      const score = scores[bm.id] || 0;
      if (!groupMap[domain]) {
        groupMap[domain] = { domain, items: [], maxScore: score };
        groupList.push(groupMap[domain]);
      }
      groupMap[domain].items.push(bm);
      if (score > groupMap[domain].maxScore) {
        groupMap[domain].maxScore = score;
      }
    });

    // Sort groups by their maximum score
    groupList.sort((a, b) => b.maxScore - a.maxScore);

    // Within each group, sort bookmarks by score
    groupList.forEach(g => {
      g.items.sort((a, b) => scores[b.id] - scores[a.id]);
    });

    // Slice total displayed to 30 items
    let totalDisplayed = 0;
    const groupsToDisplay = [];
    for (const g of groupList) {
      const displayedItems = [];
      for (const item of g.items) {
        displayedItems.push(item);
        totalDisplayed++;
        if (totalDisplayed >= 30) break;
      }
      if (displayedItems.length > 0) {
        groupsToDisplay.push({ domain: g.domain, items: displayedItems });
      }
      if (totalDisplayed >= 30) break;
    }

    return groupsToDisplay;
  }

  function renderSearchResults(groupsToDisplay, bookmarkTags) {
    searchResults.innerHTML = '';

    // Hint bar
    const hint = document.createElement('div');
    hint.className = 'search-results-hint';
    hint.textContent = 'Ctrl + Click to open in background tab';
    searchResults.appendChild(hint);

    groupsToDisplay.forEach(group => {
      // Domain Header
      const domainHeader = document.createElement('div');
      domainHeader.className = 'search-domain-header';
      domainHeader.style.cssText = `
        font-size: 8.5px;
        font-weight: 800;
        text-transform: uppercase;
        color: var(--text-muted);
        padding: 7px 10px 3px 10px;
        background: #f9fafb;
        border-bottom: 1.5px solid #f0f0f0;
        border-top: 1px solid #f0f0f0;
        letter-spacing: 0.03em;
      `;
      domainHeader.textContent = group.domain;
      searchResults.appendChild(domainHeader);

      group.items.forEach(bm => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        let tags = bookmarkTags[bm.id];
        if (!tags || tags.length === 0) {
          tags = getFallbackTags(bm.title, bm.url);
        }
        item.innerHTML = `
          <img class="search-result-favicon" src="${getFaviconUrl(bm.url, 16)}" onerror="this.src='${FALLBACK_FAVICON}'" alt="">
          <div class="search-result-details">
            ${renderDetails(bm.title, bm.url, tags)}
          </div>
          <span class="search-result-opened" aria-hidden="true">Opened!</span>`;

        let hoverTimer = null;
        let isHovered = false;

        item.addEventListener('mouseenter', () => {
          if (item.classList.contains('editing')) return;
          isHovered = true;
          hoverTimer = setTimeout(() => {
            if (!isHovered) return;
            if (item.classList.contains('editing')) return;
            const pathEl = item.querySelector('.search-result-path');
            if (pathEl && pathEl.textContent) {
              item.classList.add('show-path');
              return;
            }
            if (!bm.parentId) return;
            getBookmarkPath(bm.parentId, (path) => {
              if (isHovered && path && pathEl) {
                pathEl.textContent = '📁 ' + path;
                item.classList.add('show-path');
              }
            });
          }, 1000);
        });

        item.addEventListener('mouseleave', () => {
          isHovered = false;
          clearTimeout(hoverTimer);
          item.classList.remove('show-path');
        });

        item.addEventListener('click', (e) => {
          if (item.classList.contains('editing')) return;
          isHovered = false;
          clearTimeout(hoverTimer);

          // Record search click popularity
          chrome.storage.local.get({ searchClicks: {} }, (data) => {
            const clicks = data.searchClicks || {};
            clicks[bm.id] = (clicks[bm.id] || 0) + 1;
            chrome.storage.local.set({ searchClicks: clicks });
          });

          if (e.ctrlKey || e.metaKey) {
            chrome.tabs.create({ url: bm.url, active: false });
            item.classList.add('opened');
            setTimeout(() => item.classList.remove('opened'), 1200);
          } else {
            chrome.tabs.create({ url: bm.url, active: true });
          }
        });

        // Helper to start inline editing
        const startInlineEdit = () => {
          if (item.classList.contains('editing')) return;
          item.classList.add('editing');
          item.classList.remove('show-path');
          isHovered = false;
          clearTimeout(hoverTimer);

          const detailsEl = item.querySelector('.search-result-details');
          const oldTitle = bm.title || bm.url;
          const oldUrl = bm.url;

          detailsEl.innerHTML = `
            <input type="text" class="edit-title-input" value="${escapeHtml(oldTitle)}" style="width:100%; font-size:9px; font-weight:700; border:1.5px solid var(--border-dark); padding:2px 4px; outline:none; margin-bottom:3px; background:#fff; font-family:inherit;">
            <input type="text" class="edit-url-input" value="${escapeHtml(oldUrl)}" style="width:100%; font-size:8px; border:1.5px solid var(--border-dark); padding:2px 4px; outline:none; background:#fff; font-family:inherit;">
          `;

          const titleInput = detailsEl.querySelector('.edit-title-input');
          const urlInput = detailsEl.querySelector('.edit-url-input');
          titleInput.focus();

          const saveEdit = () => {
            const newTitle = titleInput.value.trim();
            const newUrl = urlInput.value.trim();
            if (!newTitle || !newUrl) return cancelEdit();

            chrome.bookmarks.update(bm.id, { title: newTitle, url: newUrl }, (updatedNode) => {
              if (chrome.runtime.lastError) {
                showStatus('Failed to update bookmark', 'error');
                cancelEdit();
                return;
              }
              bm.title = updatedNode.title;
              bm.url = updatedNode.url;

              item.classList.remove('editing');
              detailsEl.innerHTML = renderDetails(bm.title, bm.url, tags);
              showStatus('Bookmark updated!', 'success');
            });
          };

          const cancelEdit = () => {
            item.classList.remove('editing');
            detailsEl.innerHTML = renderDetails(oldTitle, oldUrl, tags);
          };

          const handleKey = (ev) => {
            if (ev.key === 'Enter') {
              saveEdit();
            } else if (ev.key === 'Escape') {
              cancelEdit();
            }
          };
          titleInput.addEventListener('keydown', handleKey);
          urlInput.addEventListener('keydown', handleKey);

          const clickAwayHandler = (ev) => {
            if (!item.contains(ev.target)) {
              cancelEdit();
              document.removeEventListener('mousedown', clickAwayHandler);
            }
          };
          document.addEventListener('mousedown', clickAwayHandler);
        };

        item.startInlineEdit = startInlineEdit;

        // Custom Context Menu
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();

          const existingMenu = document.getElementById('custom-context-menu');
          if (existingMenu) existingMenu.remove();

          const menu = document.createElement('div');
          menu.id = 'custom-context-menu';
          
          let top = e.clientY;
          let left = e.clientX;
          if (left + 120 > window.innerWidth) left = window.innerWidth - 125;
          if (top + 100 > window.innerHeight) top = window.innerHeight - 105;

          menu.style.cssText = `
            position: fixed;
            top: ${top}px;
            left: ${left}px;
            background: #fff;
            border: 2px solid var(--border-dark);
            box-shadow: 2px 2px 0 var(--border-dark);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            padding: 2px;
          `;

          const createOption = (text, onClick) => {
            const opt = document.createElement('button');
            opt.style.cssText = `
              background: none;
              border: none;
              padding: 4px 8px;
              text-align: left;
              font-family: inherit;
              font-size: 8.5px;
              font-weight: 800;
              text-transform: uppercase;
              cursor: pointer;
              width: 100%;
              border-radius: 0;
            `;
            opt.textContent = text;
            opt.addEventListener('mouseover', () => opt.style.backgroundColor = 'var(--accent-lime)');
            opt.addEventListener('mouseout', () => opt.style.backgroundColor = 'transparent');
            opt.addEventListener('click', (ev) => {
              ev.stopPropagation();
              onClick();
              menu.remove();
            });
            return opt;
          };

          menu.appendChild(createOption('Open Incognito', () => {
            chrome.windows.create({ url: bm.url, incognito: true });
          }));

          menu.appendChild(createOption('Copy URL', () => {
            navigator.clipboard.writeText(bm.url).then(() => {
              showStatus('URL copied!', 'success');
            });
          }));

          menu.appendChild(createOption('Edit Bookmark', () => {
            startInlineEdit();
          }));

          const deleteOpt = createOption('Delete Bookmark', () => {
            chrome.bookmarks.remove(bm.id, () => {
              if (chrome.runtime.lastError) {
                showStatus('Failed to delete', 'error');
              } else {
                item.remove();
                showStatus('Bookmark deleted', 'success');
              }
            });
          });
          deleteOpt.style.color = 'var(--error)';
          menu.appendChild(deleteOpt);

          document.body.appendChild(menu);

          const closeMenu = () => {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            document.removeEventListener('contextmenu', closeMenu);
          };
          setTimeout(() => {
            document.addEventListener('click', closeMenu);
            document.addEventListener('contextmenu', closeMenu);
          }, 10);
        });

        searchResults.appendChild(item);
      });
    });
  }

  function doSearch(query) {
    if (!query) {
      searchResults.innerHTML = `<div class="no-logs">
        <svg viewBox="0 0 24 24" width="28" height="28" stroke="currentColor" stroke-width="2" fill="none"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>Search your bookmarks</p><span>Type above to find any saved page.</span>
      </div>`;
      return;
    }

    chrome.storage.local.get({ bookmarkTags: {}, searchClicks: {}, initialAnalysisDone: false }, (storageData) => {
      const bookmarkTags = storageData.bookmarkTags || {};
      const searchClicks = storageData.searchClicks || {};
      const initialAnalysisDone = storageData.initialAnalysisDone;

      getAllBookmarks((allBookmarks) => {
        const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        if (queryTokens.length === 0) {
          searchResults.innerHTML = `<div class="no-logs"><p>No results for "${escapeHtml(query)}"</p></div>`;
          return;
        }

        const newlyGeneratedTags = {};

        // Perform fast initial analysis if not done yet
        if (!initialAnalysisDone) {
          allBookmarks.forEach(bm => {
            if (bm.url && (!bookmarkTags[bm.id] || bookmarkTags[bm.id].length === 0)) {
              const tags = getFallbackTags(bm.title, bm.url);
              bookmarkTags[bm.id] = tags;
              newlyGeneratedTags[bm.id] = tags;
            }
          });
          chrome.storage.local.set({ initialAnalysisDone: true });
          startBackgroundEnrichment(allBookmarks, bookmarkTags);
        }

        const seenUrls = new Set();
        const bookmarks = [];
        for (const bm of allBookmarks) {
          if (bm.url) {
            const normUrl = bm.url.trim().toLowerCase();
            if (!seenUrls.has(normUrl)) {
              let tags = bookmarkTags[bm.id];
              if (!tags || tags.length === 0) {
                tags = getFallbackTags(bm.title, bm.url);
                bookmarkTags[bm.id] = tags;
                newlyGeneratedTags[bm.id] = tags;

                // Kick off background metadata scraping for this specific new bookmark
                scrapeMetadataTags(bm.url, bm.title).then(scraped => {
                  if (scraped && scraped.length > 0) {
                    chrome.storage.local.get({ bookmarkTags: {} }, (data) => {
                      const current = data.bookmarkTags || {};
                      current[bm.id] = scraped;
                      chrome.storage.local.set({ bookmarkTags: current });
                    });
                  }
                });
              }
              const searchString = `${bm.title || ''} ${bm.url} ${tags.join(' ')}`.toLowerCase();
              const targetWords = searchString.split(/[^a-z0-9]+/);
              const isMatch = isBookmarkMatch(query, searchString, targetWords);
              if (isMatch) {
                seenUrls.add(normUrl);
                bookmarks.push(bm);
              }
            }
          }
        }

        // Save any newly generated tags to storage
        if (Object.keys(newlyGeneratedTags).length > 0) {
          chrome.storage.local.get({ bookmarkTags: {} }, (data) => {
            const merged = Object.assign({}, data.bookmarkTags, newlyGeneratedTags);
            chrome.storage.local.set({ bookmarkTags: merged });
          });
        }

        if (bookmarks.length === 0) {
          searchResults.innerHTML = `<div class="no-logs"><p>No results for "${escapeHtml(query)}"</p></div>`;
          return;
        }

        const groupsToDisplay = groupAndSortBookmarks(bookmarks, queryTokens, bookmarkTags, searchClicks);
        renderSearchResults(groupsToDisplay, bookmarkTags);
      });
    });
  }


  // ──────────────────────────────────────────────────
  // GROUPS TAB — Custom Tab Group Creator
  // ──────────────────────────────────────────────────
  const TAB_GROUP_COLORS = ['blue','cyan','green','grey','orange','pink','purple','red','yellow'];
  let tgSelectedColor = 'blue';

  // Color swatch picker
  document.getElementById('tgSwatches').addEventListener('click', (e) => {
    const swatch = e.target.closest('.tg-swatch');
    if (!swatch) return;
    document.querySelectorAll('.tg-swatch').forEach(s => s.classList.remove('selected'));
    swatch.classList.add('selected');
    tgSelectedColor = swatch.dataset.color;
  });

  // Accordion toggle for Create Tab Group card
  document.getElementById('tgAccordionToggle').addEventListener('click', () => {
    document.getElementById('tgCreateCard').classList.toggle('open');
  });

  // Accordion toggle for Export & Import card
  document.getElementById('exportAccordionToggle').addEventListener('click', () => {
    document.getElementById('exportAccordionCard').classList.toggle('open');
  });

  // Load open tabs into checkbox list
  function loadGroupsTab() {
    const list = document.getElementById('tgTabsList');
    list.innerHTML = '<div style="font-size:9px;color:var(--text-muted);padding:4px 0;">Loading tabs…</div>';
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      const real = tabs.filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
      list.innerHTML = '';
      if (real.length === 0) {
        list.innerHTML = '<div style="font-size:9px;color:var(--text-muted);padding:4px 0;">No open tabs found.</div>';
        return;
      }
      real.forEach(tab => {
        const row = document.createElement('label');
        row.className = 'tg-tab-row';
        const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
        row.innerHTML = `
          <input type="checkbox" class="tg-tab-check" data-tabid="${tab.id}" checked>
          <img class="tg-tab-favicon" src="${getFaviconUrl(tab.url, 14)}" onerror="this.src='${FALLBACK_FAVICON}'" alt="">
          <span class="tg-tab-title">${escapeHtml(tab.title || tab.url)}</span>`;
        list.appendChild(row);
      });
    });

    // Refresh saved groups list too
    loadSavedGroups();
  }

  // Select All / Deselect All toggle
  let tgAllSelected = true;
  document.getElementById('tgSelectAll').addEventListener('click', () => {
    tgAllSelected = !tgAllSelected;
    document.querySelectorAll('.tg-tab-check').forEach(cb => cb.checked = tgAllSelected);
    document.getElementById('tgSelectAll').textContent = tgAllSelected ? 'Select All' : 'Deselect All';
  });

  // Create Group button
  document.getElementById('btnCreateGroup').addEventListener('click', () => {
    const nameInput = document.getElementById('tgGroupName');
    const groupName = nameInput.value.trim() || `WeBook — ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const checkedBoxes = [...document.querySelectorAll('.tg-tab-check:checked')];
    const tabIds = checkedBoxes.map(cb => parseInt(cb.dataset.tabid));

    if (tabIds.length === 0) {
      showStatus('Select at least one tab!', 'error');
      return;
    }

    // First, resolve all tab objects so we have title + url inline
    let resolvedTabs = [];
    let fetched = 0;
    tabIds.forEach(tabId => {
      chrome.tabs.get(tabId, (tab) => {
        if (tab) resolvedTabs.push({ title: tab.title || tab.url, url: tab.url });
        fetched++;
        if (fetched === tabIds.length) doCreateGroup(resolvedTabs);
      });
    });

    function doCreateGroup(resolvedTabs) {
      // Group them as a Chrome tab group
      chrome.tabs.group({ tabIds }, (groupId) => {
        chrome.tabGroups.update(groupId, { title: groupName, color: tgSelectedColor }, () => {
          getRealFolderId('2', (rootId) => {
            // Save to bookmark folder under "WeBook Tab Groups" (scoped to selected rootId)
            findTabGroupsFolder(rootId, (parentFolder) => {
                const createFolder = (parentId) => {
                  chrome.bookmarks.create({ parentId, title: groupName }, (folder) => {
                    // Bookmark each tab in the folder
                    resolvedTabs.forEach(t => chrome.bookmarks.create({ parentId: folder.id, title: t.title, url: t.url }));
                    // Save metadata including inline tabs array
                    chrome.storage.local.get({ savedTabGroups: [] }, (data) => {
                      const entry = {
                        id: folder.id,
                        name: groupName,
                        color: tgSelectedColor,
                        savedAt: Date.now(),
                        tabs: resolvedTabs          // ← inline tab data
                      };
                      data.savedTabGroups.unshift(entry);
                      chrome.storage.local.set({ savedTabGroups: data.savedTabGroups }, () => {
                        showStatus(`Group "${groupName}" created!`, 'success');
                        nameInput.value = '';
                        loadSavedGroups();
                      });
                    });
                  });
                };
                if (parentFolder) {
                  createFolder(parentFolder.id);
                } else {
                  chrome.bookmarks.create({ parentId: rootId, title: 'WeBook Tab Groups' }, (pf) => createFolder(pf.id));
                }
              });
            });
          });
        });
      }
  });

  // Load saved groups list
  function loadSavedGroups() {
    chrome.storage.local.get({ savedTabGroups: [] }, (data) => renderSavedGroups(data.savedTabGroups));
  }

  // Helper: render a list of {title, url} tabs into a pane element
  function renderTabsInPane(pane, tabs) {
    pane.innerHTML = '';
    if (!tabs || tabs.length === 0) {
      pane.innerHTML = '<div style="font-size:8px;color:var(--text-muted);padding:4px 8px;">No tabs saved.</div>';
      return;
    }
    tabs.forEach(t => {
      const host = (() => { try { return new URL(t.url).hostname; } catch { return ''; } })();
      const tabRow = document.createElement('div');
      tabRow.className = 'tg-subtab-row';
      tabRow.innerHTML = `
        <img src="${getFaviconUrl(t.url, 12)}" onerror="this.src='${FALLBACK_FAVICON}'" style="width:12px;height:12px;flex-shrink:0;">
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.title || t.url)}</span>`;
      tabRow.addEventListener('click', (ev) => {
        ev.stopPropagation();
        chrome.tabs.create({ url: t.url, active: false });
      });
      pane.appendChild(tabRow);
    });
  }

  const SWATCH_HEX = { blue:'#6aaff8', cyan:'#4ecacc', green:'#5eb668', yellow:'#f8d153', orange:'#f4954f', red:'#e96059', pink:'#f4a4c0', purple:'#a47fd9', grey:'#b0b3b6' };

  function renderSavedGroups(groups) {
    const list = document.getElementById('tgSavedList');
    if (groups.length === 0) {
      list.classList.add('no-scroll');
      list.innerHTML = `<div class="no-logs" style="border: 2px dashed var(--dot-color); padding: 10px; height: 100%; justify-content: center; box-sizing: border-box;">
        <svg viewBox="0 0 24 24" width="28" height="28" stroke="var(--text-muted)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 2px; flex-shrink: 0;"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        <p style="font-size: 11px; font-weight: 700; color: var(--text-dark); margin: 1px 0; flex-shrink: 0;">No saved groups yet</p>
        <span style="font-size: 9px; color: var(--text-muted); flex-shrink: 0;">Save groups of open tabs to manage them here.</span>
      </div>`;
      return;
    }
    list.classList.remove('no-scroll');
    list.innerHTML = '';
    groups.forEach((g, idx) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'tg-group-wrapper';

      // ── Header row ──
      const row = document.createElement('div');
      row.className = 'tg-saved-row';
      const date = new Date(g.savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      row.innerHTML = `
        <span class="tg-saved-dot" style="background:${SWATCH_HEX[g.color] || '#999'};"></span>
        <div class="tg-saved-info">
          <span class="tg-saved-name">${escapeHtml(g.name)}</span>
          <span class="tg-saved-date">${date}</span>
        </div>
        <svg class="tg-expand-arrow" viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="6 9 12 15 18 9"/></svg>
        <button class="btn-mini tg-btn-delete" title="Remove" style="color:var(--error);">✕</button>`;

      // ── Tabs sub-list ──
      const tabsPane = document.createElement('div');
      tabsPane.className = 'tg-tabs-pane';
      tabsPane.style.cssText = 'display:none; flex-direction:column; border-top:1px solid #e5e7eb;';

      // Load tabs from bookmark folder — fall back to inline g.tabs if folder missing/empty
      chrome.bookmarks.getChildren(g.id, (children) => {
        const fallbackTabs = g.tabs || [];
        // Use getChildren result if valid and non-empty
        const liveTabs = !chrome.runtime.lastError && children && children.length > 0
          ? children.filter(c => c.url).map(c => ({ title: c.title, url: c.url }))
          : null;
        if (liveTabs && liveTabs.length > 0) {
          renderTabsInPane(tabsPane, liveTabs);
        } else if (fallbackTabs.length > 0) {
          renderTabsInPane(tabsPane, fallbackTabs);
        } else {
          tabsPane.innerHTML = '<div style="font-size:8px;color:var(--text-muted);padding:4px 8px;">'
            + (chrome.runtime.lastError ? '⚠ Bookmark folder deleted — re-export to recover tabs.' : 'No tabs saved.') + '</div>';
        }
      });

      wrapper.appendChild(row);
      wrapper.appendChild(tabsPane);

      // ── Arrow: expand/collapse tab list ONLY (no restore) ──
      row.querySelector('.tg-expand-arrow').addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = tabsPane.style.display === 'flex';
        tabsPane.style.display = isOpen ? 'none' : 'flex';
        row.querySelector('.tg-expand-arrow').style.transform = isOpen ? '' : 'rotate(180deg)';
      });

      // ── Name/dot area click: restore all tabs as Chrome tab group ──
      row.querySelector('.tg-saved-info').addEventListener('click', (e) => {
        e.stopPropagation();
        const tabs = g.tabs && g.tabs.length > 0 ? g.tabs : null;
        const restore = (urls) => {
          let openedIds = [], done = 0;
          urls.forEach(url => {
            chrome.tabs.create({ url, active: false }, (tab) => {
              openedIds.push(tab.id);
              done++;
              if (done === urls.length) {
                chrome.tabs.group({ tabIds: openedIds }, (groupId) => {
                  chrome.tabGroups.update(groupId, { title: g.name, color: g.color }, () => {
                    showStatus(`Restored "${g.name}"!`, 'success');
                  });
                });
              }
            });
          });
        };

        if (tabs) {
          restore(tabs.map(t => t.url));
        } else {
          chrome.bookmarks.getChildren(g.id, (children) => {
            if (chrome.runtime.lastError || !children || children.length === 0) {
              showStatus('Folder empty or deleted.', 'error'); return;
            }
            restore(children.filter(c => c.url).map(c => c.url));
          });
        }
      });

      // ── Dot click also restores (visual affordance) ──
      row.querySelector('.tg-saved-dot').addEventListener('click', (e) => {
        row.querySelector('.tg-saved-info').click();
      });


      // Delete button
      row.querySelector('.tg-btn-delete').addEventListener('click', () => {
        if (g.id) {
          chrome.bookmarks.removeTree(g.id, () => {
            if (chrome.runtime.lastError) {
              console.log('[WeBook] Folder already deleted or missing:', g.id);
            }
            setTimeout(cleanEmptyTabGroupsParent, 100);
          });
        }
        chrome.storage.local.get({ savedTabGroups: [] }, (data) => {
          data.savedTabGroups.splice(idx, 1);
          chrome.storage.local.set({ savedTabGroups: data.savedTabGroups }, () => renderSavedGroups(data.savedTabGroups));
        });
      });

      list.appendChild(wrapper);
    });
  }


  document.getElementById('tgRefreshSaved').addEventListener('click', loadSavedGroups);

  // #12 — JSON Export: full structured backup with folders, metadata, and timestamps
  document.getElementById('btnExportJson').addEventListener('click', () => {
    chrome.storage.local.get({ savedTabGroups: [], bookmarkTags: {} }, (storageData) => {
      // For groups that still lack inline tabs, backfill from their bookmark folder first
      const groups = storageData.savedTabGroups;
      const bookmarkTags = storageData.bookmarkTags || {};
      const needsBackfill = groups.filter(g => !g.tabs || g.tabs.length === 0);
      let pending = needsBackfill.length;

      const finishExport = () => {
        chrome.bookmarks.getTree((tree) => {
          const exportData = {
            exportedAt: new Date().toISOString(),
            exportedBy: 'WeBook Extension',
            version: '2.0',
            bookmarks: buildBookmarkJson(tree[0], bookmarkTags),
            savedTabGroups: groups
          };
          const json = JSON.stringify(exportData, null, 2);
          const blob = new Blob([json], { type: 'application/json' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href     = url;
          a.download = `WeBook_Backup_${new Date().toISOString().slice(0,10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          const groupCount = groups.length;
          showStatus(`Exported! (${groupCount} saved group${groupCount !== 1 ? 's' : ''} included)`, 'success');
        });
      };

      if (pending === 0) { finishExport(); return; }

      // Backfill tabs[] from bookmark folder for legacy groups
      needsBackfill.forEach(g => {
        chrome.bookmarks.getChildren(g.id, (children) => {
          if (!chrome.runtime.lastError && children && children.length > 0) {
            g.tabs = children.filter(c => c.url).map(c => ({ title: c.title, url: c.url }));
          }
          pending--;
          if (pending === 0) finishExport();
        });
      });
    });
  });

  // ── IMPORT FROM JSON BACKUP (clean replace) ──
  document.getElementById('btnImportJson').addEventListener('click', () => {
    document.getElementById('importJsonFile').click();
  });

  document.getElementById('importJsonFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('importStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Reading file…';

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);

        // ── Step 1: Clean wipe of existing WeBook Tab Groups bookmark folder ──
        const doImport = () => {
          getRealFolderId('2', (rootId) => {
              const importedGroups = Array.isArray(data.savedTabGroups) ? data.savedTabGroups : [];

              // ── Step 2: Clear savedTabGroups from storage ──
              chrome.storage.local.set({ savedTabGroups: [] }, () => {

                if (importedGroups.length === 0) {
                  finishBookmarkImport(data, statusEl, 0);
                  return;
                }

                // ── Step 3: Create fresh bookmark folders for all groups ──
                chrome.bookmarks.create({ parentId: rootId, title: 'WeBook Tab Groups' }, (parentFolder) => {
                  const freshGroups = [];
                  let completed = 0;

                importedGroups.forEach(g => {
                  const tabs = g.tabs || [];

                  if (tabs.length === 0) {
                    // No tab data — import as placeholder
                    freshGroups.push({ ...g, tabs });
                    completed++;
                    if (completed === importedGroups.length) saveGroups(freshGroups, importedGroups.length, data, statusEl);
                    return;
                  }

                  chrome.bookmarks.create({ parentId: parentFolder.id, title: g.name }, (folder) => {
                    // Create bookmark entries for each tab
                    let tabsDone = 0;
                    tabs.forEach(t => {
                      chrome.bookmarks.create({ parentId: folder.id, title: t.title || t.url, url: t.url }, () => {
                        tabsDone++;
                        if (tabsDone === tabs.length) {
                          // All tabs bookmarked — record fresh entry
                          freshGroups.push({ id: folder.id, name: g.name, color: g.color, savedAt: g.savedAt, tabs });
                          completed++;
                          if (completed === importedGroups.length) saveGroups(freshGroups, importedGroups.length, data, statusEl);
                        }
                      });
                    });
                  });
                });
              });
            });
          });
        };

        // Scope the cleanup of old tab groups folder tree inside Other Bookmarks ('2')
        getRealFolderId('2', (rootId) => {
          findTabGroupsFolder(rootId, (oldFolder) => {
            if (oldFolder) {
              chrome.bookmarks.removeTree(oldFolder.id, doImport);
            } else {
              doImport();
            }
          });
        });

        // ── Step 4: Import bookmarks tree ──
        const root = data.bookmarks || null;
        if (root && (root.children || root.url)) {
          statusEl.textContent = 'Importing bookmarks…';
          let imported = 0, total = 0;
          function countNodes(node) {
            if (node.url) { total++; return; }
            (node.children || []).forEach(countNodes);
          }
          countNodes(root);

          const newBookmarkTags = {};
          let pendingOperations = 0;

          function checkSaveTags() {
            if (pendingOperations === 0 && Object.keys(newBookmarkTags).length > 0) {
              chrome.storage.local.get({ bookmarkTags: {} }, (tagData) => {
                const mergedTags = Object.assign({}, tagData.bookmarkTags, newBookmarkTags);
                chrome.storage.local.set({ bookmarkTags: mergedTags, initialAnalysisDone: true }, () => {
                  checkSearchIndexStatus();
                });
              });
            }
          }

          function importNode(node, parentId) {
            if (node.type === 'bookmark' || node.url) {
              pendingOperations++;
              chrome.bookmarks.create({ parentId, title: node.title || node.url, url: node.url }, (newBookmark) => {
                imported++;
                statusEl.textContent = `Importing bookmarks… ${imported}/${total}`;
                
                if (newBookmark && node.tags && Array.isArray(node.tags) && node.tags.length > 0) {
                  newBookmarkTags[newBookmark.id] = node.tags.slice(0, 15); // limit to 15 tags
                }

                pendingOperations--;
                checkSaveTags();
              });
            } else {
              // Skip the root "WeBook Tab Groups" folder — we handle that separately
              if (node.title === 'WeBook Tab Groups') return;
              pendingOperations++;
              chrome.bookmarks.create({ parentId, title: node.title || 'Folder' }, (folder) => {
                if (folder) {
                  (node.children || []).forEach(child => importNode(child, folder.id));
                }
                pendingOperations--;
                checkSaveTags();
              });
            }
          }
          getRealFolderId('1', (rootId) => {
            (root.children || [root]).forEach(child => {
                const titleLower = (child.title || '').toLowerCase().trim();
                if (child.type === 'folder' && (titleLower === 'favorites bar' || titleLower === 'bookmarks bar' || titleLower === 'favorites' || titleLower === 'bookmarks')) {
                  // Smart-merge backup Bookmarks/Favorites bar directly into browser's Favorites Bar root ('1')
                  (child.children || []).forEach(grandchild => importNode(grandchild, '1'));
                } else if (child.type === 'folder' && (titleLower === 'other favorites' || titleLower === 'other bookmarks')) {
                  // Smart-merge backup Other favorites directly into browser's Other Bookmarks root ('2')
                  (child.children || []).forEach(grandchild => importNode(grandchild, '2'));
                } else {
                  // Default: import normally into the selected rootId
                  importNode(child, rootId);
                }
              });
            });
        }

      } catch (err) {
        statusEl.textContent = '❌ Invalid JSON file.';
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  function saveGroups(freshGroups, groupCount, data, statusEl) {
    chrome.storage.local.set({ savedTabGroups: freshGroups }, () => {
      const bookmarkCount = data.bookmarks ? countBookmarks(data.bookmarks) : 0;
      const msg = `✅ Imported ${groupCount} group(s)${bookmarkCount > 0 ? ` + ${bookmarkCount} bookmarks` : ''}!`;
      statusEl.textContent = msg;
      showStatus(msg, 'success');
      if (document.getElementById('section-groups').classList.contains('active')) loadSavedGroups();
      setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
    });
  }

  function finishBookmarkImport(data, statusEl, groupCount) {
    const bookmarkCount = data.bookmarks ? countBookmarks(data.bookmarks) : 0;
    const msg = bookmarkCount > 0 ? `✅ Imported ${bookmarkCount} bookmarks!` : '✅ Import complete.';
    statusEl.textContent = msg;
    showStatus(msg, 'success');
    setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
  }

  function countBookmarks(node) {
    if (node.url) return 1;
    return (node.children || []).reduce((sum, c) => sum + countBookmarks(c), 0);
  }



  function buildBookmarkJson(node, bookmarkTags = {}) {
    if (node.url) {
      return {
        type: 'bookmark',
        id: node.id,
        title: node.title || '',
        url: node.url,
        dateAdded: node.dateAdded ? new Date(node.dateAdded).toISOString() : null,
        tags: bookmarkTags[node.id] || []
      };
    }
    return {
      type: 'folder',
      id: node.id,
      title: node.title || 'Untitled Folder',
      dateAdded: node.dateAdded ? new Date(node.dateAdded).toISOString() : null,
      children: (node.children || []).map(c => buildBookmarkJson(c, bookmarkTags))
    };
  }

  // ──────────────────────────────────────────────────
  // FEATURE 4: BROKEN LINK CHECKER
  // ──────────────────────────────────────────────────
  const btnCheckLinks    = document.getElementById('btnCheckLinks');
  const linkCheckStatus  = document.getElementById('linkCheckStatus');
  const linkProgressBar  = document.getElementById('linkProgressBar');
  const linkStatusText   = document.getElementById('linkStatusText');
  const linkProgCount    = document.getElementById('linkProgressCount');
  const deadLinksList    = document.getElementById('deadLinksList');
  const btnDismissLinks  = document.getElementById('btnDismissLinks');
  const btnCancelLinks   = document.getElementById('btnCancelLinks');

  btnCheckLinks.addEventListener('click', () => {
    btnDismissLinks.classList.add('hidden');
    linkCheckStatus.classList.remove('hidden');
    deadLinksList.classList.add('hidden');
    deadLinksList.innerHTML = '';
    linkProgressBar.style.width = '0%';
    linkStatusText.textContent = 'Scanning…';
    linkProgCount.textContent = '0/0';

    chrome.storage.local.set({ linkCheckStatus: { status: 'scanning', checked: 0, total: 100, dead: [] } }, () => {
      updateButtonLocks();
      chrome.runtime.sendMessage({ action: 'check_broken_links' });
    });
  });

  btnDismissLinks.addEventListener('click', () => {
    chrome.storage.local.remove('linkCheckStatus', () => {
      linkCheckStatus.classList.add('hidden');
      deadLinksList.classList.add('hidden');
      updateButtonLocks();
    });
  });

  btnCancelLinks.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancel_link_check' });
  });



  // ──────────────────────────────────────────────────
  // MULTI-TASK LOCKS & UTILS
  // ──────────────────────────────────────────────────
  function updateButtonLocks() {
    chrome.storage.local.get({ 
      bulkOrganizeStatus: null, 
      linkCheckStatus: null 
    }, (data) => {
      if (!isLicenseValid) return; // setLicenseState handled it

      const isBulkRunning  = data.bulkOrganizeStatus && data.bulkOrganizeStatus.status === 'processing';
      const isLinkRunning  = data.linkCheckStatus && data.linkCheckStatus.status === 'scanning';
      const isAnyRunning   = isBulkRunning || isLinkRunning;

      // Update stop/dismiss buttons visibility based on states
      if (isBulkRunning) {
        btnCancelBulk.classList.remove('hidden');
        btnDismissBulk.classList.add('hidden');
      } else {
        btnCancelBulk.classList.add('hidden');
        if (data.bulkOrganizeStatus && (data.bulkOrganizeStatus.status === 'completed' || data.bulkOrganizeStatus.status === 'error')) {
          btnDismissBulk.classList.remove('hidden');
        } else {
          btnDismissBulk.classList.add('hidden');
        }
      }

      if (isLinkRunning) {
        btnCancelLinks.classList.remove('hidden');
        btnDismissLinks.classList.add('hidden');
      } else {
        btnCancelLinks.classList.add('hidden');
        if (data.linkCheckStatus && data.linkCheckStatus.status === 'done') {
          btnDismissLinks.classList.remove('hidden');
        } else {
          btnDismissLinks.classList.add('hidden');
        }
      }

      function setButtonState(btn, runningText, normalText, active) {
        if (!btn) return;
        const textSpan = btn.querySelector('span') || btn;
        if (active) {
          btn.disabled = true;
          btn.style.opacity = '0.5';
          btn.style.cursor = 'not-allowed';
          textSpan.textContent = runningText;
        } else {
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.style.cursor = 'pointer';
          textSpan.textContent = normalText;
        }
      }

      setButtonState(btnOrganize, isBulkRunning ? 'Organizing…' : 'Wait for other task…', 'Organize Bookmarks', isAnyRunning);
      setButtonState(btnCheckLinks, isLinkRunning ? 'Checking…' : 'Wait for other task…', 'Check for Broken Links', isAnyRunning);
    });
  }

  function renderDeadLinks(dead) {
    deadLinksList.innerHTML = '';
    if (dead.length > 0) {
      deadLinksList.classList.remove('no-scroll');
      deadLinksList.classList.remove('hidden');
      dead.forEach(link => {
        const row = document.createElement('div');
        row.className = 'dead-link-item';
        row.innerHTML = `
          <a class="dead-link-title" href="${escapeHtml(link.url)}" target="_blank" title="${escapeHtml(link.url)}">${escapeHtml(link.title || link.url)}</a>
          <span class="dead-link-status">${link.status}</span>
          <button class="dead-link-remove" data-id="${link.id}">Remove</button>`;

        // Open link in new background tab without closing the extension popup
        const titleLink = row.querySelector('.dead-link-title');
        titleLink.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: link.url, active: false });
        });

        row.querySelector('.dead-link-remove').addEventListener('click', (e) => {
          const id = e.target.dataset.id;
          chrome.bookmarks.remove(id, () => {
            row.remove();
            showStatus('Removed', 'info');
            chrome.storage.local.get({ linkCheckStatus: null }, (d) => {
              if (d.linkCheckStatus) {
                const updatedDead = d.linkCheckStatus.dead.filter(x => x.id !== id);
                d.linkCheckStatus.dead = updatedDead;
                chrome.storage.local.set({ linkCheckStatus: d.linkCheckStatus }, () => {
                  linkStatusText.textContent = `Done — ${updatedDead.length} dead link${updatedDead.length !== 1 ? 's' : ''} found`;
                  if (updatedDead.length === 0) {
                    renderDeadLinks([]);
                  }
                });
              }
            });
          });
        });
        deadLinksList.appendChild(row);
      });
    } else {
      chrome.storage.local.get({ linkCheckStatus: null }, (data) => {
        if (data.linkCheckStatus && data.linkCheckStatus.status === 'done') {
          deadLinksList.classList.add('no-scroll');
          deadLinksList.classList.remove('hidden');
          deadLinksList.innerHTML = `<div class="no-logs" style="border: 2px dashed var(--dot-color); padding: 16px 8px; margin-top: 5px;">
            <svg viewBox="0 0 24 24" width="28" height="28" stroke="#22c55e" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 4px;"><circle cx="12" cy="12" r="10"/><polyline points="9 11 12 14 22 4"/></svg>
            <p style="font-size: 11px; font-weight: 700; color: #166534; margin: 2px 0;">All links are active!</p>
            <span style="font-size: 9px; color: var(--text-muted);">No broken bookmarks detected.</span>
          </div>`;
        } else {
          deadLinksList.classList.add('hidden');
        }
      });
    }
  }



  // ──────────────────────────────────────────────────
  // BACKGROUND MESSAGE LISTENER
  // ──────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id && sender.id !== chrome.runtime.id) return;
    // Bulk organizer progress
    if (message.action === 'bulk_progress') {
      const { current, total, progress, status, details } = message.data;
      progressBar.style.width = `${progress}%`;
      bulkProgCount.textContent = `${current}/${total}`;
      
      if (status === 'processing') {
        updateButtonLocks();
        bulkStatus.classList.remove('hidden');
        bulkStatusText.textContent = `Analyzing: ${details || '…'}`;
      } else if (status === 'completed') {
        updateButtonLocks();
        bulkStatusText.textContent = details || 'Done! Library organized.';
        progressBar.style.width = '100%';
        chrome.storage.local.set({ initialAnalysisDone: true });
        loadLogs();
      } else if (status === 'error') {
        updateButtonLocks();
        bulkStatusText.textContent = `Error: ${details || 'Failed'}`;
      }
    }

    // Broken link progress
    if (message.action === 'link_check_progress') {
      const { checked, total, status, dead } = message.data;
      const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
      linkProgressBar.style.width = `${pct}%`;
      linkProgCount.textContent = `${checked}/${total}`;
      
      if (status === 'scanning') {
        updateButtonLocks();
        linkCheckStatus.classList.remove('hidden');
        linkStatusText.textContent = `Checking… (${dead.length} dead)`;
        deadLinksList.classList.add('hidden');
      } else if (status === 'done') {
        updateButtonLocks();
        linkStatusText.textContent = `Done — ${dead.length} dead link${dead.length !== 1 ? 's' : ''} found`;
        renderDeadLinks(dead);
      }
    }


  });

  // ──────────────────────────────────────────────────
  // RESTORE RUNNING TASKS STATE
  // ──────────────────────────────────────────────────
  function checkActiveTasks() {
    chrome.storage.local.get({ 
      bulkOrganizeStatus: null, 
      linkCheckStatus: null
    }, (data) => {
      updateButtonLocks();

      // 1. Restore Bulk Organizer state
      if (data.bulkOrganizeStatus) {
        const { current, total, progress, status, details } = data.bulkOrganizeStatus;
        if (status === 'processing' || status === 'completed' || status === 'error') {
          bulkStatus.classList.remove('hidden');
          progressBar.style.width = `${progress}%`;
          bulkProgCount.textContent = `${current}/${total}`;
          if (status === 'processing') {
            bulkStatusText.textContent = `Analyzing: ${details || '…'}`;
            btnDismissBulk.classList.add('hidden');
          } else if (status === 'completed') {
            bulkStatusText.textContent = details || 'Done! Library organized.';
            btnDismissBulk.classList.remove('hidden');
          } else if (status === 'error') {
            bulkStatusText.textContent = `Error: ${details || 'Failed'}`;
            btnDismissBulk.classList.remove('hidden');
          }
        }
      } else {
        bulkStatus.classList.add('hidden');
      }

      // 2. Restore Link Checker state
      if (data.linkCheckStatus) {
        const { checked, total, status, dead } = data.linkCheckStatus;
        if (status === 'scanning' || status === 'done') {
          linkCheckStatus.classList.remove('hidden');
          const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
          linkProgressBar.style.width = `${pct}%`;
          linkProgCount.textContent = `${checked}/${total}`;
          
          if (status === 'scanning') {
            linkStatusText.textContent = `Checking… (${dead ? dead.length : 0} dead)`;
            btnDismissLinks.classList.add('hidden');
            deadLinksList.classList.add('hidden');
          } else if (status === 'done') {
            linkStatusText.textContent = `Done — ${dead ? dead.length : 0} dead link${dead && dead.length !== 1 ? 's' : ''} found`;
            btnDismissLinks.classList.remove('hidden');
            renderDeadLinks(dead || []);
          }
        }
      } else {
        linkCheckStatus.classList.add('hidden');
        deadLinksList.classList.add('hidden');
      }
    });
  }

  // ── INIT ──
  loadSettings();
  loadLogs();
  checkActiveTasks();
});
