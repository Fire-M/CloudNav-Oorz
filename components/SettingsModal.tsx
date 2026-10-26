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
            default_title: `打开 ${navName} 弹窗`
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
            "description": `打开 ${navName} 弹窗`
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
    json.action.default_popup = "popup.html";
    
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
const POPUP_PATH = 'popup.html';

let linkCache = [];
let categoryCache = [];

async function getUiMode() {
    const data = await chrome.storage.local.get(MODE_KEY);
    return data[MODE_KEY] === 'sidepanel' ? 'sidepanel' : 'popup';
}

async function setUiMode(mode) {
    await chrome.storage.local.set({ [MODE_KEY]: mode });
    await chrome.action.setPopup({ popup: mode === 'popup' ? POPUP_PATH : '' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: mode === 'sidepanel' }).catch(() => {});
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

chrome.commands.onCommand.addListener(async (command) => {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.windowId) return;
        if (command === 'open_sidepanel') {
            await setUiMode('sidepanel');
            await chrome.sidePanel.open({ windowId: tab.windowId });
            return;
        }
        if (command === '_execute_action') {
            await setUiMode('popup');
            await chrome.action.openPopup();
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
            --bg: #ffffff;
            --text: #1e293b;
            --border: #e2e8f0;
            --hover: #f1f5f9;
            --accent: #3b82f6;
            --muted: #64748b;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #0f172a;
                --text: #f1f5f9;
                --border: #334155;
                --hover: #1e293b;
                --accent: #60a5fa;
                --muted: #94a3b8;
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
    <style>
        :root {
            --card: rgba(255,255,255,0.72);
            --text: #4a2545;
            --muted: #9a7f95;
            --line: rgba(236,72,153,0.14);
            --accent: #ec4899;
            --accent-soft: rgba(236,72,153,0.12);
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; width: 388px; min-width: 388px; max-width: 388px; color: var(--text);
          background: linear-gradient(165deg, #ffe3ee 0%, #fff4f8 42%, #ffffff 100%);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif; }
        body { padding: 16px 14px 12px; }
        .shell { display: flex; flex-direction: column; gap: 12px; max-height: 600px; }
        .hero { padding: 16px 14px 14px; border-radius: 22px; background: var(--card); backdrop-filter: blur(18px);
          border: 1px solid var(--line); box-shadow: 0 18px 50px rgba(236,72,153,0.10); }
        .hero-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .date { font-size: 12px; color: var(--muted); letter-spacing: .3px; }
        .tools { display: flex; gap: 6px; }
        .tool-btn { width: 30px; height: 30px; border-radius: 10px; border: 1px solid var(--line); background: rgba(255,255,255,0.6);
          color: var(--muted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: all .18s; }
        .tool-btn:hover { color: var(--accent); border-color: rgba(236,72,153,0.32); background: #fff; }
        .rotating { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .clock { margin-top: 4px; font-size: 46px; font-weight: 250; line-height: 1.05; letter-spacing: -1px; color: #3d2039; }
        .search-wrap { position: relative; margin-top: 14px; }
        .search-icon { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; display: flex; }
        .search { width: 100%; border: 1px solid var(--line); background: rgba(255,255,255,0.85); color: var(--text); border-radius: 999px;
          padding: 10px 14px 10px 36px; outline: none; font-size: 13px; transition: all .18s; }
        .search:focus { border-color: rgba(236,72,153,0.4); box-shadow: 0 0 0 3px rgba(236,72,153,0.10); }
        .engines { display: flex; gap: 6px; margin-top: 10px; }
        .engine { flex: 1; white-space: nowrap; border: 1px solid var(--line); background: rgba(255,255,255,0.55); color: var(--muted);
          border-radius: 999px; padding: 5px 6px; font-size: 11px; cursor: pointer; transition: all .18s; }
        .engine:hover { color: var(--accent); border-color: rgba(236,72,153,0.3); }
        .engine.active { color: #fff; background: var(--accent); border-color: transparent; box-shadow: 0 6px 16px rgba(236,72,153,0.22); }
        .chips { display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 0; scrollbar-width: none; }
        .chips::-webkit-scrollbar { display: none; }
        .chip { white-space: nowrap; border: 1px solid var(--line); background: rgba(255,255,255,0.6); color: var(--muted); border-radius: 999px;
          padding: 6px 12px; font-size: 12px; cursor: pointer; transition: all .18s; }
        .chip.active { color: #fff; background: var(--accent); border-color: transparent; box-shadow: 0 8px 20px rgba(236,72,153,0.25); }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px 6px; }
        .app { display: flex; flex-direction: column; align-items: center; gap: 6px; text-decoration: none; color: inherit; }
        .app-icon { width: 54px; height: 54px; border-radius: 18px; background: #fff; display: flex; align-items: center; justify-content: center;
          overflow: hidden; border: 1px solid rgba(255,255,255,0.9); box-shadow: 0 8px 20px rgba(236,72,153,0.10); transition: transform .18s, box-shadow .18s; }
        .app:hover .app-icon { transform: translateY(-3px); box-shadow: 0 12px 26px rgba(236,72,153,0.20); }
        .app-icon img { width: 58%; height: 58%; object-fit: contain; }
        .app-name { font-size: 11px; color: #6b4c68; text-align: center; max-width: 100%; line-height: 1.2;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .card { grid-column: 1/-1; display: flex; align-items: center; gap: 12px; padding: 11px 12px; border-radius: 16px;
          background: rgba(255,255,255,0.7); border: 1px solid var(--line); text-decoration: none; color: inherit; }
        .meta { min-width: 0; flex: 1; }
        .title { font-size: 13px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .url { margin-top: 3px; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badge { margin-top: 8px; display: inline-flex; padding: 4px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; }
        .empty { grid-column: 1/-1; text-align: center; color: var(--muted); padding: 28px 12px; font-size: 12px; }
        .daily { padding: 2px 10px 0; text-align: center; font-size: 11px; color: var(--muted); line-height: 1.5; }
    </style>
</head>
<body>
    <div class="shell">
        <section class="hero">
            <div class="hero-top">
                <div class="date" id="dateLine">—</div>
                <div class="tools">
                    <button id="openSidepanel" class="tool-btn" title="打开侧边栏">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
                    </button>
                    <button id="refresh" class="tool-btn" title="同步最新数据">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                    </button>
                    <button id="bmPreview" class="tool-btn" title="预览浏览器收藏夹（只读，不会上传）">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
                    </button>
                    <button id="lock" class="tool-btn" title="锁定（清除本机保存的密码）">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    </button>
                </div>
            </div>
            <div class="clock" id="clockLine">--:--</div>
            <div class="search-wrap">
                <span class="search-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                </span>
                <input id="search" class="search" type="text" placeholder="搜收藏，回车用搜索引擎搜网络" autocomplete="off">
            </div>
            <div class="engines" id="engines">
                <button class="engine active" data-engine="baidu">百度</button>
                <button class="engine" data-engine="bing">必应</button>
                <button class="engine" data-engine="google">Google</button>
            </div>
        </section>
        <div id="chips" class="chips"></div>
        <div id="content" class="grid">
            <div class="empty">初始化中...</div>
        </div>
        <footer class="daily" id="daily"></footer>
    </div>
    <script src="popup.js"></script>
</body>
</html>`;

const extPopupJs = `const CONFIG = {
  apiBase: "${domain}"
};
${extAuthHelpers}
const CACHE_KEY = 'cloudnav_data';

document.addEventListener('DOMContentLoaded', async () => {
    const content = document.getElementById('content');
    const chips = document.getElementById('chips');
    const searchInput = document.getElementById('search');
    const refreshBtn = document.getElementById('refresh');
    const openSidepanelBtn = document.getElementById('openSidepanel');
    const bmPreviewBtn = document.getElementById('bmPreview');
    let bmPreviewMode = false;
    let bmData = { folders: [], links: [] };
    let bmSyncing = false;

    let allLinks = [];
    let allCategories = [];
    let activeCategory = 'all';

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

    // 网格每格只有 84px，标签最多显示 5 个字；
    // 完整标题已经挂在 a 标签的 title 上，鼠标悬浮即可看全
    const shortName = (value) => {
        const text = String(value ?? '');
        return text.length > 5 ? text.slice(0, 5) + '…' : text;
    };

    const renderChips = () => {
        const fallbackCategories = allCategories.length > 0
            ? allCategories
            : Array.from(new Set(allLinks.map((link) => link.categoryId)))
                .filter(Boolean)
                .map((categoryId) => ({ id: categoryId, name: categoryId }));
        const items = [{ id: 'all', name: '全部' }, ...fallbackCategories];
        chips.innerHTML = items.map((category) => \`
            <button class="chip \${activeCategory === category.id ? 'active' : ''}" data-id="\${category.id}">
                \${escapeHtml(category.name)}
            </button>
        \`).join('');
    };

    const render = () => {
        if (bmPreviewMode) return;
        const query = searchInput.value.trim().toLowerCase();
        const filteredLinks = allLinks.filter((link) => {
            if (activeCategory !== 'all' && link.categoryId !== activeCategory) return false;
            if (!query) return true;
            return link.title.toLowerCase().includes(query) ||
                link.url.toLowerCase().includes(query) ||
                (link.description && link.description.toLowerCase().includes(query));
        });

        if (filteredLinks.length === 0) {
            content.innerHTML = '<div class="empty">没有匹配的收藏，回车用搜索引擎搜一下</div>';
            return;
        }

        content.innerHTML = filteredLinks.map((link) => \`
            <a class="app" href="\${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" title="\${escapeHtml(link.title)}">
                <div class="app-icon"><img src="\${escapeHtml(getFaviconUrl(link))}" alt="" onerror="this.style.display='none'"></div>
                <div class="app-name">\${escapeHtml(shortName(link.title))}</div>
            </a>
        \`).join('');
    };

    // --- 时钟与日期 ---
    const dateLine = document.getElementById('dateLine');
    const clockLine = document.getElementById('clockLine');
    const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const tickClock = () => {
        const now = new Date();
        clockLine.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        dateLine.textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + WEEKDAYS[now.getDay()];
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
    const enginesBox = document.getElementById('engines');
    enginesBox.addEventListener('click', (event) => {
        const btn = event.target.closest('.engine');
        if (!btn) return;
        activeEngine = btn.dataset.engine || 'baidu';
        enginesBox.querySelectorAll('.engine').forEach((item) => {
            item.classList.toggle('active', item === btn);
        });
        const query = searchInput.value.trim();
        if (query) window.open(ENGINES[activeEngine] + encodeURIComponent(query), '_blank');
    });

    searchInput.addEventListener('input', render);
    searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const query = searchInput.value.trim();
        if (!query) return;
        // 输入框会实时筛出本地收藏，回车则是用搜索引擎搜网络
        window.open(ENGINES[activeEngine] + encodeURIComponent(query), '_blank');
    });

    // --- 锁定：清除本机保存的密码 ---
    document.getElementById('lock')?.addEventListener('click', async () => {
        await clearStoredAuth();
        showLogin('已锁定，请输入站点密码');
    });

    chips.addEventListener('click', (event) => {
        const chip = event.target.closest('.chip');
        if (!chip) return;
        activeCategory = chip.dataset.id || 'all';
        renderChips();
        render();
    });
    const renderBookmarkPreview = () => {
        const folderCount = bmData.folders.length;
        const linkCount = bmData.links.length;
        const rootLinks = bmData.links.filter((item) => !item.folderId).length;

        const rows = bmData.folders.map((folder) => {
            const children = bmData.links.filter((item) => item.folderId === folder.id).length;
            // depth 1 是收藏夹栏，它本身挂在"浏览器收藏夹"容器下，所以从 1 级开始缩进
            const indent = typeof folder.depth === 'number' ? folder.depth * 14 : 14;
            return \`
                <div class="card" style="cursor:default">
                    <div class="meta">
                        <div class="title" style="margin-left:\${indent}px">\${escapeHtml(folder.title)}</div>
                        <div class="url" style="margin-left:\${indent}px">\${children} 个书签</div>
                    </div>
                </div>
            \`;
        }).join('');
        content.innerHTML = \`
            <div class="card" style="cursor:default;border-color:rgba(37,99,235,0.35)">
                <div class="meta">
                    <div class="title">收藏夹共 \${linkCount} 个书签</div>
                    <div class="url">\${folderCount} 个文件夹\${rootLinks ? ('，其中 ' + rootLinks + ' 个在根目录') : ''}</div>
                </div>
            </div>
            <button id="bmSync" class="chip" style="grid-column:1/-1;text-align:center;justify-content:center;color:white;background:var(--accent);border-color:transparent">
                同步到站点
            </button>
            \${rows}
        \`;
    };

    bmPreviewBtn?.addEventListener('click', async () => {
        if (bmPreviewMode) {
            bmPreviewMode = false;
            bmPreviewBtn.style.color = '';
            chips.style.display = '';
            render();
            return;
        }
        try {
            bmPreviewBtn.classList.add('rotating');
            const response = await chrome.runtime.sendMessage({ type: 'get-bookmarks-preview' });
            if (!response || !response.ok) {
                throw new Error((response && response.error) || '读取收藏夹失败');
            }
            bmData = { folders: response.folders || [], links: response.links || [] };
            bmPreviewMode = true;
            bmPreviewBtn.style.color = 'var(--accent)';
            chips.style.display = 'none';
            renderBookmarkPreview();
        } catch (e) {
            content.innerHTML = \`<div class="empty" style="color:#ef4444">读取收藏夹失败<br>\${escapeHtml(e.message)}</div>\`;
        } finally {
            bmPreviewBtn.classList.remove('rotating');
        }
    });

    content.addEventListener('click', async (event) => {
        const btn = event.target.closest('#bmSync');
        if (!btn || bmSyncing) return;

        bmSyncing = true;
        btn.disabled = true;
        btn.textContent = '正在同步...';

        try {
            const response = await chrome.runtime.sendMessage({ type: 'sync-bookmarks' });
            if (!response || !response.ok) {
                throw new Error((response && response.error) || '同步失败');
            }
            const result = response.result || {};
            btn.textContent = '完成：新增 ' + (result.added || 0) + ' · 归位 ' + (result.moved || 0) + ' · 删除 ' + (result.removed || 0);
        } catch (e) {
            // 没解锁时直接把登录框顶上来，比干巴巴一句"同步失败"有用
            if (String((e && e.message) || '').indexOf('需要登录') !== -1) {
                showLogin('请先用站点密码解锁');
                return;
            }
            btn.textContent = '同步失败，点击重试';
            btn.disabled = false;
            console.error('Sync bookmarks failed', e);
        } finally {
            bmSyncing = false;
        }
    });

    openSidepanelBtn?.addEventListener('click', async () => {
        try {
            const currentWindow = await chrome.windows.getCurrent();
            await chrome.runtime.sendMessage({ type: 'open-sidepanel', windowId: currentWindow.id });
            window.close();
        } catch (e) {
            console.error('Open side panel failed', e);
        }
    });

    const showLogin = (errorMessage) => {
        const tip = errorMessage
            ? '<div style="color:#ef4444;font-size:12px;margin-top:8px">' + escapeHtml(errorMessage) + '</div>'
            : '';
        content.innerHTML = \`
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
        chips.style.display = 'none';
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
            chips.style.display = '';
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
                    allLinks = cached[CACHE_KEY].links || [];
                    allCategories = cached[CACHE_KEY].categories || [];
                    renderChips();
                    render();
                    return;
                }
            }

            refreshBtn.classList.add('rotating');
            const res = await authFetch(\`\${CONFIG.apiBase}/api/storage\`);
            const data = await res.json();
            allLinks = data.links || [];
            allCategories = data.categories || [];
            await chrome.storage.local.set({ [CACHE_KEY]: data });
            chips.style.display = '';
            renderChips();
            render();
        } catch (e) {
            if (e && e.needAuth) {
                showLogin('');
            } else {
                content.innerHTML = \`<div class="empty" style="color:#ef4444">加载失败<br>\${escapeHtml(e.message)}</div>\`;
            }
        } finally {
            refreshBtn.classList.remove('rotating');
        }
    };

    refreshBtn.addEventListener('click', () => loadData(true));

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'refresh') {
            loadData(true);
        }
    });

    loadData();
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
