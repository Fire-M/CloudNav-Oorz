import React, { useState, useEffect, useRef } from 'react';
import { X, Save, Bot, Key, Globe, Sparkles, PauseCircle, Wrench, Box, Copy, Check, LayoutTemplate, Info, Download, Sidebar, Keyboard, MousePointerClick, AlertTriangle, Package, Zap, Menu, Upload, Link2, Shield, Trash2, Archive, Play, Square, RefreshCw, Search } from 'lucide-react';
import { AIConfig, LinkItem, Category, SiteSettings } from '../types';
import { generateLinkDescription } from '../services/geminiService';
import { confirmDialog, alertDialog } from './ConfirmDialog';
import JSZip from 'jszip';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AIConfig;
  siteSettings: SiteSettings;
  onSave: (config: AIConfig, siteSettings: SiteSettings) => void;
  links: LinkItem[];
  categories: Category[];
  onUpdateLinks: (links: LinkItem[]) => void;
  authToken: string | null;
  authIssuedAt?: string;
}


const SettingsModal: React.FC<SettingsModalProps> = ({ 
    isOpen, onClose, config, siteSettings, onSave, links, categories, onUpdateLinks, authToken, authIssuedAt 
}) => {
  const [activeTab, setActiveTab] = useState<'site' | 'ai' | 'tools' | 'linkcheck'>('site');
  const [localConfig, setLocalConfig] = useState<AIConfig>(config);
  
  const [localSiteSettings, setLocalSiteSettings] = useState<SiteSettings>(() => ({
      title: siteSettings?.title || 'CloudNav - 我的导航',
      navTitle: siteSettings?.navTitle || 'CloudNav',
      favicon: siteSettings?.favicon || '',
      cardStyle: siteSettings?.cardStyle || 'detailed',
      requirePasswordOnVisit: siteSettings?.requirePasswordOnVisit ?? false,
      passwordExpiryDays: siteSettings?.passwordExpiryDays ?? 7,
      backgroundImage: siteSettings?.backgroundImage || '',
      backgroundImageType: siteSettings?.backgroundImageType || 'url'
  }));
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const shouldStopRef = useRef(false);

  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [browserType, setBrowserType] = useState<'chrome' | 'firefox'>('chrome');
  const [isZipping, setIsZipping] = useState(false);
  const faviconUploadRef = useRef<HTMLInputElement>(null);
  
  const [copiedStates, setCopiedStates] = useState<{[key: string]: boolean}>({});

  // 死链检测状态
  type LinkCheckResult = { linkId: string; url: string; title: string; alive: boolean; status: number; archiveUrl: string | null; error?: string };
  const [linkCheckStatus, setLinkCheckStatus] = useState<'idle' | 'running' | 'paused' | 'done'>('idle');
  const [linkCheckProgress, setLinkCheckProgress] = useState({ current: 0, total: 0 });
  const [linkCheckResults, setLinkCheckResults] = useState<LinkCheckResult[]>([]);
  const [currentCheckingUrl, setCurrentCheckingUrl] = useState('');
  const linkCheckAbortRef = useRef(false);
  const linkCheckPauseRef = useRef(false);

  // 重复书签检测状态
  type DuplicateGroup = { normalizedUrl: string; links: LinkItem[] };
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [hasScannedDuplicates, setHasScannedDuplicates] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLocalConfig(config);
      const safeSettings = {
          title: siteSettings?.title || 'CloudNav - 我的导航',
          navTitle: siteSettings?.navTitle || 'CloudNav',
          favicon: siteSettings?.favicon || '',
          cardStyle: siteSettings?.cardStyle || 'detailed',
          requirePasswordOnVisit: siteSettings?.requirePasswordOnVisit ?? false,
          passwordExpiryDays: siteSettings?.passwordExpiryDays ?? 7,
          backgroundImage: siteSettings?.backgroundImage || '',
          backgroundImageType: siteSettings?.backgroundImageType || 'url',
          backgroundOpacity: siteSettings?.backgroundOpacity ?? 40
      };
      setLocalSiteSettings(safeSettings);

      // 从 IndexedDB 加载背景图
      const loadBg = async () => {
        try {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('cloudnav_db', 1);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('background')) {
                db.createObjectStore('background');
              }
            };
          });
          const tx = db.transaction('background', 'readonly');
          const request = tx.objectStore('background').get('backgroundImage');
          request.onsuccess = () => {
            if (request.result) {
              setLocalSiteSettings(prev => ({ ...prev, backgroundImage: request.result }));
            }
          };
        } catch (err) {
          console.error('Failed to load background image from IndexedDB:', err);
        }
      };
      loadBg();

      setIsProcessing(false);
      setIsZipping(false);
      setProgress({ current: 0, total: 0 });
      shouldStopRef.current = false;
      setDomain(window.location.origin);
      const storedToken = authToken;
      if (storedToken) setPassword(storedToken);

      // 重置死链检测状态
      setLinkCheckStatus('idle');
      setLinkCheckResults([]);
      setLinkCheckProgress({ current: 0, total: 0 });
      setCurrentCheckingUrl('');
      // 重置重复检测状态
      setDuplicateGroups([]);
      setHasScannedDuplicates(false);
    }
  }, [isOpen, config, siteSettings]);

  const handleChange = (key: keyof AIConfig, value: string) => {
    setLocalConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSiteChange = async (key: keyof SiteSettings, value: any) => {
    setLocalSiteSettings(prev => {
        const next = { ...prev, [key]: value };
        
        // 如果是身份验证过期天数修改，立即保存到 KV 空间
        if (key === 'passwordExpiryDays' && authToken) {
            saveWebsiteConfigToKV(next);
        }
        
        return next;
    });
  };

  // 保存网站配置到 KV 空间
  const saveWebsiteConfigToKV = async (siteSettings: SiteSettings) => {
    try {
        // 如果有上传的背景图，单独保存
        if (siteSettings.backgroundImageType === 'upload' && siteSettings.backgroundImage) {
            const bgResponse = await fetch('/api/storage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-password': authToken || '',
                    ...(authIssuedAt ? { 'x-auth-issued-at': authIssuedAt } : {})
                },
                body: JSON.stringify({
                    saveConfig: 'background',
                    image: siteSettings.backgroundImage
                })
            });
            if (!bgResponse.ok) {
                console.error('Failed to save background image to KV:', bgResponse.statusText);
            }
        }

        // 保存网站配置（背景图字段只存类型，不存 base64 数据）
        const configToSave = {
            ...siteSettings,
            // 如果是上传的图片，不存 base64 到 website_config，只存类型标记
            backgroundImage: siteSettings.backgroundImageType === 'upload' ? '' : siteSettings.backgroundImage
        };

        const response = await fetch('/api/storage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-auth-password': authToken || '',
                ...(authIssuedAt ? { 'x-auth-issued-at': authIssuedAt } : {})
            },
            body: JSON.stringify({
                saveConfig: 'website',
                config: configToSave
            })
        });
        
        if (!response.ok) {
            console.error('Failed to save website config to KV:', response.statusText);
        }
    } catch (error) {
        console.error('Error saving website config to KV:', error);
    }
  };

  const handleSave = () => {
    console.log('SettingsModal handleSave, localSiteSettings:', {
      backgroundImage: localSiteSettings.backgroundImage?.substring(0, 100),
      backgroundImageType: localSiteSettings.backgroundImageType,
      backgroundOpacity: localSiteSettings.backgroundOpacity
    });
    onSave(localConfig, localSiteSettings);
    onClose();
  };

  const handleBulkGenerate = async () => {
    if (!localConfig.apiKey) {
        alertDialog({ message: "请先配置并保存 API Key", variant: 'warning', title: '未配置 API Key' });
        return;
    }

    const missingLinks = links.filter(l => !l.description);
    if (missingLinks.length === 0) {
        alertDialog({ message: "所有链接都已有描述！", variant: 'info' });
        return;
    }

    const ok = await confirmDialog({
      title: '批量生成描述',
      message: `发现 ${missingLinks.length} 个链接缺少描述，确定要使用 AI 自动生成吗？这可能需要一些时间。`,
      variant: 'info',
      confirmText: '开始生成',
    });
    if (!ok) return;

    setIsProcessing(true);
    shouldStopRef.current = false;
    setProgress({ current: 0, total: missingLinks.length });
    
    let currentLinks = [...links];

    for (let i = 0; i < missingLinks.length; i++) {
        if (shouldStopRef.current) break;

        const link = missingLinks[i];
        try {
            const desc = await generateLinkDescription(link.title, link.url, localConfig);
            currentLinks = currentLinks.map(l => l.id === link.id ? { ...l, description: desc } : l);
            onUpdateLinks(currentLinks);
            setProgress({ current: i + 1, total: missingLinks.length });
        } catch (e) {
            console.error(`Failed to generate for ${link.title}`, e);
        }
    }

    setIsProcessing(false);
  };

  const handleCopy = (text: string, key: string) => {
      navigator.clipboard.writeText(text);
      setCopiedStates(prev => ({ ...prev, [key]: true }));
      setTimeout(() => {
          setCopiedStates(prev => ({ ...prev, [key]: false }));
      }, 2000);
  };

  const handleLocalFaviconUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
          alertDialog({ message: '请上传图片文件', variant: 'warning' });
          e.target.value = '';
          return;
      }

      const reader = new FileReader();
      reader.onload = () => {
          if (typeof reader.result === 'string') {
              handleSiteChange('favicon', reader.result);
          }
      };
      reader.readAsDataURL(file);
      e.target.value = '';
  };

  const handleDownloadFile = (filename: string, content: string) => {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
  };

  const getManifestJson = () => {
    const navName = localSiteSettings.navTitle || "CloudNav";
    const json: any = {
        manifest_version: 3,
        name: navName + " Pro",
        version: "7.7",
        minimum_chrome_version: "116",
        description: `${navName} - 侧边栏 + 弹窗双模式收藏助手`,
        permissions: ["activeTab", "scripting", "sidePanel", "storage", "favicon", "contextMenus", "notifications", "tabs", "bookmarks"],
        host_permissions: [`${domain}/*`],
        background: {
            service_worker: "background.js"
        },
        action: {
            default_title: `打开 ${navName} 导航页`
        },
        side_panel: {
            default_path: "sidebar.html"
        },
        icons: {
            "128": "icon.png"
        },
        commands: {
          "_execute_action": {
            "suggested_key": {
              "default": "Ctrl+Shift+E",
              "mac": "Command+Shift+E"
            },
            "description": `打开 ${navName} 导航页`
          },
          "open_sidepanel": {
            "suggested_key": {
              "default": "Alt+Shift+E",
              "mac": "Option+Shift+E"
            },
            "description": `打开 ${navName} 侧边栏`
          }
        }
    };
    // 不设 default_popup：点图标时改由 background 在标签页里打开整屏导航页。
    // 弹窗形式受浏览器限制最大 800x600，没法铺满窗口。
    
    if (browserType === 'firefox') {
        json.browser_specific_settings = {
            gecko: {
                id: "cloudnav@example.com",
                strict_min_version: "109.0"
            }
        };
    }
    
    return JSON.stringify(json, null, 2);
  };

// 鉴权公共代码：密码不进扩展源码，运行时输入后存 chrome.storage，请求时注入请求头
const extAuthHelpers = `const AUTH_KEY = 'cloudnav_auth';

const getStoredAuth = async () => {
    const stored = await chrome.storage.local.get(AUTH_KEY);
    return stored[AUTH_KEY] || null;
};

const saveAuth = async (password) => {
    const auth = { password: password, issuedAt: Date.now() };
    await chrome.storage.local.set({ [AUTH_KEY]: auth });
    return auth;
};

const clearStoredAuth = async () => {
    await chrome.storage.local.remove(AUTH_KEY);
};

const authFetch = async (url, options) => {
    const auth = await getStoredAuth();
    if (!auth) {
        // 站点可能没设密码，先试一次不带凭证的请求，能过就直接放行
        const probe = await fetch(url, options);
        if (probe.status !== 401) return probe;
        const err = new Error('需要登录');
        err.needAuth = true;
        throw err;
    }
    const headers = Object.assign({}, (options && options.headers) || {}, {
        'x-auth-password': auth.password,
        'x-auth-issued-at': String(auth.issuedAt)
    });
    const res = await fetch(url, Object.assign({}, options, { headers: headers }));
    if (res.status === 401) {
        await clearStoredAuth();
        const err = new Error('需要登录');
        err.needAuth = true;
        throw err;
    }
    return res;
};

const verifyPassword = async (password) => {
    // 必须走 POST + authOnly：GET 是首页公开接口，不校验密码，
    // 用它验证会导致错误的密码也能通过，存下无效凭证后所有请求都会 401
    const res = await fetch(CONFIG.apiBase + '/api/storage', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-auth-password': password,
            'x-auth-issued-at': String(Date.now())
        },
        body: JSON.stringify({ authOnly: true })
    });
    if (!res.ok) return false;
    await saveAuth(password);
    return true;
};`;

const extBackgroundJs = `// background.js - ${localSiteSettings.navTitle || 'CloudNav'} Assistant v7.7
const CONFIG = {
  apiBase: "${domain}",
  siteName: "${(localSiteSettings.navTitle || 'CloudNav').replace(/"/g, '\\"')}"
};
${extAuthHelpers}
const MODE_KEY = 'cloudnav_ui_mode';
const NAV_PAGE_PATH = 'popup.html';

// 整屏导航页：已经开着就切过去，没开就在新标签页打开
const openNavPage = async () => {
    const url = chrome.runtime.getURL(NAV_PAGE_PATH);
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => tab && tab.url && tab.url.split('#')[0] === url);
    if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
        return;
    }
    await chrome.tabs.create({ url: url });
};

let linkCache = [];
let categoryCache = [];

async function getUiMode() {
    const data = await chrome.storage.local.get(MODE_KEY);
    return data[MODE_KEY] === 'sidepanel' ? 'sidepanel' : 'popup';
}

async function setUiMode(mode) {
    await chrome.storage.local.set({ [MODE_KEY]: mode });
    // 刻意不调用 setPopup：点图标统一由 onClicked 打开整屏导航页。
    // 侧边栏保持"不接管点击"，否则 onClicked 不会触发。
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  setUiMode('popup').catch(() => {});
  refreshCache().then(buildMenus);
});

chrome.runtime.onStartup?.addListener(() => {
    getUiMode().then((mode) => setUiMode(mode)).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cloudnav_data) {
        refreshCache().then(buildMenus);
    }
    if (area === 'local' && changes[MODE_KEY]) {
        setUiMode(changes[MODE_KEY].newValue === 'sidepanel' ? 'sidepanel' : 'popup').catch(() => {});
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'open-sidepanel') {
        const targetWindowId = message.windowId || sender.tab?.windowId;
        if (targetWindowId) {
            setUiMode('sidepanel').then(() => chrome.sidePanel.open({ windowId: targetWindowId })).then(() => {
                sendResponse({ ok: true });
            }).catch((error) => {
                console.error('Failed to open side panel', error);
                sendResponse({ ok: false });
            });
            return true;
        }
    }
    if (message?.type === 'switch-to-popup') {
        setUiMode('popup').then(() => {
            sendResponse({ ok: true });
        }).catch((error) => {
            console.error('Failed to switch to popup', error);
            sendResponse({ ok: false });
        });
        return true;
    }
    if (message?.type === 'get-bookmarks-preview') {
        collectBookmarks().then((data) => {
            sendResponse({ ok: true, folders: data.folders, links: data.links });
        }).catch((error) => {
            console.error('Failed to collect bookmarks', error);
            sendResponse({ ok: false, error: String((error && error.message) || error) });
        });
        return true;
    }
    if (message?.type === 'sync-bookmarks') {
        syncBookmarksToSite().then((result) => {
            sendResponse({ ok: true, result: result });
            notify('收藏夹已同步', '新增 ' + (result.added || 0) + ' 条，归位 ' + (result.moved || 0) + ' 条，删除 ' + (result.removed || 0) + ' 条');
            chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
        }).catch((error) => {
            console.error('Failed to sync bookmarks', error);
            sendResponse({ ok: false, error: String((error && error.message) || error) });
        });
        return true;
    }
    return false;
});

async function refreshCache() {
    const data = await chrome.storage.local.get('cloudnav_data');
    if (data && data.cloudnav_data) {
        linkCache = data.cloudnav_data.links || [];
        categoryCache = data.cloudnav_data.categories || [];
    }
    return;
}

const windowPorts = {};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cloudnav_sidebar') return;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'init' && msg.windowId) {
      windowPorts[msg.windowId] = port;
      port.onDisconnect.addListener(() => {
        if (windowPorts[msg.windowId] === port) {
          delete windowPorts[msg.windowId];
        }
      });
    }
  });
});

// 点插件图标：在标签页里打开整屏导航页（不再走受限的小弹窗）
chrome.action.onClicked.addListener(() => {
    openNavPage().catch((e) => console.error('Failed to open nav page', e));
});

chrome.commands.onCommand.addListener(async (command) => {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.windowId) return;
        if (command === 'open_sidepanel') {
            await chrome.sidePanel.open({ windowId: tab.windowId });
            return;
        }
        if (command === '_execute_action') {
            await openNavPage();
        }
    } catch (e) {
        console.error('Failed to handle command', e);
    }
});

function buildMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: "cloudnav_root",
            title: \`⚡ 保存到 \${CONFIG.siteName}\`,
            contexts: ["page", "link", "action"]
        });

        if (categoryCache.length > 0) {
            categoryCache.forEach(cat => {
                chrome.contextMenus.create({
                    id: \`save_to_\${cat.id}\`,
                    parentId: "cloudnav_root",
                    title: cat.name,
                    contexts: ["page", "link", "action"]
                });
            });
        } else {
            chrome.contextMenus.create({
                id: "save_to_common",
                parentId: "cloudnav_root",
                title: "默认分类",
                contexts: ["page", "link", "action"]
            });
        }
    });
}

function updateMenuTitle(url) {
    if (!url) return;
    const cleanUrl = url.replace(/\\/$/, '').toLowerCase();
    const exists = linkCache.some(l => l.url && l.url.replace(/\\/$/, '').toLowerCase() === cleanUrl);
    const newTitle = exists ? \`⚠️ 已存在 - 保存到 \${CONFIG.siteName}\` : \`⚡ 保存到 \${CONFIG.siteName}\`;
    chrome.contextMenus.update("cloudnav_root", { title: newTitle }, () => {
        if (chrome.runtime.lastError) { }
    });
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
   try {
       const tab = await chrome.tabs.get(activeInfo.tabId);
       if (tab && tab.url) updateMenuTitle(tab.url);
   } catch(e){}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
   if (changeInfo.status === 'complete' && tab.active && tab.url) {
       updateMenuTitle(tab.url);
   }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (String(info.menuItemId).startsWith("save_to_")) {
        const catId = String(info.menuItemId).replace("save_to_", "");
        const title = tab.title;
        const url = info.linkUrl || tab.url;
        const cleanUrl = url.replace(/\\/$/, '').toLowerCase();
        const exists = linkCache.some(l => l.url.replace(/\\/$/, '').toLowerCase() === cleanUrl);
        saveLink(title, url, catId);
    }
});

async function saveLink(title, url, categoryId, icon = '') {
    if (!(await getStoredAuth())) {
        notify('保存失败', '请先在弹窗或侧边栏用站点密码解锁。');
        return;
    }

    if (!icon) {
        try {
            const u = new URL(url);
            icon = \`https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=\${encodeURIComponent(u.origin)}&size=128\`;
        } catch(e){}
    }

    try {
        const domain = new URL(url).hostname;
        const iconRes = await authFetch(\`\${CONFIG.apiBase}/api/storage\`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                saveConfig: 'favicon',
                domain,
                icon
            })
        });

        if (iconRes.ok) {
            const iconData = await iconRes.json();
            icon = iconData.icon || icon;
        }
    } catch (e) {}

    try {
        const res = await authFetch(\`\${CONFIG.apiBase}/api/link\`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: title || '未命名',
                url: url,
                categoryId: categoryId,
                icon: icon
            })
        });

        if (res.ok) {
            notify('保存成功', \`已保存到 \${CONFIG.siteName}\`);
            chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
            const newLink = { id: Date.now().toString(), title, url, categoryId, icon };
            linkCache.unshift(newLink);
            updateMenuTitle(url);
        } else {
            notify('保存失败', \`服务器错误: \${res.status}\`);
        }
    } catch (e) {
        notify('保存失败', '网络请求错误');
    }
}

// --- 浏览器收藏夹遍历（只读，不写入任何数据）---
const BM_SKIP_PREFIXES = [
    'chrome:', 'edge:', 'microsoft-edge:', 'read:', 'edge-extension:',
    'about:', 'javascript:', 'place:', 'data:', 'view-source:',
    'msteams:', 'ms-excel:', 'ms-word:', 'ms-powerpoint:',
    'chrome-extension:', 'moz-extension:'
];

function isSkippedBookmarkUrl(url) {
    if (!url) return true;
    const lower = String(url).toLowerCase();
    for (const prefix of BM_SKIP_PREFIXES) {
        if (lower.indexOf(prefix) === 0) return true;
    }
    return false;
}

function walkBookmarkNodes(nodes, parentId, folders, links, depth) {
    for (const node of nodes) {
        if (node.url) {
            if (isSkippedBookmarkUrl(node.url)) continue;
            links.push({
                id: 'bm_' + node.id,
                title: node.title || node.url,
                url: node.url,
                folderId: parentId,
                dateAdded: node.dateAdded || 0
            });
        } else if (node.children) {
            const isRoot = node.id === '0';
            const folderId = isRoot ? '' : ('bm_' + node.id);
            if (!isRoot) {
                folders.push({
                    id: folderId,
                    title: node.title || '未命名文件夹',
                    parentId: parentId,
                    depth: depth
                });
            }
            walkBookmarkNodes(node.children, folderId, folders, links, depth + 1);
        }
    }
}

async function collectBookmarks() {
    const tree = await chrome.bookmarks.getTree();
    const folders = [];
    const links = [];
    walkBookmarkNodes(tree, '', folders, links, 0);
    return { folders: folders, links: links };
}

async function syncBookmarksToSite() {
    const data = await collectBookmarks();

    const res = await authFetch(\`\${CONFIG.apiBase}/api/bookmarks/sync\`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ folders: data.folders, links: data.links })
    });

    if (!res.ok) {
        let detail = '';
        try {
            detail = await res.text();
        } catch (e) {}
        throw new Error('服务器返回 ' + res.status + (detail ? (' - ' + detail) : ''));
    }

    return await res.json();
}

function notify(title, message) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: title,
        message: message,
        priority: 1
    });
}
`;

  const extSidebarHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        :root {
            --bg: #f8f9fd;
            --text: #14172b;
            --border: #e5e8f2;
            --hover: #eef1f8;
            --accent: #4257e6;
            --muted: #626b85;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #12141d;
                --text: #eef0f7;
                --border: #2a2f40;
                --hover: #1c2030;
                --accent: #92a6ff;
                --muted: #9aa3b8;
            }
        }
        html, body { width: 100%; min-width: 0; max-width: 100%; overflow-x: hidden; }
        * { box-sizing: border-box; min-width: 0; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding-bottom: 20px; }
        
        .header { position: sticky; top: 0; padding: 10px 12px; background: var(--bg); border-bottom: 1px solid var(--border); z-index: 10; display: flex; gap: 8px; min-width: 0; }
        .search-input { flex: 1; min-width: 0; width: 0; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--hover); color: var(--text); outline: none; font-size: 13px; }
        .search-input:focus { border-color: var(--accent); }
        
        .refresh-btn { width: 30px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); background: var(--hover); border-radius: 6px; color: var(--muted); cursor: pointer; transition: all 0.2s; }
        .refresh-btn:hover { color: var(--accent); border-color: var(--accent); }
        .refresh-btn:active { transform: scale(0.95); }
        .rotating { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }

        .content { padding: 4px; min-width: 0; }
        .cat-group { margin-bottom: 2px; }
        .cat-header { 
            padding: 8px 10px; font-size: 13px; font-weight: 600; color: var(--text); 
            cursor: pointer; display: flex; items-center; gap: 8px; border-radius: 6px;
            user-select: none; transition: background 0.1s;
        }
        .cat-header span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cat-header:hover { background: var(--hover); }
        .cat-arrow { width: 14px; height: 14px; color: var(--muted); transition: transform 0.2s; }
        .cat-header.active .cat-arrow { transform: rotate(90deg); color: var(--accent); }
        
        .cat-links { display: none; padding-left: 8px; margin-bottom: 8px; }
        .cat-header.active + .cat-links { display: block; }
        
        .link-item { display: flex; items-center; gap: 8px; padding: 6px 8px; border-radius: 6px; text-decoration: none; color: var(--text); transition: background 0.1s; border-left: 2px solid transparent; }
        .link-item:hover { background: var(--hover); border-left-color: var(--accent); }
        .link-icon { width: 16px; height: 16px; flex-shrink: 0; display: flex; items-center; justify-content: center; overflow: hidden; }
        .link-icon img { width: 100%; height: 100%; object-fit: contain; }
        .link-info { min-width: 0; flex: 1; }
        .link-title { font-size: 13px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
        
        .empty { text-align: center; padding: 20px; color: var(--muted); font-size: 12px; }
        .loading { display: flex; justify-content: center; padding: 40px; color: var(--accent); font-size: 12px; }
    </style>
</head>
<body>
    <div class="header">
        <input type="text" id="search" class="search-input" placeholder="搜索..." autocomplete="off">
        <button id="switchPopup" class="refresh-btn" title="切到小窗">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
        <button id="refresh" class="refresh-btn" title="同步最新数据">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
    </div>
    <div id="content" class="content">
        <div class="loading">初始化...</div>
    </div>
    <script src="sidebar.js"></script>
</body>
</html>`;

const extSidebarJs = `const CONFIG = {
  apiBase: "${domain}"
};
${extAuthHelpers}
const CACHE_KEY = 'cloudnav_data';

let port = null;
try {
    port = chrome.runtime.connect({ name: 'cloudnav_sidebar' });
    chrome.windows.getCurrent((win) => {
        if (win && port) {
            port.postMessage({ type: 'init', windowId: win.id });
        }
    });

    port.onMessage.addListener((msg) => {
        if (msg.action === 'close_panel') {
            window.close();
        }
    });
} catch(e) {
    console.error('Connection failed', e);
}

document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('content');
    const searchInput = document.getElementById('search');
    const refreshBtn = document.getElementById('refresh');
    const switchPopupBtn = document.getElementById('switchPopup');
    
    let allLinks = [];
    let allCategories = [];
    let expandedCats = new Set(); 

    const getArrowIcon = () => {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cat-arrow"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    };

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const getFaviconUrl = (pageUrl) => {
        try {
            const url = new URL(chrome.runtime.getURL("/_favicon/"));
            url.searchParams.set("pageUrl", pageUrl);
            url.searchParams.set("size", "32");
            return url.toString();
        } catch (e) {
            return '';
        }
    };

    const toggleCat = (id) => {
        const header = document.querySelector(\`.cat-header[data-id="\${id}"]\`);
        if (header) {
            header.classList.toggle('active');
            if (header.classList.contains('active')) {
                expandedCats.add(id);
            } else {
                expandedCats.delete(id);
            }
        }
    };

    container.addEventListener('click', (e) => {
        const header = e.target.closest('.cat-header');
        if (header) {
            toggleCat(header.dataset.id);
        }
    });

    const render = (filter = '') => {
        const q = filter.toLowerCase();
        let html = '';
        let hasContent = false;
        
        const isSearching = q.length > 0;

        allCategories.forEach(cat => {
            const catLinks = allLinks.filter(l => {
                const inCat = l.categoryId === cat.id;
                if (!inCat) return false;
                if (!q) return true;
                return l.title.toLowerCase().includes(q) || 
                       l.url.toLowerCase().includes(q) || 
                       (l.description && l.description.toLowerCase().includes(q));
            });

            if (catLinks.length === 0) return;
            hasContent = true;

            const isOpen = expandedCats.has(cat.id) || isSearching;
            const activeClass = isOpen ? 'active' : '';

            html += \`
            <div class="cat-group">
                <div class="cat-header \${activeClass}" data-id="\${cat.id}">
                    \${getArrowIcon()}
                    <span>\${cat.name}</span>
                </div>
                <div class="cat-links">
            \`;
            
            catLinks.forEach(link => {
                const iconSrc = getFaviconUrl(link.url);
                html += \`
                    <a href="\${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="link-item">
                        <div class="link-icon"><img src="\${escapeHtml(iconSrc)}" /></div>
                        <div class="link-info">
                            <div class="link-title">\${escapeHtml(link.title)}</div>
                        </div>
                    </a>
                \`;
            });

            html += \`</div></div>\`;
        });

        if (!hasContent) {
            container.innerHTML = filter ? '<div class="empty">无搜索结果</div>' : '<div class="empty">暂无数据</div>';
        } else {
            container.innerHTML = html;
        }
    };

    const showLogin = (errorMessage) => {
        const tip = errorMessage
            ? '<div style="color:#ef4444;font-size:12px;margin-top:8px">' + escapeHtml(errorMessage) + '</div>'
            : '';
        container.innerHTML = \`
            <div class="empty" style="padding:24px 16px">
                <div style="font-size:14px;font-weight:600;margin-bottom:6px">需要站点密码</div>
                <div style="font-size:12px;opacity:0.7;margin-bottom:14px">密码只存本机，不写进扩展文件</div>
                <input id="pwdInput" type="password" placeholder="输入站点密码" autocomplete="off"
                    style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.35);background:transparent;color:inherit;font-size:13px;outline:none">
                <button id="loginBtn" class="chip" style="margin-top:10px;width:100%;text-align:center;justify-content:center;color:white;background:var(--accent);border-color:transparent">
                    解锁
                </button>
                \${tip}
            </div>
        \`;
        const input = document.getElementById('pwdInput');
        const btn = document.getElementById('loginBtn');
        input?.focus();
        const submit = async () => {
            const value = input ? input.value.trim() : '';
            if (!value) return;
            btn.disabled = true;
            btn.textContent = '验证中...';
            if (!(await verifyPassword(value))) {
                showLogin('密码不正确');
                return;
            }
            loadData(true);
        };
        btn?.addEventListener('click', submit);
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') submit();
        });
    };

    const loadData = async (forceRefresh = false) => {
        try {
            if (!forceRefresh) {
                const cached = await chrome.storage.local.get(CACHE_KEY);
                if (cached[CACHE_KEY]) {
                    const data = cached[CACHE_KEY];
                    allLinks = data.links || [];
                    allCategories = data.categories || [];
                    render(searchInput.value);
                    return;
                }
            }

            refreshBtn.classList.add('rotating');
            container.innerHTML = '<div class="loading">同步数据中...</div>';

            const res = await authFetch(\`\${CONFIG.apiBase}/api/storage\`);
            
            const data = await res.json();
            allLinks = data.links || [];
            allCategories = data.categories || [];
            
            await chrome.storage.local.set({ [CACHE_KEY]: data });
            
            render(searchInput.value);
        } catch (e) {
            if (e && e.needAuth) {
                showLogin('');
            } else {
                container.innerHTML = \`<div class="empty" style="color:#ef4444">加载失败: \${escapeHtml(e.message)}<br>请点击右上角刷新</div>\`;
            }
        } finally {
            refreshBtn.classList.remove('rotating');
        }
    };

    loadData();

    searchInput.addEventListener('input', (e) => render(e.target.value));
    refreshBtn.addEventListener('click', () => loadData(true));
    switchPopupBtn?.addEventListener('click', async () => {
        try {
            await chrome.runtime.sendMessage({ type: 'switch-to-popup' });
            window.close();
        } catch (e) {
            console.error('Switch to popup failed', e);
        }
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'refresh') {
            loadData(true);
        }
    });
});`;

const extPopupHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="theme-color" content="#f8f9fd">
    <style>
        /* 主题令牌：默认靛蓝雾，其余主题用 html[data-theme] 覆盖（浅色系） */
        :root, html[data-theme="indigo"] {
            --ink: #14172b; --ink-soft: #626b85;
            --line: rgba(20,23,43,0.10); --line-strong: rgba(20,23,43,0.18);
            --surface: rgba(255,255,255,0.76); --surface-solid: rgba(255,255,255,0.95);
            --chip: rgba(255,255,255,0.55); --chip-hi: rgba(255,255,255,0.78);
            --solid: #14172b; --solid-ink: #ffffff;
            --accent: #4257e6; --accent-2: #8aa0ff; --accent-soft: rgba(66,87,230,0.12);
            --bg-1: #e9ecff; --bg-1e: rgba(233,236,255,0);
            --bg-2: #e8f3ff; --bg-2e: rgba(232,243,255,0);
            --bg-3: #f8f9fd; --bg-4: #eef1f8;
        }
        html[data-theme="graphite"] {
            --ink: #18181b; --ink-soft: #71717a;
            --line: rgba(24,24,27,0.10); --line-strong: rgba(24,24,27,0.18);
            --surface: rgba(255,255,255,0.78); --surface-solid: rgba(255,255,255,0.95);
            --chip: rgba(255,255,255,0.70); --chip-hi: rgba(255,255,255,0.90);
            --solid: #18181b; --solid-ink: #ffffff;
            --accent: #1f6feb; --accent-2: #4f9bfd; --accent-soft: rgba(31,111,235,0.12);
            --bg-1: #f0f2f6; --bg-1e: rgba(240,242,246,0);
            --bg-2: #f6f6f8; --bg-2e: rgba(246,246,248,0);
            --bg-3: #f7f7f8; --bg-4: #ececef;
        }
        html[data-theme="aurora"] {
            --ink: #0f1d1b; --ink-soft: #5c716e;
            --line: rgba(15,29,27,0.10); --line-strong: rgba(15,29,27,0.18);
            --surface: rgba(255,255,255,0.76); --surface-solid: rgba(255,255,255,0.95);
            --chip: rgba(255,255,255,0.60); --chip-hi: rgba(255,255,255,0.82);
            --solid: #0f1d1b; --solid-ink: #ffffff;
            --accent: #0f766e; --accent-2: #2dd4bf; --accent-soft: rgba(15,118,110,0.12);
            --bg-1: #e3f4f1; --bg-1e: rgba(227,244,241,0);
            --bg-2: #e6f6fb; --bg-2e: rgba(230,246,251,0);
            --bg-3: #f6faf9; --bg-4: #e8efee;
        }
        html[data-theme="sand"] {
            --ink: #2a231c; --ink-soft: #7a6a58;
            --line: rgba(42,35,28,0.10); --line-strong: rgba(42,35,28,0.18);
            --surface: rgba(255,255,255,0.78); --surface-solid: rgba(255,255,255,0.96);
            --chip: rgba(255,255,255,0.62); --chip-hi: rgba(255,255,255,0.84);
            --solid: #2a231c; --solid-ink: #fdfaf6;
            --accent: #c2410c; --accent-2: #f0955c; --accent-soft: rgba(194,65,12,0.12);
            --bg-1: #f7ead9; --bg-1e: rgba(247,234,217,0);
            --bg-2: #f3eee6; --bg-2e: rgba(243,238,230,0);
            --bg-3: #faf7f2; --bg-4: #f1ece3;
        }
        html[data-theme="ocean"] {
            --ink: #0d1b2a; --ink-soft: #5b7183;
            --line: rgba(13,27,42,0.10); --line-strong: rgba(13,27,42,0.18);
            --surface: rgba(255,255,255,0.78); --surface-solid: rgba(255,255,255,0.95);
            --chip: rgba(255,255,255,0.60); --chip-hi: rgba(255,255,255,0.82);
            --solid: #0d1b2a; --solid-ink: #ffffff;
            --accent: #0e7490; --accent-2: #38bdf8; --accent-soft: rgba(14,116,144,0.12);
            --bg-1: #dfeaf9; --bg-1e: rgba(223,234,249,0);
            --bg-2: #e3f0fb; --bg-2e: rgba(227,240,251,0);
            --bg-3: #f4f7fb; --bg-4: #e7edf6;
        }
        html[data-theme="violet"] {
            --ink: #17142b; --ink-soft: #6a6488;
            --line: rgba(23,20,43,0.10); --line-strong: rgba(23,20,43,0.18);
            --surface: rgba(255,255,255,0.78); --surface-solid: rgba(255,255,255,0.95);
            --chip: rgba(255,255,255,0.60); --chip-hi: rgba(255,255,255,0.82);
            --solid: #17142b; --solid-ink: #ffffff;
            --accent: #6d28d9; --accent-2: #a78bfa; --accent-soft: rgba(109,40,217,0.12);
            --bg-1: #ece9fb; --bg-1e: rgba(236,233,251,0);
            --bg-2: #eeeafc; --bg-2e: rgba(238,234,252,0);
            --bg-3: #f8f7fd; --bg-4: #eeecf7;
        }
        /* 磨砂玻璃：面板半透明 + 背景模糊，靠彩色环境光透出质感 */
        html[data-theme="glass"] {
            --ink: #12161f; --ink-soft: #5f6a7d;
            --line: rgba(255,255,255,0.60); --line-strong: rgba(255,255,255,0.85);
            --surface: rgba(255,255,255,0.45); --surface-solid: rgba(255,255,255,0.55);
            --chip: rgba(255,255,255,0.45); --chip-hi: rgba(255,255,255,0.68);
            --solid: rgba(18,22,31,0.82); --solid-ink: #ffffff;
            --accent: #2f6bd8; --accent-2: #6ea8ff; --accent-soft: rgba(47,107,216,0.14);
            --bg-1: #d6e4ff; --bg-1e: rgba(214,228,255,0);
            --bg-2: #ffe0ef; --bg-2e: rgba(255,224,239,0);
            --bg-3: #f5f8ff; --bg-4: #e8eefc;
        }
        html[data-theme="cyber"] {
            --ink: #170a24; --ink-soft: #6b5f86;
            --line: rgba(23,10,36,0.12); --line-strong: rgba(23,10,36,0.22);
            --surface: rgba(255,255,255,0.80); --surface-solid: rgba(255,255,255,0.95);
            --chip: rgba(255,255,255,0.66); --chip-hi: rgba(255,255,255,0.88);
            --solid: #170a24; --solid-ink: #f6f0ff;
            --accent: #a21caf; --accent-2: #06b6d4; --accent-soft: rgba(162,28,175,0.14);
            --bg-1: #f0e6ff; --bg-1e: rgba(240,230,255,0);
            --bg-2: #e2f7ff; --bg-2e: rgba(226,247,255,0);
            --bg-3: #f7f5fd; --bg-4: #eae6f6;
        }
        :root { --danger: #b42318; --danger-soft: rgba(180,35,24,0.09); }
        * { box-sizing: border-box; }
        html, body { margin: 0; width: 100%; height: 100%; color: var(--ink);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased; }
        body { padding: 16px;
          background:
            radial-gradient(1100px 600px at 8% -12%, var(--bg-1) 0%, var(--bg-1e) 62%),
            radial-gradient(900px 520px at 94% -8%, var(--bg-2) 0%, var(--bg-2e) 58%),
            linear-gradient(180deg, var(--bg-3) 0%, var(--bg-4) 100%);
          background-attachment: fixed; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
          clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
        .shell { display: flex; gap: 14px; height: calc(100vh - 32px); max-width: 1520px; margin: 0 auto; }

        /* 左：插件目录（无底板，气泡平铺） */
        .dock { flex: 0 0 244px; width: 244px; display: flex; flex-direction: column; min-height: 0;
          padding: 4px 8px 4px 0; }
        .dock-brand { display: flex; align-items: center; gap: 9px; padding: 0 2px 12px; }
        .dock-mark { flex: 0 0 30px; width: 30px; height: 30px; border-radius: 9px; background: var(--solid); color: var(--solid-ink);
          display: inline-flex; align-items: center; justify-content: center; }
        .dock-title { font-size: 17px; font-weight: 600; letter-spacing: 0.01em;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dock-label { padding: 0 2px 8px; font-size: 11px; letter-spacing: 0.16em; color: var(--ink-soft); opacity: .8; }
        .dock-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 8px;
          align-content: flex-start; padding: 2px 2px 2px 0;
          scrollbar-width: thin; scrollbar-color: rgba(127,127,127,0.35) transparent; }
        .dock-list::-webkit-scrollbar { width: 8px; height: 8px; }
        .dock-list::-webkit-scrollbar-button { display: none; }
        .dock-list::-webkit-scrollbar-track { background: transparent; }
        .dock-list::-webkit-scrollbar-thumb { background: rgba(127,127,127,0.28); border: 2px solid transparent;
          background-clip: content-box; border-radius: 999px; }
        .dock-list:hover::-webkit-scrollbar-thumb { background: rgba(127,127,127,0.44); background-clip: content-box; }
        .dir-item { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 30px;
          padding: 0 11px; border: 1px solid var(--line); border-radius: 999px; background: var(--chip);
          color: var(--ink-soft); font-size: 12.5px; font-family: inherit; cursor: pointer; touch-action: manipulation;
          transition: background-color .14s, color .14s, border-color .14s; }
        .dir-item:hover { background: var(--surface-solid); color: var(--ink); border-color: var(--line-strong); }
        .dir-item.active { background: var(--solid); border-color: var(--solid); color: var(--solid-ink); font-weight: 500; }
        .dir-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dir-count { font-size: 11px; font-variant-numeric: tabular-nums; opacity: .65; }
        .dir-item.active .dir-count { opacity: .85; }
        .dock-foot { margin-top: 10px; padding: 10px 2px 0; border-top: 1px solid var(--line);
          font-size: 11px; color: var(--ink-soft); font-variant-numeric: tabular-nums; }

        /* 右：内容区 */
        .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
        .topbar { flex: 0 0 auto; display: flex; align-items: center; gap: 16px; padding: 2px 2px 14px; }
        .clock-wrap { display: flex; align-items: baseline; gap: 12px; flex: 0 0 auto; }
        .clock { font-size: 38px; font-weight: 300; line-height: 1;
          letter-spacing: -0.03em; color: var(--ink); font-variant-numeric: tabular-nums; }
        .date { font-size: 13px; color: var(--ink-soft); letter-spacing: 0.03em; white-space: nowrap; }
        .tools { flex: 0 0 auto; display: flex; gap: 2px; margin-left: 2px; }
        .tool-btn { width: 30px; height: 30px; border-radius: 9px; border: 1px solid transparent; background: transparent;
          color: var(--ink-soft); display: inline-flex; align-items: center; justify-content: center;
          cursor: pointer; touch-action: manipulation;
          transition: color .16s, background-color .16s, border-color .16s; }
        .tool-btn:hover { color: var(--ink); background: var(--chip-hi); border-color: var(--line); }
        .tool-btn:focus-visible, .app:focus-visible, .dir-item:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 2px; }
        .rotating { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .search-wrap { position: relative; flex: 1 1 auto; max-width: 440px; margin: 0 auto; }
        .search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--ink-soft);
          pointer-events: none; display: flex; }
        .search { width: 100%; height: 40px; border: 1px solid var(--line); background: var(--surface-solid);
          color: var(--ink); border-radius: 11px; padding: 0 104px 0 40px; outline: none; font-size: 13px;
          transition: border-color .16s, box-shadow .16s, background-color .16s; }
        .search::placeholder { color: var(--ink-soft); }
        .search:hover { border-color: var(--line-strong); }
        .search:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
        .engine-wrap { position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
          display: flex; align-items: center; padding-left: 6px; border-left: 1px solid var(--line); }
        .engine-select { appearance: none; -webkit-appearance: none; border: 0; background: transparent;
          color: var(--ink-soft); font-family: inherit; font-size: 12px; line-height: 1;
          padding: 6px 18px 6px 6px; border-radius: 7px; cursor: pointer; outline: none;
          transition: color .16s, background-color .16s; }
        .engine-select:hover { color: var(--ink); background: rgba(127,127,127,0.1); }
        .engine-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .engine-caret { position: absolute; right: 5px; display: flex; pointer-events: none; color: var(--ink-soft); }

        .panel { flex: 1; min-height: 0; overflow-y: auto; position: relative; overflow-anchor: none;
          padding: 16px 2px 8px; scrollbar-width: thin; scrollbar-color: rgba(127,127,127,0.32) transparent; }
        .panel::-webkit-scrollbar { width: 8px; }
        .panel::-webkit-scrollbar-button { display: none; }
        .panel::-webkit-scrollbar-track { background: transparent; }
        .panel::-webkit-scrollbar-thumb { background: rgba(127,127,127,0.26); border: 2px solid transparent;
          background-clip: content-box; border-radius: 999px; }
        .grid { position: relative; width: 100%; }
        .app { position: absolute; top: 0; left: 0; display: flex; flex-direction: column; align-items: center; gap: 6px;
          height: 84px; text-decoration: none; color: inherit; touch-action: manipulation;
          contain: layout style; }
        .app-icon { position: relative; width: 46px; height: 46px; border-radius: 12px; background: var(--surface-solid);
          display: flex; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--line);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 6px rgba(15,23,42,0.06);
          transition: transform .18s cubic-bezier(.22,.61,.36,1), box-shadow .18s, border-color .18s; }
        .app:hover .app-icon { transform: translateY(-2px); border-color: var(--line-strong);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 12px 24px -12px rgba(15,23,42,0.42); }
        .app-icon img { width: 26px; height: 26px; object-fit: contain; }
        .app-letter { display: none; position: absolute; inset: 0; align-items: center; justify-content: center;
          font-size: 17px; font-weight: 600; letter-spacing: 0.02em; }
        .app-icon.fb { background: linear-gradient(135deg, hsl(var(--h), 72%, 90%), hsl(var(--h), 60%, 80%));
          border-color: transparent; box-shadow: none; }
        .app-icon.fb .app-letter { display: flex; color: hsl(var(--h), 42%, 36%); }
        .app-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          font-size: 12px; color: var(--ink-soft); text-align: center; max-width: 100%; line-height: 1.3;
          overflow: hidden; }
        .app:hover .app-name { color: var(--ink); }
        .empty { text-align: center; color: var(--ink-soft); padding: 48px 12px; font-size: 13px; }
        .status { flex: 0 0 auto; font-size: 12px; color: var(--ink-soft); line-height: 1.5; }
        .status:empty { display: none; }
        .status:not(:empty) { padding: 8px 2px 0; }
        .status.error { color: var(--danger); }
        .btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px;
          border: 1px solid transparent; border-radius: 9px; background: var(--accent); color: #fff; font-size: 13px;
          font-family: inherit; font-weight: 500; cursor: pointer; touch-action: manipulation; }
        .btn:hover { filter: brightness(.96); }
        .btn:disabled { opacity: .6; cursor: default; }
        .daily { flex: 0 0 auto; padding: 10px 2px 2px; text-align: center; font-size: 12px;
          color: var(--ink-soft); line-height: 1.6; opacity: .85; }
        /* 跟随系统深色模式 */
        @media (prefers-color-scheme: dark) {
            :root, html[data-theme="indigo"] {
                --ink: #eef0f7; --ink-soft: #9aa3b8;
                --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.20);
                --surface: rgba(28,31,44,0.62); --surface-solid: rgba(35,39,53,0.94);
                --chip: rgba(255,255,255,0.05); --chip-hi: rgba(255,255,255,0.10);
                --solid: #eef0f7; --solid-ink: #14172b;
                --accent: #92a6ff; --accent-2: #b39dff; --accent-soft: rgba(146,166,255,0.18);
                --bg-1: #1f2545; --bg-1e: rgba(31,37,69,0);
                --bg-2: #17293c; --bg-2e: rgba(23,41,60,0);
                --bg-3: #12141d; --bg-4: #0b0d12;
            }
            html[data-theme="graphite"] {
                --ink: #f4f4f5; --ink-soft: #a1a1aa;
                --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.20);
                --surface: rgba(32,32,36,0.62); --surface-solid: rgba(39,39,45,0.94);
                --chip: rgba(255,255,255,0.05); --chip-hi: rgba(255,255,255,0.10);
                --solid: #f4f4f5; --solid-ink: #18181b;
                --accent: #6ea8fe; --accent-2: #9bc2ff; --accent-soft: rgba(110,168,254,0.18);
                --bg-1: #1e2026; --bg-1e: rgba(30,32,38,0);
                --bg-2: #191a1f; --bg-2e: rgba(25,26,31,0);
                --bg-3: #17171a; --bg-4: #101012;
            }
            html[data-theme="aurora"] {
                --ink: #e8f2f0; --ink-soft: #93a8a5;
                --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.20);
                --surface: rgba(22,32,31,0.62); --surface-solid: rgba(29,40,39,0.94);
                --chip: rgba(255,255,255,0.05); --chip-hi: rgba(255,255,255,0.10);
                --solid: #e8f2f0; --solid-ink: #0f1d1b;
                --accent: #5eead4; --accent-2: #38bdf8; --accent-soft: rgba(94,234,212,0.18);
                --bg-1: #12302c; --bg-1e: rgba(18,48,44,0);
                --bg-2: #0f2a30; --bg-2e: rgba(15,42,48,0);
                --bg-3: #0e1615; --bg-4: #080d0d;
            }
            html[data-theme="sand"] {
                --ink: #f3ece4; --ink-soft: #a89784;
                --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.20);
                --surface: rgba(38,32,27,0.64); --surface-solid: rgba(46,39,33,0.94);
                --chip: rgba(255,255,255,0.06); --chip-hi: rgba(255,255,255,0.12);
                --solid: #f3ece4; --solid-ink: #2a231c;
                --accent: #f0a678; --accent-2: #ffd0a3; --accent-soft: rgba(240,166,120,0.18);
                --bg-1: #2b1f16; --bg-1e: rgba(43,31,22,0);
                --bg-2: #241a13; --bg-2e: rgba(36,26,19,0);
                --bg-3: #191512; --bg-4: #100d0b;
            }
            html[data-theme="ocean"] {
                --ink: #e6f0f7; --ink-soft: #8fa6b8;
                --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.20);
                --surface: rgba(19,32,45,0.66); --surface-solid: rgba(26,41,56,0.94);
                --chip: rgba(255,255,255,0.05); --chip-hi: rgba(255,255,255,0.11);
                --solid: #e6f0f7; --solid-ink: #0d1b2a;
                --accent: #38bdf8; --accent-2: #67e8f9; --accent-soft: rgba(56,189,248,0.18);
                --bg-1: #10293b; --bg-1e: rgba(16,41,59,0);
                --bg-2: #0e2233; --bg-2e: rgba(14,34,51,0);
                --bg-3: #0b1622; --bg-4: #060d14;
            }
            html[data-theme="violet"] {
                --ink: #efeef7; --ink-soft: #a49fbc;
                --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.20);
                --surface: rgba(30,27,44,0.64); --surface-solid: rgba(37,34,54,0.94);
                --chip: rgba(255,255,255,0.05); --chip-hi: rgba(255,255,255,0.11);
                --solid: #efeef7; --solid-ink: #17142b;
                --accent: #b08cff; --accent-2: #d8b4fe; --accent-soft: rgba(176,140,255,0.18);
                --bg-1: #221a3a; --bg-1e: rgba(34,26,58,0);
                --bg-2: #1a1730; --bg-2e: rgba(26,23,48,0);
                --bg-3: #13111d; --bg-4: #0b0a12;
            }
            html[data-theme="glass"] {
                --ink: #eaf0f8; --ink-soft: #9fb0c6;
                --line: rgba(255,255,255,0.16); --line-strong: rgba(255,255,255,0.30);
                --surface: rgba(255,255,255,0.08); --surface-solid: rgba(255,255,255,0.12);
                --chip: rgba(255,255,255,0.07); --chip-hi: rgba(255,255,255,0.14);
                --solid: rgba(234,240,248,0.85); --solid-ink: #0b0f16;
                --accent: #8ab4ff; --accent-2: #b7e0ff; --accent-soft: rgba(138,180,255,0.20);
                --bg-1: #1b2b4d; --bg-1e: rgba(27,43,77,0);
                --bg-2: #3a1d38; --bg-2e: rgba(58,29,56,0);
                --bg-3: #0d1220; --bg-4: #070a12;
            }
            html[data-theme="cyber"] {
                --ink: #f2e9ff; --ink-soft: #a58fc4;
                --line: rgba(255,255,255,0.12); --line-strong: rgba(255,255,255,0.24);
                --surface: rgba(24,14,38,0.66); --surface-solid: rgba(32,19,50,0.94);
                --chip: rgba(255,255,255,0.06); --chip-hi: rgba(255,255,255,0.12);
                --solid: #f2e9ff; --solid-ink: #170a24;
                --accent: #ff3ecb; --accent-2: #22e3ff; --accent-soft: rgba(255,62,203,0.20);
                --bg-1: #2a0a3d; --bg-1e: rgba(42,10,61,0);
                --bg-2: #052b3d; --bg-2e: rgba(5,43,61,0);
                --bg-3: #0a0713; --bg-4: #05040a;
            }
            :root { --danger: #ff9c8b; --danger-soft: rgba(255,156,139,0.12); }
            .app-icon { box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 6px rgba(0,0,0,0.3); }
            .app:hover .app-icon { box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 12px 24px -12px rgba(0,0,0,0.7); }
            .app-icon.fb { background: linear-gradient(135deg, hsl(var(--h), 30%, 27%), hsl(var(--h), 34%, 37%)); }
            .app-icon.fb .app-letter { color: hsl(var(--h), 65%, 78%); }
        }
        /* 主题切换器 */
        .theme-wrap { position: relative; display: inline-flex; }
        .theme-menu { position: absolute; top: 34px; right: 0; z-index: 40; width: 176px; padding: 6px;
          border: 1px solid var(--line); border-radius: 12px; background: var(--surface-solid);
          box-shadow: 0 12px 28px -12px rgba(15,23,42,0.35); }
        .theme-menu[hidden] { display: none; }
        .theme-grid { display: grid; gap: 2px; }
        .theme-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px;
          border: 0; border-radius: 8px; background: transparent; color: var(--ink-soft);
          font-size: 12px; font-family: inherit; text-align: left; cursor: pointer;
          transition: background-color .14s, color .14s; }
        .theme-item:hover { background: var(--chip-hi); color: var(--ink); }
        .theme-item.active { color: var(--ink); font-weight: 500; background: var(--chip); }
        .theme-sw { flex: 0 0 14px; width: 14px; height: 14px; border-radius: 999px;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.10); }
        .theme-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* 磨砂玻璃：面板加背景模糊，让环境光透上来 */
        html[data-theme="glass"] .search,
        html[data-theme="glass"] .dir-item,
        html[data-theme="glass"] .app-icon,
        html[data-theme="glass"] .theme-menu {
            -webkit-backdrop-filter: blur(16px) saturate(160%);
            backdrop-filter: blur(16px) saturate(160%);
        }
        html[data-theme="glass"] .app-icon { box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 8px 20px -12px rgba(15,23,42,0.35); }
        html[data-theme="glass"] .app:hover .app-icon { box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 14px 26px -12px rgba(15,23,42,0.45); }
        /* 赛博朋克：霓虹描边与发光 */
        html[data-theme="cyber"] .dir-item.active { box-shadow: 0 0 14px var(--accent-soft); }
        html[data-theme="cyber"] .search:focus-visible { box-shadow: 0 0 0 4px var(--accent-soft), 0 0 12px var(--accent-soft); }
        html[data-theme="cyber"] .app:hover .app-icon { border-color: var(--accent);
          box-shadow: 0 0 0 1px var(--accent), 0 10px 22px -12px var(--accent); }

        @media (max-width: 860px) {
            /* 窄屏仍然保持内部滚动容器：虚拟滚动依赖固定高度的滚动区 */
            body { padding: 10px; height: 100vh; overflow: hidden; }
            .shell { flex-direction: column; height: calc(100vh - 20px); gap: 10px; }
            .dock { flex: 0 0 auto; width: auto; flex-direction: row; align-items: center;
              gap: 4px; padding: 0; overflow-x: auto; scrollbar-width: none; }
            .dock::-webkit-scrollbar { display: none; }
            .dock-brand, .dock-label, .dock-foot { display: none; }
            .dock-list { flex-wrap: nowrap; gap: 6px; overflow: visible; padding: 0; }
            .dir-item { height: 30px; flex: 0 0 auto; }
            .dir-count { display: none; }
            .topbar { flex-wrap: wrap; gap: 10px 12px; padding: 0 2px 10px; }
            .clock-wrap { gap: 8px; }
            .clock { font-size: 28px; }
            .search-wrap { order: 3; flex: 1 1 100%; max-width: none; margin: 0; }
            .tools { margin-left: auto; }
            .panel { padding-top: 12px; }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
            .rotating { animation: none; }
        }
    </style>
</head>
<body>
    <h1 class="sr-only">收藏夹导航</h1>
    <div class="shell">
        <aside class="dock" aria-label="插件目录">
            <div class="dock-brand">
                <span class="dock-mark" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/></svg>
                </span>
                <span class="dock-title">收藏夹</span>
            </div>
            <div class="dock-label">目录</div>
            <nav id="dirList" class="dock-list"></nav>
            <div class="dock-foot" id="dirFoot"></div>
        </aside>

        <section class="stage">
            <header class="topbar">
                <div class="clock-wrap">
                    <span class="clock" id="clockLine">--:--</span>
                    <span class="date" id="dateLine">—</span>
                </div>
                <div class="search-wrap">
                    <span class="search-icon" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    </span>
                    <input id="search" class="search" type="search" name="q" placeholder="搜索收藏夹，回车搜索网络…" autocomplete="off" aria-label="搜索收藏夹">
                    <span class="engine-wrap">
                        <select id="engineSelect" class="engine-select" aria-label="选择搜索引擎">
                            <option value="baidu">百度</option>
                            <option value="bing">必应</option>
                            <option value="google">Google</option>
                        </select>
                        <span class="engine-caret" aria-hidden="true">
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m6 9 6 6 6-6"/></svg>
                        </span>
                    </span>
                </div>
                <div class="tools">
                    <button id="openSidepanel" class="tool-btn" type="button" title="打开侧边栏" aria-label="打开侧边栏">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
                    </button>
                    <button id="refresh" class="tool-btn" type="button" title="重新读取浏览器收藏夹" aria-label="重新读取浏览器收藏夹">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                    </button>
                    <button id="syncToSite" class="tool-btn" type="button" title="把浏览器收藏夹同步到站点" aria-label="同步到站点">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/></svg>
                    </button>
                    <span class="theme-wrap">
                        <button id="themeBtn" class="tool-btn" type="button" title="主题配色" aria-label="主题配色"
                                aria-haspopup="true" aria-expanded="false">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.667h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
                        </button>
                        <div class="theme-menu" id="themeMenu" role="menu" aria-label="主题配色" hidden>
                            <div class="theme-grid" id="themeGrid"></div>
                        </div>
                    </span>
                    <button id="lock" class="tool-btn" type="button" title="锁定（清除本机保存的密码）" aria-label="锁定并清除本机密码">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    </button>
                </div>
            </header>

            <div id="statusBar" class="status" role="status" aria-live="polite"></div>
            <div class="panel">
                <div id="content" class="grid">
                    <div class="empty">读取收藏夹中…</div>
                </div>
            </div>
            <footer class="daily" id="daily"></footer>
        </section>
    </div>
    <script src="popup.js"></script>
</body>
</html>`;

const extPopupJs = `const CONFIG = {
  apiBase: "${domain}"
};
${extAuthHelpers}

document.addEventListener('DOMContentLoaded', async () => {
    const content = document.getElementById('content');
    const dirList = document.getElementById('dirList');
    const dirFoot = document.getElementById('dirFoot');
    const searchInput = document.getElementById('search');
    const refreshBtn = document.getElementById('refresh');
    const openSidepanelBtn = document.getElementById('openSidepanel');
    const syncBtn = document.getElementById('syncToSite');
    const statusBar = document.getElementById('statusBar');
    let bmSyncing = false;

    let allLinks = [];
    let allCategories = [];
    let activeCategory = 'all';
    let liveLoaded = false;
    // 收藏夹快照缓存：下次打开先用它出首屏，再拉最新数据
    const CACHE_KEY = 'cloudnav_bm_cache';
    let cachedJson = '';

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const getFaviconUrl = (link) => {
        if (link.icon) return link.icon;
        try {
            const url = new URL(chrome.runtime.getURL('/_favicon/'));
            url.searchParams.set('pageUrl', link.url);
            url.searchParams.set('size', '64');
            return url.toString();
        } catch (e) {
            return '';
        }
    };

    const getHostname = (rawUrl) => {
        try {
            return new URL(rawUrl).hostname.replace(/^www\\./, '');
        } catch (e) {
            return rawUrl;
        }
    };

    // 标签宽度交给 CSS 做省略号，完整标题挂在 a 标签的 title 上
    const shortName = (value) => String(value ?? '');

    const categoryList = () => allCategories.length > 0
        ? allCategories
        : Array.from(new Set(allLinks.map((link) => link.categoryId)))
            .filter(Boolean)
            .map((categoryId) => ({ id: categoryId, name: categoryId }));

    // 一次性统计各目录数量，避免每次渲染都为每个目录扫一遍全量收藏
    let countMap = new Map();
    const rebuildCounts = () => {
        countMap = new Map([['all', allLinks.length]]);
        allLinks.forEach((link) => {
            const id = link.categoryId || '';
            countMap.set(id, (countMap.get(id) || 0) + 1);
        });
    };

    const countOf = (id) => countMap.get(id) || (id === 'all' ? allLinks.length : 0);

    const categoryName = (id) => {
        if (id === 'all') return '全部';
        const found = categoryList().find((category) => category.id === id);
        return found ? found.name : id;
    };

    // 左栏：插件目录
    const renderDir = () => {
        const items = [{ id: 'all', name: '全部收藏' }, ...categoryList()];
        dirList.innerHTML = items.map((category) => \`
            <button class="dir-item \${activeCategory === category.id ? 'active' : ''}" type="button" data-id="\${escapeHtml(category.id)}">
                <span class="dir-name" title="\${escapeHtml(category.name)}">\${escapeHtml(category.name)}</span>
                <span class="dir-count">\${countOf(category.id)}</span>
            </button>
        \`).join('');
        dirFoot.textContent = \`\${allLinks.length} 个收藏 · \${categoryList().length} 个目录\`;
    };

    // 虚拟滚动：只把可视区那一屏磁贴放进 DOM，并且复用节点，滚动时只改内容与位置
    const panel = document.querySelector('.panel');
    const TILE_H = 84;
    const GAP_X = 14;
    const GAP_Y = 20;
    const OVERSCAN = 2;
    let viewList = [];
    let metrics = { cols: 1, cellW: 100, stepX: 114, stepY: TILE_H + GAP_Y };
    let panelH = 0;
    let contentTop = 0;
    let paintedFrom = -1;
    let paintedTo = -1;

    // 复用的磁贴节点：index -> 元素，滚出可视区的进空闲池，滚进来的直接改内容
    const tiles = new Map();
    const spareTiles = [];

    // 一次测量拿到所有几何量，滚动时不再读布局，避免每帧强制重排
    const measure = () => {
        const width = Math.max(1, panel.clientWidth - 4);
        const minW = width < 560 ? 76 : 88;
        const cols = Math.max(1, Math.floor((width + GAP_X) / (minW + GAP_X)));
        const cellW = (width - GAP_X * (cols - 1)) / cols;
        metrics = { cols: cols, cellW: cellW, stepX: cellW + GAP_X, stepY: TILE_H + GAP_Y };
        panelH = panel.clientHeight;
        contentTop = content.offsetTop;
        tiles.forEach((el, index) => { placeTile(el, index); });
    };

    const applyHeight = () => {
        const total = Math.ceil(viewList.length / metrics.cols);
        content.style.height = (total * metrics.stepY - GAP_Y) + 'px';
    };

    // 无 favicon 时按 URL 稳定散列出一个色相，用彩色字母磁贴兜底
    const hueCache = new WeakMap();
    const hueFor = (link) => {
        const cached = hueCache.get(link);
        if (cached !== undefined) return cached;
        const key = String(link.url || link.title || '');
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
        hueCache.set(link, h);
        return h;
    };

    const createTile = () => {
        const el = document.createElement('a');
        el.className = 'app';
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.innerHTML = '<div class="app-icon"><img alt="" width="36" height="36" loading="lazy" decoding="async"><span class="app-letter"></span></div><div class="app-name"></div>';
        return el;
    };

    const fillTile = (el, link) => {
        el.href = link.url;
        el.title = link.title;
        const icon = el.firstChild;
        const img = icon.firstChild;
        img.src = getFaviconUrl(link);
        img.style.display = '';
        icon.classList.remove('fb');
        icon.style.setProperty('--h', hueFor(link));
        icon.lastChild.textContent = (String(link.title || '').trim().charAt(0) || '?').toUpperCase();
        el.lastChild.textContent = shortName(link.title);
    };

    // 用 transform 定位，走合成层，比改 left/top 少一次布局
    const placeTile = (el, index) => {
        const col = index % metrics.cols;
        const row = (index - col) / metrics.cols;
        el.style.width = metrics.cellW + 'px';
        el.style.transform = 'translate3d(' + Math.round(col * metrics.stepX) + 'px,' + Math.round(row * metrics.stepY) + 'px,0)';
    };

    // 图标加载失败统一在这里兜底（error 不冒泡，用捕获）
    content.addEventListener('error', (event) => {
        const img = event.target;
        if (!img || img.tagName !== 'IMG') return;
        img.style.display = 'none';
        img.parentNode.classList.add('fb');
    }, true);

    const clearTiles = () => {
        tiles.clear();
        spareTiles.length = 0;
        paintedFrom = -1;
        paintedTo = -1;
        content.innerHTML = '';
    };

    const paintWindow = () => {
        if (!viewList.length) return;
        const top = Math.max(0, panel.scrollTop - contentTop);
        const firstRow = Math.max(0, Math.floor(top / metrics.stepY) - OVERSCAN);
        const lastRow = Math.ceil((top + panelH) / metrics.stepY) + OVERSCAN;
        const from = firstRow * metrics.cols;
        const to = Math.min(viewList.length, lastRow * metrics.cols);
        if (from === paintedFrom && to === paintedTo) return;

        // 滚出可视区的节点先收进空闲池
        const spare = [];
        tiles.forEach((el, index) => {
            if (index < from || index >= to) {
                spare.push(el);
                tiles.delete(index);
            }
        });

        let cursor = 0;
        for (let i = from; i < to; i++) {
            if (tiles.has(i)) continue;
            let el = cursor < spare.length ? spare[cursor++] : null;
            if (el) {
                fillTile(el, viewList[i]);
                placeTile(el, i);
            } else {
                el = spareTiles.pop() || createTile();
                fillTile(el, viewList[i]);
                placeTile(el, i);
                content.appendChild(el);
            }
            tiles.set(i, el);
        }
        // 多出来的空闲节点留着下次复用，不反复增删 DOM
        for (; cursor < spare.length; cursor++) {
            if (spareTiles.length < 40) spareTiles.push(spare[cursor]);
            else spare[cursor].remove();
        }
        paintedFrom = from;
        paintedTo = to;
    };

    const render = () => {
        const query = searchInput.value.trim().toLowerCase();
        const pool = activeCategory === 'all'
            ? allLinks
            : allLinks.filter((link) => link.categoryId === activeCategory);
        viewList = query
            ? pool.filter((link) => link.title.toLowerCase().includes(query) ||
                link.url.toLowerCase().includes(query))
            : pool;

        // 搜索时给个结果计数，避免“到底筛出来没有”的疑问
        if (query) {
            statusBar.textContent = '「' + searchInput.value.trim() + '」：' + viewList.length + ' 条结果';
        } else if (!statusBar.classList.contains('error')) {
            // 没有面包屑了，用状态栏说明当前所在目录
            statusBar.textContent = categoryName(activeCategory) + ' · ' + viewList.length + ' 个';
        }

        if (!viewList.length) {
            viewList = [];
            clearTiles();
            content.style.height = '';
            content.innerHTML = '<div class="empty">没有匹配的收藏，回车用搜索引擎搜一下</div>';
            return;
        }

        clearTiles();
        measure();
        applyHeight();
        paintWindow();
        // 切回标签时恢复原滚动位置；高度就位后再设置，避免被旧内容高度截断
        panel.scrollTop = scrollMemory[activeCategory] || 0;
    };

    let paintPending = false;
    panel.addEventListener('scroll', () => {
        if (paintPending) return;
        paintPending = true;
        window.requestAnimationFrame(() => {
            paintPending = false;
            paintWindow();
        });
    }, { passive: true });

    const remeasure = () => {
        if (!viewList.length) return;
        measure();
        applyHeight();
        paintWindow();
    };
    if (window.ResizeObserver) {
        new window.ResizeObserver(remeasure).observe(panel);
    } else {
        window.addEventListener('resize', remeasure);
    }

    // --- 时钟与日期 ---
    const dateLine = document.getElementById('dateLine');
    const clockLine = document.getElementById('clockLine');
    // 交给 Intl，避免手写「X月Y日 星期Z」这类硬编码格式
    const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const monthDayFmt = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
    const weekdayFmt = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });
    const tickClock = () => {
        const now = new Date();
        clockLine.textContent = timeFmt.format(now);
        dateLine.textContent = monthDayFmt.format(now) + ' ' + weekdayFmt.format(now);
    };
    tickClock();
    setInterval(tickClock, 15000);

    // --- 每日一句：本地按天轮换，不联网 ---
    const TIPS = [
        '今天的努力是为了明天的从容。',
        '把最重要的事先做完，剩下的都是赚到的。',
        '专注当下这一件事就够了。',
        '慢一点没关系，方向对就行。',
        '整理好了再出发，也是一种效率。',
        '让喜欢的事占据更多时间。',
        '先开始，再谈完美。',
        '休息也是计划的一部分。',
    ];
    document.getElementById('daily').textContent = TIPS[Math.floor(Date.now() / 86400000) % TIPS.length];

    // --- 搜索引擎 ---
    const ENGINES = {
        baidu: 'https://www.baidu.com/s?wd=',
        bing: 'https://www.bing.com/search?q=',
        google: 'https://www.google.com/search?q=',
    };
    let activeEngine = 'baidu';
    const engineSelect = document.getElementById('engineSelect');
    engineSelect.addEventListener('change', () => {
        activeEngine = ENGINES[engineSelect.value] ? engineSelect.value : 'baidu';
    });

    let searchTimer = 0;
    searchInput.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(render, 120);
    });
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && searchInput.value) {
            searchInput.value = '';
            render();
            return;
        }
        if (event.key !== 'Enter') return;
        const query = searchInput.value.trim();
        if (!query) return;
        // 输入框会实时筛出本地收藏，回车则是用搜索引擎搜网络
        window.open(ENGINES[activeEngine] + encodeURIComponent(query), '_blank');
    });

    // 全局按「/」聚焦搜索框（输入控件内不拦截）
    document.addEventListener('keydown', (event) => {
        if (event.key !== '/' || event.defaultPrevented) return;
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' || target.isContentEditable)) return;
        event.preventDefault();
        searchInput.focus();
    });

    // --- 主题配色：八套主题，选择后写入 chrome.storage.local ---
    const THEMES = [
        { id: 'indigo', name: '靛蓝雾', a: '#4257e6', b: '#8aa0ff' },
        { id: 'graphite', name: '石墨', a: '#1f6feb', b: '#9bc2ff' },
        { id: 'aurora', name: '极光青', a: '#0f766e', b: '#5eead4' },
        { id: 'sand', name: '暖砂', a: '#c2410c', b: '#f0a678' },
        { id: 'ocean', name: '午夜蓝', a: '#0e7490', b: '#38bdf8' },
        { id: 'violet', name: '紫霞', a: '#6d28d9', b: '#b08cff' },
        { id: 'glass', name: '磨砂玻璃', a: '#d6e4ff', b: '#ffe0ef' },
        { id: 'cyber', name: '赛博朋克', a: '#a21caf', b: '#22e3ff' }
    ];
    const THEME_KEY = 'cloudnav_ext_theme';
    const themeBtn = document.getElementById('themeBtn');
    const themeMenu = document.getElementById('themeMenu');
    const themeGrid = document.getElementById('themeGrid');
    let currentTheme = 'indigo';

    const paintThemeMenu = () => {
        themeGrid.innerHTML = THEMES.map((theme) =>
            '<button class="theme-item' + (theme.id === currentTheme ? ' active' : '') + '" type="button"'
            + ' role="menuitemradio" aria-checked="' + (theme.id === currentTheme) + '" data-theme="' + theme.id + '">'
            + '<span class="theme-sw" style="background:linear-gradient(135deg,' + theme.a + ',' + theme.b + ')"></span>'
            + '<span class="theme-name">' + theme.name + '</span></button>'
        ).join('');
    };
    const setTheme = (id) => {
        currentTheme = THEMES.some((theme) => theme.id === id) ? id : 'indigo';
        document.documentElement.setAttribute('data-theme', currentTheme);
        if (themeGrid) paintThemeMenu();
    };
    const closeThemeMenu = () => {
        if (!themeMenu || themeMenu.hidden) return;
        themeMenu.hidden = true;
        themeBtn.setAttribute('aria-expanded', 'false');
    };
    setTheme('indigo');
    chrome.storage.local.get(THEME_KEY).then((data) => {
        if (data && data[THEME_KEY]) setTheme(data[THEME_KEY]);
    }).catch(() => {});
    themeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = themeMenu.hidden;
        themeMenu.hidden = !willOpen;
        themeBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    themeGrid.addEventListener('click', (event) => {
        const item = event.target.closest('.theme-item');
        if (!item) return;
        setTheme(item.dataset.theme);
        chrome.storage.local.set({ [THEME_KEY]: item.dataset.theme }).catch(() => {});
        closeThemeMenu();
    });
    document.addEventListener('click', (event) => {
        if (!themeMenu.hidden && !event.target.closest('.theme-wrap')) closeThemeMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeThemeMenu();
    });

    // --- 锁定：清除本机保存的密码 ---
    document.getElementById('lock')?.addEventListener('click', async () => {
        await clearStoredAuth();
        showLogin('已锁定，请输入站点密码');
    });

    const scrollMemory = {};

    const selectCategory = (id) => {
        scrollMemory[activeCategory] = panel.scrollTop;
        activeCategory = id;
        renderDir();
        render();
    };

    dirList.addEventListener('click', (event) => {
        const item = event.target.closest('.dir-item');
        if (!item) return;
        selectCategory(item.dataset.id || 'all');
    });


    openSidepanelBtn?.addEventListener('click', async () => {
        try {
            const currentWindow = await chrome.windows.getCurrent();
            await chrome.runtime.sendMessage({ type: 'open-sidepanel', windowId: currentWindow.id });
            // 这里是整屏标签页，打开侧边栏后不关掉自己
        } catch (e) {
            console.error('Open side panel failed', e);
        }
    });

    const showLogin = (errorMessage, onSuccess) => {
        const tip = errorMessage
            ? '<div style="color:#ef4444;font-size:12px;margin-top:8px">' + escapeHtml(errorMessage) + '</div>'
            : '';
        content.innerHTML = \`
            <div class="empty" style="padding:24px 16px">
                <div style="font-size:14px;font-weight:600;margin-bottom:6px">需要站点密码</div>
                <div style="font-size:12px;opacity:0.7;margin-bottom:14px">密码只存本机，不写进扩展文件</div>
                <input id="pwdInput" type="password" placeholder="输入站点密码" autocomplete="off"
                    style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.35);background:transparent;color:inherit;font-size:13px;outline:none">
                <button id="loginBtn" class="btn" style="margin-top:10px;width:100%">
                    解锁
                </button>
                \${tip}
            </div>
        \`;
        content.style.height = '';
        const input = document.getElementById('pwdInput');
        const btn = document.getElementById('loginBtn');
        input?.focus();
        const submit = async () => {
            const value = input ? input.value.trim() : '';
            if (!value) return;
            btn.disabled = true;
            btn.textContent = '验证中…';
            if (!(await verifyPassword(value))) {
                showLogin('密码不正确', onSuccess);
                return;
            }
            // 解锁后接着做被打断的事（比如同步），没指定就刷新收藏夹
            if (onSuccess) onSuccess();
            else loadBookmarks();
        };
        btn?.addEventListener('click', submit);
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') submit();
        });
    };

    const applyData = (folders, links) => {
        allCategories = folders;
        allLinks = links;
        rebuildCounts();
        if (activeCategory !== 'all' && !categoryList().some((category) => category.id === activeCategory)) {
            activeCategory = 'all';
        }
        renderDir();
        render();
    };

    // 先用上次的快照铺满首屏，避免每次打开都白屏等消息往返
    const readCache = async () => {
        try {
            const stored = await chrome.storage.local.get(CACHE_KEY);
            const cached = stored && stored[CACHE_KEY];
            if (liveLoaded) return;
            if (cached && Array.isArray(cached.links) && cached.links.length) {
                cachedJson = JSON.stringify(cached.links);
                applyData(cached.folders || [], cached.links);
            }
        } catch (e) {}
    };

    // 主数据源就是浏览器收藏夹，浏览时完全不连站点
    const loadBookmarks = async () => {
        try {
            refreshBtn.classList.add('rotating');
            const response = await chrome.runtime.sendMessage({ type: 'get-bookmarks-preview' });
            if (!response || !response.ok) {
                throw new Error((response && response.error) || '读取收藏夹失败');
            }
            // 收藏夹文件夹当分类、书签当链接，喂给现成的渲染逻辑
            const folders = (response.folders || []).map((folder) => ({ id: folder.id, name: folder.title }));
            const links = (response.links || []).map((link) => ({
                id: link.id,
                title: link.title,
                url: link.url,
                categoryId: link.folderId || ''
            }));
            // 数据没变化就不重绘、也不重写快照，省掉一次全量渲染和上百 KB 存储 IO
            const nextJson = JSON.stringify(links);
            if (nextJson === cachedJson && allLinks.length) {
                liveLoaded = true;
                return;
            }
            liveLoaded = true;
            applyData(folders, links);
            cachedJson = nextJson;
            try {
                chrome.storage.local.set({ [CACHE_KEY]: { folders: folders, links: links, savedAt: Date.now() } });
            } catch (e) {}
        } catch (e) {
            content.style.height = '';
            content.innerHTML = \`<div class="empty" style="color:#ef4444">读取收藏夹失败<br>\${escapeHtml(e.message)}</div>\`;
        } finally {
            refreshBtn.classList.remove('rotating');
        }
    };

    const setStatus = (text, isError) => {
        statusBar.textContent = text || '';
        statusBar.classList.toggle('error', !!isError);
    };

    // 只有这一步需要站点凭证，所以没解锁才会弹登录框
    const doSync = async () => {
        if (bmSyncing) return;
        bmSyncing = true;
        syncBtn.classList.add('rotating');
        setStatus('正在同步到站点…');
        try {
            const response = await chrome.runtime.sendMessage({ type: 'sync-bookmarks' });
            if (!response || !response.ok) {
                throw new Error((response && response.error) || '同步失败');
            }
            const result = response.result || {};
            setStatus('已同步：新增 ' + (result.added || 0) + ' · 归位 ' + (result.moved || 0) + ' · 删除 ' + (result.removed || 0));
            await loadBookmarks();
        } catch (e) {
            const message = String((e && e.message) || '同步失败');
            if (message.indexOf('需要登录') !== -1) {
                // 解锁后自动重试这一次同步
                showLogin('请先用站点密码解锁', doSync);
            } else {
                setStatus(message, true);
            }
        } finally {
            bmSyncing = false;
            syncBtn.classList.remove('rotating');
        }
    };

    syncBtn?.addEventListener('click', doSync);
    refreshBtn.addEventListener('click', () => loadBookmarks());

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'refresh') {
            loadBookmarks();
        }
    });

    loadBookmarks();
});`;

  const renderCodeBlock = (filename: string, code: string) => (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0">
        <div className="flex justify-between items-center bg-slate-50 dark:bg-slate-700/50 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
            <span className="text-xs font-mono font-medium text-slate-600 dark:text-slate-300">{filename}</span>
            <div className="flex items-center gap-2">
                <button 
                    onClick={() => handleDownloadFile(filename, code)}
                    className="text-xs flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                    title="下载文件"
                >
                    <Download size={12}/>
                    Download
                </button>
                <div className="w-px h-3 bg-slate-300 dark:bg-slate-600"></div>
                <button 
                    onClick={() => handleCopy(code, filename)}
                    className="text-xs flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                >
                    {copiedStates[filename] ? <Check size={12}/> : <Copy size={12}/>}
                    {copiedStates[filename] ? 'Copied' : 'Copy'}
                </button>
            </div>
        </div>
        <div className="bg-slate-900 p-3 overflow-x-auto">
            <pre className="text-[10px] md:text-xs font-mono text-slate-300 leading-relaxed whitespace-pre">
                {code}
            </pre>
        </div>
    </div>
  );

  // 纯本地绘制，不依赖外部图片与 CORS，保证一定能产出 128x128 图标
  const generateFallbackIconBlob = async (): Promise<Blob> => {
     const canvas = document.createElement('canvas');
     canvas.width = 128;
     canvas.height = 128;
     const ctx = canvas.getContext('2d');
     if (!ctx) throw new Error('Canvas error');

     const gradient = ctx.createLinearGradient(0, 0, 128, 128);
     gradient.addColorStop(0, '#60a5fa');
     gradient.addColorStop(1, '#2563eb');

     ctx.fillStyle = gradient;
     ctx.beginPath();
     ctx.moveTo(28, 0);
     ctx.lineTo(100, 0);
     ctx.quadraticCurveTo(128, 0, 128, 28);
     ctx.lineTo(128, 100);
     ctx.quadraticCurveTo(128, 128, 100, 128);
     ctx.lineTo(28, 128);
     ctx.quadraticCurveTo(0, 128, 0, 100);
     ctx.lineTo(0, 28);
     ctx.quadraticCurveTo(0, 0, 28, 0);
     ctx.closePath();
     ctx.fill();

     // 白色书签图形（lucide bookmark 放大 4 倍后居中）
     ctx.fillStyle = '#ffffff';
     ctx.beginPath();
     ctx.moveTo(92, 100);
     ctx.lineTo(64, 84);
     ctx.lineTo(36, 100);
     ctx.lineTo(36, 36);
     ctx.quadraticCurveTo(36, 28.8, 44, 28);
     ctx.lineTo(84, 28);
     ctx.quadraticCurveTo(92, 28.8, 92, 36);
     ctx.closePath();
     ctx.fill();

     return new Promise((resolve, reject) => {
         canvas.toBlob((blob) => {
             if (blob) resolve(blob);
             else reject(new Error('toBlob failed'));
         }, 'image/png');
     });
  };

  const generateIconBlob = async (): Promise<Blob> => {
     const iconUrl = localSiteSettings.favicon;

     if (iconUrl) {
         try {
             const img = new Image();
             img.crossOrigin = "anonymous";
             img.src = iconUrl;

             await new Promise((resolve, reject) => {
                 img.onload = resolve;
                 img.onerror = reject;
             });

             const canvas = document.createElement('canvas');
             canvas.width = 128;
             canvas.height = 128;
             const ctx = canvas.getContext('2d');
             if (ctx) {
                 ctx.drawImage(img, 0, 0, 128, 128);
                 const blob = await new Promise<Blob | null>((resolve) => {
                     canvas.toBlob((b) => resolve(b), 'image/png');
                 });
                 if (blob) return blob;
             }
         } catch (e) {
             console.warn('站点图标生成失败，改用内置默认图标', e);
         }
     }

     return generateFallbackIconBlob();
  };

  const handleDownloadIcon = async () => {
    const blob = await generateIconBlob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "icon.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const handleDownloadZip = async () => {
    setIsZipping(true);
    try {
        const zip = new JSZip();
        
        zip.file("manifest.json", getManifestJson());
        zip.file("background.js", extBackgroundJs);
        zip.file("sidebar.html", extSidebarHtml);
        zip.file("sidebar.js", extSidebarJs);
        zip.file("popup.html", extPopupHtml);
        zip.file("popup.js", extPopupJs);
        
        const iconBlob = await generateIconBlob();
        zip.file("icon.png", iconBlob);

        const content = await zip.generateAsync({ type: "blob" });
        const url = window.URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = "CloudNav-Ext.zip";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
    } catch(e) {
        console.error(e);
        alertDialog({ message: "打包下载失败", variant: 'danger', title: '下载失败' });
    } finally {
        setIsZipping(false);
    }
  };

  // --- 死链检测逻辑 ---
  const buildCheckHeaders = () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['x-auth-password'] = authToken;
    if (authIssuedAt) headers['x-auth-issued-at'] = authIssuedAt;
    return headers;
  };

  const runLinkCheck = async (startFrom = 0) => {
    linkCheckAbortRef.current = false;
    linkCheckPauseRef.current = false;
    setLinkCheckStatus('running');

    const allLinks = links;
    const total = allLinks.length;
    setLinkCheckProgress({ current: startFrom, total });

    for (let i = startFrom; i < total; i++) {
      // 取消检测
      if (linkCheckAbortRef.current) break;

      // 暂停检测
      while (linkCheckPauseRef.current && !linkCheckAbortRef.current) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (linkCheckAbortRef.current) break;

      const link = allLinks[i];
      let url = link.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
      setCurrentCheckingUrl(url);
      setLinkCheckProgress({ current: i + 1, total });

      try {
        const res = await fetch('/api/linkcheck', {
          method: 'POST',
          headers: buildCheckHeaders(),
          body: JSON.stringify({ url }),
        });
        const data = await res.json();

        const result: LinkCheckResult = {
          linkId: link.id,
          url,
          title: link.title,
          alive: data.alive,
          status: data.status,
          archiveUrl: data.archiveUrl || null,
          error: data.error,
        };

        setLinkCheckResults(prev => [...prev, result]);
      } catch {
        setLinkCheckResults(prev => [...prev, {
          linkId: link.id,
          url,
          title: link.title,
          alive: false,
          status: 0,
          archiveUrl: null,
          error: 'Network error',
        }]);
      }

      // 请求间隔，避免过快
      await new Promise(r => setTimeout(r, 300));
    }

    if (!linkCheckAbortRef.current) {
      setLinkCheckStatus('done');
    }
    setCurrentCheckingUrl('');
  };

  const handleStartLinkCheck = () => {
    setLinkCheckResults([]);
    runLinkCheck(0);
  };

  const handlePauseLinkCheck = () => {
    linkCheckPauseRef.current = true;
    setLinkCheckStatus('paused');
  };

  const handleResumeLinkCheck = () => {
    linkCheckPauseRef.current = false;
    setLinkCheckStatus('running');
  };

  const handleCancelLinkCheck = () => {
    linkCheckAbortRef.current = true;
    linkCheckPauseRef.current = false;
    setLinkCheckStatus('done');
    setCurrentCheckingUrl('');
  };

  const handleUpdateToArchive = (result: LinkCheckResult) => {
    if (!result.archiveUrl) return;
    const updatedLinks = links.map(l =>
      l.id === result.linkId ? { ...l, url: result.archiveUrl } : l
    );
    onUpdateLinks(updatedLinks);
    setLinkCheckResults(prev => prev.filter(r => r.linkId !== result.linkId));
  };

  const handleDeleteDeadLink = (result: LinkCheckResult) => {
    const updatedLinks = links.filter(l => l.id !== result.linkId);
    onUpdateLinks(updatedLinks);
    setLinkCheckResults(prev => prev.filter(r => r.linkId !== result.linkId));
  };

  const handleBatchUpdateArchive = async () => {
    const withArchive = linkCheckResults.filter(r => !r.alive && r.archiveUrl);
    if (withArchive.length === 0) return;
    const confirmed = await confirmDialog({
      title: '批量更新归档链接',
      message: `将 ${withArchive.length} 个死链更新为 Wayback Machine 归档版本？`,
      confirmText: '确认更新',
      variant: 'warning'
    });
    if (!confirmed) return;
    let updatedLinks = [...links];
    withArchive.forEach(r => {
      updatedLinks = updatedLinks.map(l =>
        l.id === r.linkId ? { ...l, url: r.archiveUrl! } : l
      );
    });
    onUpdateLinks(updatedLinks);
    setLinkCheckResults(prev => prev.filter(r => r.alive || !r.archiveUrl));
  };

  const handleBatchDeleteDead = async () => {
    const deadResults = linkCheckResults.filter(r => !r.alive);
    if (deadResults.length === 0) return;
    const confirmed = await confirmDialog({
      title: '批量删除死链',
      message: `确定删除 ${deadResults.length} 个死链？此操作不可撤销。`,
      confirmText: '确认删除',
      variant: 'danger'
    });
    if (!confirmed) return;
    const deadIds = new Set(deadResults.map(r => r.linkId));
    const updatedLinks = links.filter(l => !deadIds.has(l.id));
    onUpdateLinks(updatedLinks);
    setLinkCheckResults(prev => prev.filter(r => r.alive));
  };

  // --- 重复书签检测逻辑 ---
  const normalizeUrlForDedup = (rawUrl: string): string => {
    let u = rawUrl.trim().replace(/\/+$/, '');
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
    try {
      const urlObj = new URL(u);
      urlObj.hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
      return urlObj.toString().replace(/\/+$/, '');
    } catch {
      return u.toLowerCase();
    }
  };

  const handleScanDuplicates = () => {
    const urlMap = new Map<string, LinkItem[]>();
    links.forEach(link => {
      const normalized = normalizeUrlForDedup(link.url);
      const existing = urlMap.get(normalized) || [];
      existing.push(link);
      urlMap.set(normalized, existing);
    });
    const groups: DuplicateGroup[] = [];
    urlMap.forEach((groupLinks, normalizedUrl) => {
      if (groupLinks.length > 1) {
        // 按创建时间排序，最早的在前
        groupLinks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        groups.push({ normalizedUrl, links: groupLinks });
      }
    });
    setDuplicateGroups(groups);
    setHasScannedDuplicates(true);
  };

  const handleAutoCleanDuplicates = async () => {
    if (duplicateGroups.length === 0) return;
    const totalToRemove = duplicateGroups.reduce((sum, g) => sum + (g.links.length - 1), 0);
    const confirmed = await confirmDialog({
      title: '自动清理重复链接',
      message: `发现 ${duplicateGroups.length} 组重复，将保留每组最早的一个，删除其余 ${totalToRemove} 个。确认？`,
      confirmText: '确认清理',
      variant: 'warning'
    });
    if (!confirmed) return;
    const idsToRemove = new Set<string>();
    duplicateGroups.forEach(group => {
      // 保留第一个（最早的），删除其余
      group.links.slice(1).forEach(l => idsToRemove.add(l.id));
    });
    const updatedLinks = links.filter(l => !idsToRemove.has(l.id));
    onUpdateLinks(updatedLinks);
    // 重新扫描
    handleScanDuplicates();
  };

  const handleRemoveDuplicate = (groupId: string, linkId: string) => {
    const updatedLinks = links.filter(l => l.id !== linkId);
    onUpdateLinks(updatedLinks);
    // 更新本地分组
    setDuplicateGroups(prev => {
      const newGroups = prev.map(g => {
        if (g.normalizedUrl !== groupId) return g;
        const newLinks = g.links.filter(l => l.id !== linkId);
        return { ...g, links: newLinks };
      }).filter(g => g.links.length > 1);
      return newGroups;
    });
  };

  if (!isOpen) return null;

  const tabs = [
    { id: 'site', label: '网站设置', icon: LayoutTemplate },
    { id: 'ai', label: 'AI 设置', icon: Bot },
    { id: 'tools', label: '扩展工具', icon: Wrench },
    { id: 'linkcheck', label: '死链检测', icon: Shield },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden border border-slate-200 dark:border-slate-700 flex max-h-[90vh] flex-col md:flex-row">
        
        <div className="w-full md:w-48 bg-slate-50 dark:bg-slate-800/50 border-r border-slate-200 dark:border-slate-700 flex flex-row md:flex-col p-2 gap-1 overflow-x-auto shrink-0">
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                        activeTab === tab.id 
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' 
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}
                >
                    <tab.icon size={18} />
                    {tab.label}
                </button>
            ))}
        </div>

        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden bg-white dark:bg-slate-800">
             <div className="flex justify-between items-center p-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
                <h3 className="text-lg font-semibold dark:text-white">设置</h3>
                <button onClick={onClose} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors">
                    <X className="w-5 h-5 dark:text-slate-400" />
                </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 pb-12">
                
                {activeTab === 'site' && (
                    <div className="space-y-6 animate-in fade-in duration-300">
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">网页标题 (Title)</label>
                                <input 
                                    type="text" 
                                    value={localSiteSettings.title}
                                    onChange={(e) => handleSiteChange('title', e.target.value)}
                                    className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">导航栏标题</label>
                                <input 
                                    type="text" 
                                    value={localSiteSettings.navTitle}
                                    onChange={(e) => handleSiteChange('navTitle', e.target.value)}
                                    className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">网站图标 (Favicon URL)</label>
                                <div className="flex gap-3 items-center">
                                    <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center overflow-hidden border border-slate-200 dark:border-slate-600">
                                        {localSiteSettings.favicon ? <img src={localSiteSettings.favicon} className="w-full h-full object-cover rounded-xl"/> : <Globe size={20} className="text-slate-400"/>}
                                    </div>
                                    <input 
                                        type="text" 
                                        value={localSiteSettings.favicon}
                                        onChange={(e) => handleSiteChange('favicon', e.target.value)}
                                        placeholder="https://example.com/favicon.ico"
                                        className="flex-1 p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                <div className="mt-2 flex items-center gap-2">
                                    <input
                                        ref={faviconUploadRef}
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={handleLocalFaviconUpload}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => faviconUploadRef.current?.click()}
                                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                                    >
                                        <Upload size={12} />
                                        本地上传
                                    </button>
                                    <p className="text-xs text-slate-500">会直接存成图片数据，不用图床。</p>
                                </div>
                            </div>
                            <div>
                                <div className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 px-4 py-3">
                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">访问时先验密</label>
                                        <p className="text-xs text-slate-500 mt-1">打开后，访问网站就先输密码。关闭后，只有点设置这些操作才验密。</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => handleSiteChange('requirePasswordOnVisit', !localSiteSettings.requirePasswordOnVisit)}
                                        className={`relative inline-flex h-8 w-14 items-center rounded-full border transition-all duration-200 ${
                                            localSiteSettings.requirePasswordOnVisit
                                              ? 'border-blue-500 bg-blue-600 shadow-[0_0_0_4px_rgba(59,130,246,0.12)]'
                                              : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800'
                                        }`}
                                        aria-pressed={localSiteSettings.requirePasswordOnVisit}
                                    >
                                        <span
                                            className={`inline-flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-200 ${
                                                localSiteSettings.requirePasswordOnVisit ? 'translate-x-7' : 'translate-x-1'
                                            }`}
                                        >
                                            <span className={`h-2.5 w-2.5 rounded-full ${localSiteSettings.requirePasswordOnVisit ? 'bg-blue-600' : 'bg-slate-400'}`} />
                                        </span>
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">身份验证过期天数</label>
                                <div className="relative">
                                    <input 
                                        type="number" 
                                        min="0"
                                        value={localSiteSettings.passwordExpiryDays}
                                        onChange={(e) => handleSiteChange('passwordExpiryDays', parseInt(e.target.value) || 0)}
                                        className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                <p className="text-xs text-slate-500 mt-1">设置为 0 表示永久不退出，默认 7 天后自动退出</p>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'ai' && (
                    <div className="space-y-6 animate-in fade-in duration-300">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">AI 提供商</label>
                            <select 
                                value={localConfig.provider}
                                onChange={(e) => handleChange('provider', e.target.value)}
                                className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="gemini">Google Gemini</option>
                                <option value="openai">OpenAI Compatible (ChatGPT, DeepSeek, Claude...)</option>
                            </select>
                        </div>
                        
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">API Key</label>
                            <div className="relative">
                                <Key size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input 
                                    type="password" 
                                    value={localConfig.apiKey}
                                    onChange={(e) => handleChange('apiKey', e.target.value)}
                                    placeholder="sk-..."
                                    className="w-full pl-10 p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                                />
                            </div>
                            <p className="text-xs text-slate-500 mt-1">Key 仅存储在本地浏览器缓存中，不会发送到我们的服务器。</p>
                        </div>

                        {localConfig.provider === 'openai' && (
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Base URL (API 地址)</label>
                                <input 
                                    type="text" 
                                    value={localConfig.baseUrl}
                                    onChange={(e) => handleChange('baseUrl', e.target.value)}
                                    placeholder="https://api.openai.com/v1"
                                    className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                        )}

                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">模型名称 (Model Name)</label>
                            <input 
                                type="text" 
                                value={localConfig.model}
                                onChange={(e) => handleChange('model', e.target.value)}
                                placeholder={localConfig.provider === 'gemini' ? "gemini-2.5-flash" : "gpt-3.5-turbo"}
                                className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                            />
                        </div>

                        <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
                            <h4 className="text-sm font-semibold mb-2 dark:text-slate-200">批量操作</h4>
                            {isProcessing ? (
                                <div className="space-y-2">
                                    <div className="flex justify-between text-xs text-slate-600 dark:text-slate-400">
                                        <span>正在生成描述... ({progress.current}/{progress.total})</span>
                                        <button onClick={() => { shouldStopRef.current = true; setIsProcessing(false); }} className="text-red-500 flex items-center gap-1 hover:underline">
                                            <PauseCircle size={12}/> 停止
                                        </button>
                                    </div>
                                    <div className="w-full h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                                        <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${(progress.current / progress.total) * 100}%` }}></div>
                                    </div>
                                </div>
                            ) : (
                                <button 
                                    onClick={handleBulkGenerate}
                                    className="flex items-center gap-2 text-sm text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 px-3 py-2 rounded-lg transition-colors border border-purple-200 dark:border-purple-800"
                                >
                                    <Sparkles size={16} /> 一键补全所有缺失的描述
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'tools' && (
                    <div className="space-y-8 animate-in fade-in duration-300">
                        
                        <div className="space-y-3">
                            <h4 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
                                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-bold">1</span>
                                扩展地址
                            </h4>
                            <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                                <div>
                                    <label className="text-xs text-slate-500 mb-1 block">API 域名 (自动获取)</label>
                                    <code className="block w-full p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-xs text-slate-600 dark:text-slate-400 font-mono truncate">
                                        {domain}
                                    </code>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <h4 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
                                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-bold">2</span>
                                选择浏览器类型
                            </h4>
                            <div className="grid grid-cols-2 gap-4">
                                <button 
                                    onClick={() => setBrowserType('chrome')}
                                    className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${browserType === 'chrome' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300 bg-white dark:bg-slate-800'}`}
                                >
                                    <span className="font-semibold">Chrome / Edge</span>
                                </button>
                                <button 
                                    onClick={() => setBrowserType('firefox')}
                                    className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${browserType === 'firefox' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-200 dark:border-slate-700 hover:border-blue-300 bg-white dark:bg-slate-800'}`}
                                >
                                    <span className="font-semibold">Mozilla Firefox</span>
                                </button>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <h4 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
                                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-bold">3</span>
                                配置步骤与代码
                            </h4>
                            
                            <div className="bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700">
                                <h5 className="font-semibold text-sm mb-3 dark:text-slate-200">
                                    安装指南 ({browserType === 'chrome' ? 'Chrome/Edge' : 'Firefox'} / 双模式插件):
                                </h5>
                                <ol className="list-decimal list-inside text-sm text-slate-600 dark:text-slate-400 space-y-2 leading-relaxed">
                                    <li>在电脑上新建文件夹 <code className="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-xs">CloudNav-Pro</code>。</li>
                                    <li><strong>[重要]</strong> 将下方图标保存为 <code className="bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono text-xs">icon.png</code>。</li>
                                    <li>获取插件代码文件：
                                        <ul className="list-disc list-inside ml-4 mt-1 space-y-1 text-slate-500">
                                            <li><strong>方式一 (推荐)：</strong>点击下方的 <span className="text-blue-600 dark:text-blue-400 font-bold">"📦 一键下载所有文件"</span> 按钮，解压到该文件夹。</li>
                                            <li><strong>方式二 (备用)：</strong>分别点击下方代码块的 <Download size={12} className="inline"/> 按钮下载或复制 <code className="bg-white dark:bg-slate-900 px-1 rounded">manifest.json</code>, <code className="bg-white dark:bg-slate-900 px-1 rounded">background.js</code> 等文件到该文件夹。</li>
                                        </ul>
                                    </li>
                                    <li>
                                        打开浏览器扩展管理页面 
                                        {browserType === 'chrome' ? (
                                            <> (Chrome: <code className="select-all bg-white dark:bg-slate-900 px-1 rounded">chrome://extensions</code>)</>
                                        ) : (
                                            <> (Firefox: <code className="select-all bg-white dark:bg-slate-900 px-1 rounded">about:debugging</code>)</>
                                        )}。
                                    </li>
                                    <li className="text-blue-600 font-bold">操作关键点：</li>
                                    <li>1. 开启右上角的 "开发者模式" (Chrome)。</li>
                                    <li>2. 点击 "加载已解压的扩展程序"，选择包含上述文件的文件夹。</li>
                                    <li>3. 前往 <code className="select-all bg-white dark:bg-slate-900 px-1 rounded">chrome://extensions/shortcuts</code>。</li>
                                    <li>4. 点浏览器右上角插件图标，默认先弹出小窗。</li>
                                    <li>5. 在弹窗右上角点侧边栏按钮，就能切到侧边栏。</li>
                                    <li>6. <strong>[重要]</strong> 找到 "打开 CloudNav 弹窗" 和 "打开 CloudNav 侧边栏" 两个快捷键，按你习惯自己设。</li>
                                </ol>
                                
                                <div className="mt-4 mb-4">
                                    <button 
                                        onClick={handleDownloadZip}
                                        disabled={isZipping}
                                        className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-70 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl transition-colors shadow-lg shadow-blue-500/20"
                                    >
                                        <Package size={20} />
                                        {isZipping ? '打包中...' : '📦 一键下载所有文件 (v7.6 Pro)'}
                                    </button>
                                </div>
                                
                                <div className="p-3 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 rounded border border-green-200 dark:border-green-900/50 text-sm space-y-2">
                                    <div className="font-bold flex items-center gap-2"><Zap size={16}/> 当前方案 (双模式):</div>
                                    <ul className="list-disc list-inside text-xs space-y-1">
                                        <li><strong>点扩展图标:</strong> 直接弹出小窗。</li>
                                        <li><strong>弹窗右上角按钮:</strong> 一下切到侧边栏。</li>
                                        <li><strong>网页右键:</strong> 直接展示分类列表 (支持判重警告)。</li>
                                        <li><strong>图标右键:</strong> 同上，统一为级联菜单，直接保存。</li>
                                    </ul>
                                </div>
                            </div>

                            <div className="p-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                     <div className="w-12 h-12 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center overflow-hidden border border-slate-200 dark:border-slate-600">
                                        {localSiteSettings.favicon ? <img src={localSiteSettings.favicon} className="w-full h-full object-cover"/> : <Globe size={24} className="text-slate-400"/>}
                                    </div>
                                    <div>
                                        <div className="font-medium text-sm dark:text-white">插件图标 (icon.png)</div>
                                        <div className="text-xs text-slate-500">请保存此图片为 icon.png</div>
                                    </div>
                                </div>
                                <button 
                                    onClick={handleDownloadIcon}
                                    className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 dark:text-blue-400 rounded-lg transition-colors"
                                >
                                    <Download size={16} /> 下载图标
                                </button>
                            </div>

                            <div className="space-y-4">
                                <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200 pt-2 border-t border-slate-100 dark:border-slate-700">
                                    <Sidebar size={18} className="text-purple-500"/> 核心配置
                                </div>
                                {renderCodeBlock('manifest.json', getManifestJson())}
                                {renderCodeBlock('background.js', extBackgroundJs)}
                                
                                <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200 pt-2 border-t border-slate-100 dark:border-slate-700">
                                    <Keyboard size={18} className="text-green-500"/> 扩展弹窗界面
                                </div>
                                {renderCodeBlock('popup.html', extPopupHtml)}
                                {renderCodeBlock('popup.js', extPopupJs)}

                                <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200 pt-2 border-t border-slate-100 dark:border-slate-700">
                                    <Sidebar size={18} className="text-purple-500"/> 侧边栏界面
                                </div>
                                {renderCodeBlock('sidebar.html', extSidebarHtml)}
                                {renderCodeBlock('sidebar.js', extSidebarJs)}
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'linkcheck' && (
                    <div className="space-y-4 animate-in fade-in duration-300">
                        <div className="flex items-center gap-2 mb-2">
                            <Shield size={20} className="text-red-500" />
                            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">死链检测</h3>
                        </div>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            检测所有书签是否可访问，死链可自动修复为 Wayback Machine 归档版本。
                        </p>

                        {/* 空闲态 */}
                        {linkCheckStatus === 'idle' && (
                            <div className="bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700">
                                <div className="flex items-center justify-between">
                                    <div className="text-sm text-slate-600 dark:text-slate-400">
                                        共 <span className="font-bold text-slate-800 dark:text-slate-200">{links.length}</span> 个书签待检测
                                    </div>
                                    <button
                                        onClick={handleStartLinkCheck}
                                        disabled={links.length === 0}
                                        className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
                                    >
                                        <Play size={16} /> 开始检测
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* 检测中 / 暂停 */}
                        {(linkCheckStatus === 'running' || linkCheckStatus === 'paused') && (
                            <div className="bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700 space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="text-sm text-slate-600 dark:text-slate-400">
                                        已检测 <span className="font-bold text-slate-800 dark:text-slate-200">{linkCheckProgress.current}</span> / {linkCheckProgress.total}
                                    </div>
                                    <div className="flex gap-2">
                                        {linkCheckStatus === 'running' ? (
                                            <button onClick={handlePauseLinkCheck} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-600 bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 rounded-lg transition-colors">
                                                <PauseCircle size={14} /> 暂停
                                            </button>
                                        ) : (
                                            <button onClick={handleResumeLinkCheck} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-green-600 bg-green-50 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400 rounded-lg transition-colors">
                                                <Play size={14} /> 继续
                                            </button>
                                        )}
                                        <button onClick={handleCancelLinkCheck} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-400 rounded-lg transition-colors">
                                            <Square size={14} /> 取消
                                        </button>
                                    </div>
                                </div>
                                {/* 进度条 */}
                                <div className="w-full h-2.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-red-500 transition-all duration-300"
                                        style={{ width: `${linkCheckProgress.total > 0 ? (linkCheckProgress.current / linkCheckProgress.total) * 100 : 0}%` }}
                                    />
                                </div>
                                {currentCheckingUrl && (
                                    <div className="text-xs text-slate-400 truncate">
                                        正在检测: {currentCheckingUrl}
                                    </div>
                                )}
                                {/* 实时死链计数 */}
                                {linkCheckResults.filter(r => !r.alive).length > 0 && (
                                    <div className="text-sm text-red-500 font-medium">
                                        已发现 {linkCheckResults.filter(r => !r.alive).length} 个死链
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 完成态 */}
                        {linkCheckStatus === 'done' && (
                            <div className="space-y-4">
                                {/* 统计摘要 */}
                                <div className="bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="text-sm text-slate-600 dark:text-slate-400">
                                            检测完成，共 {linkCheckProgress.total} 个链接
                                        </div>
                                        <button
                                            onClick={handleStartLinkCheck}
                                            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 rounded-lg transition-colors"
                                        >
                                            <RefreshCw size={14} /> 重新检测
                                        </button>
                                    </div>
                                    <div className="flex gap-6 text-sm">
                                        <span className="text-green-600 dark:text-green-400 font-medium">
                                            存活: {linkCheckResults.filter(r => r.alive).length}
                                        </span>
                                        <span className="text-red-600 dark:text-red-400 font-medium">
                                            死链: {linkCheckResults.filter(r => !r.alive).length}
                                        </span>
                                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                                            有归档: {linkCheckResults.filter(r => !r.alive && r.archiveUrl).length}
                                        </span>
                                    </div>
                                </div>

                                {/* 死链列表 */}
                                {linkCheckResults.filter(r => !r.alive).length > 0 && (
                                    <div className="space-y-3">
                                        {/* 批量操作 */}
                                        {linkCheckResults.filter(r => !r.alive && r.archiveUrl).length > 0 && (
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={handleBatchUpdateArchive}
                                                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 rounded-lg transition-colors"
                                                >
                                                    <Archive size={14} /> 全部更新为归档链接
                                                </button>
                                                <button
                                                    onClick={handleBatchDeleteDead}
                                                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 rounded-lg transition-colors"
                                                >
                                                    <Trash2 size={14} /> 全部删除
                                                </button>
                                            </div>
                                        )}

                                        {/* 单个死链项 */}
                                        <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
                                            {linkCheckResults.filter(r => !r.alive).map(result => (
                                                <div key={result.linkId} className="flex items-center justify-between p-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
                                                    <div className="flex-1 min-w-0 mr-3">
                                                        <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{result.title}</div>
                                                        <div className="text-xs text-slate-400 truncate">{result.url}</div>
                                                        <div className="text-xs mt-1.5">
                                                            {result.error ? (
                                                                <span className="text-red-500">{result.error === 'Timeout' ? '超时' : result.error === 'Connection failed' ? '无法连接' : result.error}</span>
                                                            ) : (
                                                                <span className="text-red-500">HTTP {result.status}</span>
                                                            )}
                                                            {result.archiveUrl && (
                                                                <span className="text-amber-500 ml-2">有归档</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-1.5 shrink-0">
                                                        {result.archiveUrl && (
                                                            <button
                                                                onClick={() => handleUpdateToArchive(result)}
                                                                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 rounded transition-colors"
                                                                title="更新为归档链接"
                                                            >
                                                                <Archive size={12} />
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => handleDeleteDeadLink(result)}
                                                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 rounded transition-colors"
                                                            title="删除此链接"
                                                        >
                                                            <Trash2 size={12} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* 无死链 */}
                                {linkCheckResults.filter(r => !r.alive).length === 0 && linkCheckResults.length > 0 && (
                                    <div className="text-center py-8 text-sm text-green-600 dark:text-green-400">
                                        <Check size={32} className="mx-auto mb-2" />
                                        所有链接均正常！
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 重复书签检测 */}
                        <div className="space-y-4 pt-6 border-t border-slate-200 dark:border-slate-700 mt-6">
                            <h4 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
                                <AlertTriangle size={18} className="text-amber-500" />
                                重复书签检测
                            </h4>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                扫描所有书签，找出 URL 相同的重复项并清理。
                            </p>

                            {!hasScannedDuplicates ? (
                                <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                                    <div className="flex items-center justify-between">
                                        <div className="text-sm text-slate-600 dark:text-slate-400">
                                            共 <span className="font-bold text-slate-800 dark:text-slate-200">{links.length}</span> 个书签待扫描
                                        </div>
                                        <button
                                            onClick={handleScanDuplicates}
                                            disabled={links.length === 0}
                                            className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
                                        >
                                            <Search size={14} /> 扫描重复
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {/* 扫描结果摘要 */}
                                    <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="text-sm text-slate-600 dark:text-slate-400">
                                                {duplicateGroups.length > 0
                                                    ? `发现 ${duplicateGroups.length} 组重复，共 ${duplicateGroups.reduce((s, g) => s + g.links.length - 1, 0)} 个冗余链接`
                                                    : '未发现重复链接'}
                                            </div>
                                            <button
                                                onClick={() => { setHasScannedDuplicates(false); setDuplicateGroups([]); }}
                                                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 rounded-lg transition-colors"
                                            >
                                                <RefreshCw size={12} /> 重新扫描
                                            </button>
                                        </div>
                                        {duplicateGroups.length > 0 && (
                                            <button
                                                onClick={handleAutoCleanDuplicates}
                                                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors"
                                            >
                                                自动保留最早的，删除其余
                                            </button>
                                        )}
                                    </div>

                                    {/* 重复组列表 */}
                                    {duplicateGroups.map((group, idx) => (
                                        <div key={group.normalizedUrl} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2">
                                            <div className="text-xs text-slate-400 truncate mb-1">
                                                第 {idx + 1} 组: {group.normalizedUrl}
                                            </div>
                                            {group.links.map((link, linkIdx) => (
                                                <div key={link.id} className="flex items-center justify-between py-1.5 px-2 rounded bg-slate-50 dark:bg-slate-700/50">
                                                    <div className="flex-1 min-w-0 mr-2">
                                                        <div className="text-sm text-slate-700 dark:text-slate-300 truncate">
                                                            {link.title}
                                                            {linkIdx === 0 && <span className="ml-1.5 text-xs text-green-500">(最早)</span>}
                                                        </div>
                                                        <div className="text-xs text-slate-400">
                                                            {link.createdAt ? new Date(link.createdAt).toLocaleDateString() : ''}
                                                        </div>
                                                    </div>
                                                    {linkIdx > 0 && (
                                                        <button
                                                            onClick={() => handleRemoveDuplicate(group.normalizedUrl, link.id)}
                                                            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 rounded transition-colors shrink-0"
                                                        >
                                                            <Trash2 size={10} /> 删除
                                                        </button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    ))}

                                    {/* 无重复 */}
                                    {duplicateGroups.length === 0 && (
                                        <div className="text-center py-6 text-sm text-green-600 dark:text-green-400">
                                            <Check size={24} className="mx-auto mb-2" />
                                            没有重复书签！
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}

            </div>

            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end bg-slate-50 dark:bg-slate-800/50 shrink-0">
                <button 
                    onClick={handleSave}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium transition-colors shadow-lg shadow-blue-500/20"
                >
                    <Save size={18} /> 保存更改
                </button>
            </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
