
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search, Plus, Upload, Moon, Sun, Menu,
  Trash2, Edit2, Loader2, Cloud, CheckCircle2, AlertCircle,
  Pin, Settings, Lock, CloudCog, Github, GitFork, GripVertical, Save, CheckSquare, LogOut, ExternalLink, X, ChevronRight, Star, PanelLeftClose, PanelLeftOpen
} from 'lucide-react';
import {
  DndContext,
  DragEndEvent,
  closestCenter,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  KeyboardSensor,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LinkItem, Category, DEFAULT_CATEGORIES, INITIAL_LINKS, WebDavConfig, AIConfig, SearchMode, ExternalSearchSource, SearchConfig } from './types';
import { parseBookmarks } from './services/bookmarkParser';
import Icon from './components/Icon';
import AuthModal from './components/AuthModal';
import LinkModal from './components/LinkModal';
import CategoryManagerModal from './components/CategoryManagerModal';
import BackupModal from './components/BackupModal';
import CategoryAuthModal from './components/CategoryAuthModal';
import ImportModal from './components/ImportModal';
import SettingsModal from './components/SettingsModal';
import { ConfirmDialogHost, confirmDialog, alertDialog } from './components/ConfirmDialog';
import CategoryTreeSelect from './components/CategoryTreeSelect';
import SearchConfigModal from './components/SearchConfigModal';
import ContextMenu from './components/ContextMenu';
import QRCodeModal from './components/QRCodeModal';

// --- 配置项 ---
// 项目核心仓库地址
const GITHUB_REPO_URL = 'https://github.com/Aaowu/CloudNav-Oorz';

// 本地开发模式：跳过 Cloudflare API 与密码验证，直接使用本地数据
// 生产构建时 import.meta.env.DEV 为 false，自动失效
const IS_DEV = import.meta.env.DEV === true;

const LOCAL_STORAGE_KEY = 'cloudnav_data_cache';
const AUTH_KEY = 'cloudnav_auth_token';
const AUTH_TIME_KEY = 'lastLoginTime';
const WEBDAV_CONFIG_KEY = 'cloudnav_webdav_config';
const AI_CONFIG_KEY = 'cloudnav_ai_config';
const SEARCH_CONFIG_KEY = 'cloudnav_search_config';

// --- 树形分类工具函数 ---
interface CategoryTreeNode {
  category: Category;
  children: CategoryTreeNode[];
}

// 将扁平分类数组转为嵌套树结构
const buildCategoryTree = (categories: Category[]): CategoryTreeNode[] => {
  const map = new Map<string, CategoryTreeNode>();
  const roots: CategoryTreeNode[] = [];

  // 先创建所有节点
  categories.forEach(cat => {
    map.set(cat.id, { category: cat, children: [] });
  });

  // 建立父子关系
  categories.forEach(cat => {
    const node = map.get(cat.id)!;
    if (cat.parentId && map.has(cat.parentId)) {
      map.get(cat.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
};

// 递归获取某分类下所有子孙分类 ID
const getAllChildIds = (categories: Category[], parentId: string): string[] => {
  const children = categories.filter(c => c.parentId === parentId);
  const ids: string[] = [];
  children.forEach(child => {
    ids.push(child.id);
    ids.push(...getAllChildIds(categories, child.id));
  });
  return ids;
};

// 获取某分类的所有祖先分类 ID（从父级到根，含自身）
const getAncestorIds = (categories: Category[], categoryId: string): string[] => {
  const ids: string[] = [];
  const map = new Map(categories.map(c => [c.id, c]));
  let current = map.get(categoryId);
  // 防御性循环引用保护
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    ids.push(current.id);
    if (!current.parentId) break;
    current = map.get(current.parentId);
  }
  return ids;
};

// 获取分类在树中的层级深度（顶级为0）
const getCategoryDepth = (categories: Category[], categoryId: string): number => {
  let depth = 0;
  let current = categories.find(c => c.id === categoryId);
  while (current?.parentId) {
    depth++;
    current = categories.find(c => c.id === current.parentId);
    if (!current) break; // 防止循环引用
  }
  return depth;
};

// 获取可选择的父分类列表（排除自身及其子孙，防止循环引用）
const getAvailableParents = (categories: Category[], excludeId?: string): Category[] => {
  if (!excludeId) return categories;
  const excludeIds = new Set([excludeId, ...getAllChildIds(categories, excludeId)]);
  return categories.filter(c => !excludeIds.has(c.id));
};

// 将树形节点扁平化（深度优先，用于渲染）
const flattenTree = (nodes: CategoryTreeNode[]): Category[] => {
  const result: Category[] = [];
  nodes.forEach(node => {
    result.push(node.category);
    result.push(...flattenTree(node.children));
  });
  return result;
};

const createRoundedFavicon = (source: string): Promise<string> => {
  return new Promise((resolve) => {
    if (!source) {
      resolve(source);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 64;
        const radius = 14;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          resolve(source);
          return;
        }

        ctx.beginPath();
        ctx.moveTo(radius, 0);
        ctx.lineTo(size - radius, 0);
        ctx.quadraticCurveTo(size, 0, size, radius);
        ctx.lineTo(size, size - radius);
        ctx.quadraticCurveTo(size, size, size - radius, size);
        ctx.lineTo(radius, size);
        ctx.quadraticCurveTo(0, size, 0, size - radius);
        ctx.lineTo(0, radius);
        ctx.quadraticCurveTo(0, 0, radius, 0);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        resolve(source);
      }
    };
    img.onerror = () => resolve(source);
    img.src = source;
  });
};

function App() {
  const themeButtonRef = useRef<HTMLButtonElement | null>(null);
  const themeTransitionTimerRef = useRef<number | null>(null);

  // --- State ---
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [darkMode, setDarkMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('cloudnav_sidebar_collapsed') === 'true';
  });
  
  // Search Mode State
  const [searchMode, setSearchMode] = useState<SearchMode>('internal');
  const [externalSearchSources, setExternalSearchSources] = useState<ExternalSearchSource[]>([]);
  const [isLoadingSearchConfig, setIsLoadingSearchConfig] = useState(true);
  
  // Category Security State
  const [unlockedCategoryIds, setUnlockedCategoryIds] = useState<Set<string>>(new Set());

  // Category Tree Expand State
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());

  // 折叠模式下 hover 子分类弹出层
  const [collapsedFlyout, setCollapsedFlyout] = useState<{ catId: string; rect: DOMRect } | null>(null);
  const flyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WebDAV Config State
  const [webDavConfig, setWebDavConfig] = useState<WebDavConfig>({
      url: '',
      username: '',
      password: '',
      enabled: false
  });

  // AI Config State
  const [aiConfig, setAiConfig] = useState<AIConfig>(() => {
      const saved = localStorage.getItem(AI_CONFIG_KEY);
      if (saved) {
          try {
              return JSON.parse(saved);
          } catch (e) {}
      }
      return {
          provider: 'gemini',
          apiKey: process.env.API_KEY || '', 
          baseUrl: '',
          model: 'gemini-2.5-flash'
      };
  });

  // Site Settings State
  const [siteSettings, setSiteSettings] = useState(() => {
      const saved = localStorage.getItem('cloudnav_site_settings');
      if (saved) {
          try {
              return JSON.parse(saved);
          } catch (e) {}
      }
      return {
          title: '',
          navTitle: 'CloudNav',
          favicon: '',
          cardStyle: 'detailed' as const,
          requirePasswordOnVisit: false,
          passwordExpiryDays: 7
      };
  });
  
  // Modals
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isCatManagerOpen, setIsCatManagerOpen] = useState(false);
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isSearchConfigModalOpen, setIsSearchConfigModalOpen] = useState(false);
  const [catAuthModalData, setCatAuthModalData] = useState<Category | null>(null);
  const [pendingProtectedCategoryId, setPendingProtectedCategoryId] = useState<string | null>(null);
  // 多级导航：记录用户原本想点击的子分类，解锁祖先后选中它而不是祖先本身
  const [pendingSelectCategoryId, setPendingSelectCategoryId] = useState<string | null>(null);
  
  const [editingLink, setEditingLink] = useState<LinkItem | undefined>(undefined);
  // State for data pre-filled from Bookmarklet
  const [prefillLink, setPrefillLink] = useState<Partial<LinkItem> | undefined>(undefined);
  
  // Sync State
  const [syncStatus, setSyncStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [authToken, setAuthToken] = useState<string>('');
  const [requiresAuth, setRequiresAuth] = useState<boolean | null>(null); // null表示未检查，true表示需要认证，false表示不需要
  const [hasPassword, setHasPassword] = useState<boolean | null>(null); // 服务器是否设置了密码
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  
  // Sort State
  const [isSortingMode, setIsSortingMode] = useState<string | null>(null); // 存储正在排序的分类ID，null表示不在排序模式
  const [isSortingPinned, setIsSortingPinned] = useState(false); // 是否正在排序置顶链接
  
  // Batch Edit State
  const [isBatchEditMode, setIsBatchEditMode] = useState(false); // 是否处于批量编辑模式
  const [selectedLinks, setSelectedLinks] = useState<Set<string>>(new Set()); // 选中的链接ID集合
  const [batchMoveOpen, setBatchMoveOpen] = useState(false); // 批量移动分类选择器
  
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    link: LinkItem | null;
  }>({
    isOpen: false,
    position: { x: 0, y: 0 },
    link: null
  });
  
  // QR Code Modal State
  const [qrCodeModal, setQrCodeModal] = useState<{
    isOpen: boolean;
    url: string;
    title: string;
  }>({
    isOpen: false,
    url: '',
    title: ''
  });

  // Mobile Search State
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [themeTransition, setThemeTransition] = useState<{
    visible: boolean;
    x: number;
    y: number;
    radius: number;
    targetDark: boolean;
  }>({
    visible: false,
    x: 0,
    y: 0,
    radius: 0,
    targetDark: false,
  });
  
  // Category Action Auth State
  const [categoryActionAuth, setCategoryActionAuth] = useState<{
    isOpen: boolean;
    action: 'edit' | 'delete';
    categoryId: string;
    categoryName: string;
  }>({
    isOpen: false,
    action: 'edit',
    categoryId: '',
    categoryName: ''
  });

  const buildAuthHeaders = (token?: string | null, extraHeaders: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extraHeaders };
    const resolvedToken = token ?? authToken ?? localStorage.getItem(AUTH_KEY);
    const authIssuedAt = localStorage.getItem(AUTH_TIME_KEY);

    if (resolvedToken) {
      headers['x-auth-password'] = resolvedToken;
    }
    if (authIssuedAt) {
      headers['x-auth-issued-at'] = authIssuedAt;
    }

    return headers;
  };

  const clearAuthSession = () => {
    setAuthToken('');
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_TIME_KEY);
  };
  
  // --- Helpers & Sync Logic ---

  // 判断敏感操作是否需要认证：只要服务器设置了密码（hasPassword !== false），就需要认证
  const needsEditAuth = (): boolean => {
    if (hasPassword === null) return true; // 检查未完成，阻止操作
    if (hasPassword && !authToken) return true; // 有密码但未登录
    return false;
  };

  const loadFromLocal = () => {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        let loadedCategories = parsed.categories || DEFAULT_CATEGORIES;
        
        // 确保"常用推荐"分类始终存在，并确保它是第一个分类
        if (!loadedCategories.some(c => c.id === 'common')) {
          loadedCategories = [
            { id: 'common', name: '常用推荐', icon: 'Star' },
            ...loadedCategories
          ];
        } else {
          // 如果"常用推荐"分类已存在，确保它是第一个分类
          const commonIndex = loadedCategories.findIndex(c => c.id === 'common');
          if (commonIndex > 0) {
            const commonCategory = loadedCategories[commonIndex];
            loadedCategories = [
              commonCategory,
              ...loadedCategories.slice(0, commonIndex),
              ...loadedCategories.slice(commonIndex + 1)
            ];
          }
        }

        // 合并默认分类：将 DEFAULT_CATEGORIES 中存在但 loadedCategories 中不存在的分类补充进来
        // 用于升级时补充新的多级子分类
        const loadedIds = new Set(loadedCategories.map(c => c.id));
        const missingDefaults = DEFAULT_CATEGORIES.filter(c => !loadedIds.has(c.id));
        if (missingDefaults.length > 0) {
          loadedCategories = [...loadedCategories, ...missingDefaults];
        }
        
        // 检查是否有链接的categoryId不存在于当前分类中，将这些链接移动到"常用推荐"
        const validCategoryIds = new Set(loadedCategories.map(c => c.id));
        let loadedLinks = parsed.links || INITIAL_LINKS;
        loadedLinks = loadedLinks.map(link => {
          if (!validCategoryIds.has(link.categoryId)) {
            return { ...link, categoryId: 'common' };
          }
          return link;
        });
        
        setLinks(loadedLinks);
        setCategories(loadedCategories);
        // 默认选中第一个顶级分类（移除了"置顶网站"全部分类）
        setSelectedCategory(prev => prev === 'all' ? loadedCategories.find(c => !c.parentId)?.id || 'common' : prev);
      } catch (e) {
        setLinks(INITIAL_LINKS);
        setCategories(DEFAULT_CATEGORIES);
        setSelectedCategory(prev => prev === 'all' ? DEFAULT_CATEGORIES.find(c => !c.parentId)?.id || 'common' : prev);
      }
    } else {
      setLinks(INITIAL_LINKS);
      setCategories(DEFAULT_CATEGORIES);
      setSelectedCategory(prev => prev === 'all' ? DEFAULT_CATEGORIES.find(c => !c.parentId)?.id || 'common' : prev);
    }
  };

  const syncToCloud = async (newLinks: LinkItem[], newCategories: Category[], token: string) => {
    // 本地开发模式：跳过云端同步，仅模拟保存成功状态
    if (IS_DEV) {
      setSyncStatus('saved');
      setTimeout(() => setSyncStatus('idle'), 1500);
      return true;
    }
    setSyncStatus('saving');
    try {
        const response = await fetch('/api/storage', {
            method: 'POST',
            headers: buildAuthHeaders(token, {
                'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ links: newLinks, categories: newCategories })
        });

        if (response.status === 401) {
            // 检查是否是密码过期
            try {
                const errorData = await response.json();
                if (errorData.error && errorData.error.includes('过期')) {
                    alertDialog({ message: '您的密码已过期，请重新登录', variant: 'warning', title: '登录已过期' });
                }
            } catch (e) {
                // 如果无法解析错误信息，使用默认提示
                console.error('Failed to parse error response', e);
            }
            
            setAuthToken('');
            localStorage.removeItem(AUTH_KEY);
            setIsAuthOpen(true);
            setSyncStatus('error');
            return false;
        }

        if (!response.ok) throw new Error('Network response was not ok');
        
        setSyncStatus('saved');
        setTimeout(() => setSyncStatus('idle'), 2000);
        return true;
    } catch (error) {
        console.error("Sync failed", error);
        setSyncStatus('error');
        return false;
    }
  };

  const updateData = (newLinks: LinkItem[], newCategories: Category[]) => {
      // 1. Optimistic UI Update
      setLinks(newLinks);
      setCategories(newCategories);
      
      // 2. Save to Local Cache
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ links: newLinks, categories: newCategories }));

      // 3. Sync to Cloud (if authenticated)
      if (authToken) {
          syncToCloud(newLinks, newCategories, authToken);
      }
  };

  const requireAuth = () => {
    // 本地开发模式：无需鉴权，直接放行
    if (IS_DEV) return true;
    if (needsEditAuth()) {
      setIsAuthOpen(true);
      return false;
    }
    return true;
  };

  // --- Context Menu Functions ---
  const handleContextMenu = (event: React.MouseEvent, link: LinkItem) => {
    event.preventDefault();
    event.stopPropagation();

    // 在批量编辑模式下或未登录时禁用右键菜单
    if (isBatchEditMode || needsEditAuth()) return;
    
    setContextMenu({
      isOpen: true,
      position: { x: event.clientX, y: event.clientY },
      link: link
    });
  };

  const closeContextMenu = () => {
    setContextMenu({
      isOpen: false,
      position: { x: 0, y: 0 },
      link: null
    });
  };

  const copyLinkToClipboard = () => {
    if (!contextMenu.link) return;
    
    navigator.clipboard.writeText(contextMenu.link.url)
      .then(() => {
        // 可以添加一个短暂的提示
        console.log('链接已复制到剪贴板');
      })
      .catch(err => {
        console.error('复制链接失败:', err);
      });
    
    closeContextMenu();
  };

  const showQRCode = () => {
    if (!contextMenu.link) return;
    
    setQrCodeModal({
      isOpen: true,
      url: contextMenu.link.url,
      title: contextMenu.link.title
    });
    
    closeContextMenu();
  };

  const editLinkFromContextMenu = () => {
    if (!contextMenu.link) return;
    if (!requireAuth()) return;
    
    setEditingLink(contextMenu.link);
    setIsModalOpen(true);
    closeContextMenu();
  };

  const deleteLinkFromContextMenu = async () => {
    if (!contextMenu.link) return;
    if (!requireAuth()) return;

    const ok = await confirmDialog({
      title: '删除链接',
      message: `确定要删除"${contextMenu.link.title}"吗？`,
      variant: 'danger',
      confirmText: '删除',
    });
    if (ok) {
      const newLinks = links.filter(link => link.id !== contextMenu.link!.id);
      updateData(newLinks, categories);
    }
    
    closeContextMenu();
  };

  const togglePinFromContextMenu = () => {
    if (!contextMenu.link) return;
    if (!requireAuth()) return;
    
    const linkToToggle = links.find(l => l.id === contextMenu.link!.id);
    if (!linkToToggle) return;
    
    // 如果是设置为置顶，则设置pinnedOrder为当前置顶链接数量
    // 如果是取消置顶，则清除pinnedOrder
    const updated = links.map(l => {
      if (l.id === contextMenu.link!.id) {
        const isPinned = !l.pinned;
        return { 
          ...l, 
          pinned: isPinned,
          pinnedOrder: isPinned ? links.filter(link => link.pinned).length : undefined
        };
      }
      return l;
    });
    
    updateData(updated, categories);
    closeContextMenu();
  };

  const toggleFavoriteFromContextMenu = () => {
    if (!contextMenu.link) return;
    toggleFavorite(contextMenu.link.id);
    closeContextMenu();
  };

  // 加载链接图标缓存
  const loadLinkIcons = async (linksToLoad: LinkItem[], categoriesToUse: Category[]) => {
    if (!authToken) return; // 只有在已登录状态下才加载图标缓存
    
    const updatedLinks = [...linksToLoad];
    const domainsToFetch = new Set<string>();
    
    // 收集所有链接的域名（包括已有图标的链接）
    for (const link of updatedLinks) {
      if (link.url) {
        try {
          let domain = link.url;
          if (!link.url.startsWith('http://') && !link.url.startsWith('https://')) {
            domain = 'https://' + link.url;
          }
          
          if (domain.startsWith('http://') || domain.startsWith('https://')) {
            const urlObj = new URL(domain);
            domain = urlObj.hostname;
            if (!link.icon || !link.icon.startsWith('data:')) {
              domainsToFetch.add(domain);
            }
          }
        } catch (e) {
          console.error("Failed to parse URL for icon loading", e);
        }
      }
    }
    
    // 批量获取图标
    if (domainsToFetch.size > 0) {
      const iconPromises = Array.from(domainsToFetch).map(async (domain) => {
        try {
          const response = await fetch(`/api/storage?getConfig=favicon&domain=${encodeURIComponent(domain)}&fetch=true`);
          if (response.ok) {
            const data = await response.json();
            if (data.cached && data.icon) {
              return { domain, icon: data.icon };
            }
          }
        } catch (error) {
          console.log(`Failed to fetch cached icon for ${domain}`, error);
        }
        return null;
      });
      
      const iconResults = await Promise.all(iconPromises);
      
      // 更新链接的图标
      let hasChanges = false;

      iconResults.forEach(result => {
        if (result) {
          updatedLinks.forEach(linkToUpdate => {
            if (!linkToUpdate.url) return;

            try {
              let domain = linkToUpdate.url;
              if (!linkToUpdate.url.startsWith('http://') && !linkToUpdate.url.startsWith('https://')) {
                domain = 'https://' + linkToUpdate.url;
              }

              if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
                return;
              }

              const urlObj = new URL(domain);
              if (urlObj.hostname !== result.domain) {
                return;
              }

              if (linkToUpdate.icon !== result.icon) {
                linkToUpdate.icon = result.icon;
                hasChanges = true;
              }
            } catch (e) {
              return;
            }
          });
        }
      });
      
      if (hasChanges) {
        setLinks(updatedLinks);
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ links: updatedLinks, categories: categoriesToUse }));
        syncToCloud(updatedLinks, categoriesToUse, authToken);
      }
    }
  };

  // --- Effects ---

  useEffect(() => {
    // Theme init
    if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      setDarkMode(true);
      document.documentElement.classList.add('dark');
    }

    // Load Token and check expiry
    const savedToken = localStorage.getItem(AUTH_KEY);
    const lastLoginTime = localStorage.getItem(AUTH_TIME_KEY);
    
    if (savedToken) {
      const currentTime = Date.now();
      
      if (lastLoginTime) {
        const lastLogin = parseInt(lastLoginTime);
        const timeDiff = currentTime - lastLogin;
        
        const expiryDays = siteSettings.passwordExpiryDays || 7;
        const expiryTimeMs = expiryDays > 0 ? expiryDays * 24 * 60 * 60 * 1000 : 0;
        
        if (expiryTimeMs > 0 && timeDiff > expiryTimeMs) {
          clearAuthSession();
        } else {
          setAuthToken(savedToken);
        }
      } else {
        setAuthToken(savedToken);
      }
    }

    // Load WebDAV Config
    const savedWebDav = localStorage.getItem(WEBDAV_CONFIG_KEY);
    if (savedWebDav) {
        try {
            setWebDavConfig(JSON.parse(savedWebDav));
        } catch (e) {}
    }

    // Handle URL Params for Bookmarklet (Add Link)
    const urlParams = new URLSearchParams(window.location.search);
    const addUrl = urlParams.get('add_url');
    if (addUrl) {
        const addTitle = urlParams.get('add_title') || '';
        // Clean URL params to avoid re-triggering on refresh
        window.history.replaceState({}, '', window.location.pathname);
        
        setPrefillLink({
            title: addTitle,
            url: addUrl,
            categoryId: 'common' // Default, Modal will handle selection
        });
        setEditingLink(undefined);
        if (savedToken) {
            setIsModalOpen(true);
        } else {
            setIsAuthOpen(true);
        }
    }

    // Initial Data Fetch
    const initData = async () => {
        // 本地开发模式：跳过所有 Cloudflare API 调用与密码验证，直接加载本地数据
        if (IS_DEV) {
            setRequiresAuth(false);
            loadFromLocal();
            setSearchMode('internal');
            setExternalSearchSources([
                { id: 'bing', name: '必应', url: 'https://www.bing.com/search?q={query}', icon: 'Search', enabled: true, createdAt: Date.now() },
                { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}', icon: 'Search', enabled: true, createdAt: Date.now() },
                { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={query}', icon: 'Globe', enabled: true, createdAt: Date.now() }
            ]);
            setIsLoadingSearchConfig(false);
            setIsCheckingAuth(false);
            return;
        }

        // 首先检查是否需要认证
        try {
            const authRes = await fetch('/api/storage?checkAuth=true');
            if (authRes.ok) {
                const authData = await authRes.json();
                setRequiresAuth(authData.requiresAuth);
                setHasPassword(authData.hasPassword);
                if (authData.hasPassword && savedToken) {
                    const validateRes = await fetch('/api/storage', {
                        method: 'POST',
                        headers: buildAuthHeaders(savedToken, {
                            'Content-Type': 'application/json',
                        }),
                        body: JSON.stringify({ authOnly: true })
                    });

                    if (!validateRes.ok) {
                        clearAuthSession();
                    } else {
                        const validateData = await validateRes.json();
                        if (validateData?.authenticatedAt) {
                            localStorage.setItem(AUTH_TIME_KEY, String(validateData.authenticatedAt));
                            setAuthToken(savedToken);
                        }
                    }
                }
                // 首页开放访问，不再因为 requiresAuth 阻止数据加载
            }
        } catch (e) {
            console.warn("Failed to check auth requirement.", e);
        }
        
        // 获取数据
        let hasCloudData = false;
        try {
            const res = await fetch('/api/storage', {
                headers: authToken ? buildAuthHeaders(authToken) : {}
            });
            if (res.ok) {
                const data = await res.json();
                if (data.links && data.links.length > 0) {
                    setLinks(data.links);
                    const loadedCats = data.categories || DEFAULT_CATEGORIES;
                    setCategories(loadedCats);
                    setSelectedCategory(prev => prev === 'all' ? loadedCats.find(c => !c.parentId)?.id || 'common' : prev);
                    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
                    
                    // 加载链接图标缓存
                    loadLinkIcons(data.links, loadedCats);
                    hasCloudData = true;
                }
            } else if (res.status === 401) {
                // 如果返回401，可能是密码过期，清除本地token并要求重新登录
                const errorData = await res.json();
                if (errorData.error && errorData.error.includes('过期')) {
                    clearAuthSession();
                    setIsAuthOpen(true);
                    setIsCheckingAuth(false);
                    return;
                }
            }
        } catch (e) {
            console.warn("Failed to fetch from cloud, falling back to local.", e);
        }
        
        // 无论是否有云端数据，都尝试从KV空间加载搜索配置和网站配置
        try {
            const searchConfigRes = await fetch('/api/storage?getConfig=search');
            if (searchConfigRes.ok) {
                const searchConfigData = await searchConfigRes.json();
                // 检查搜索配置是否有效（包含必要的字段）
                if (searchConfigData && (searchConfigData.mode || searchConfigData.externalSources || searchConfigData.selectedSource)) {
                    setSearchMode('internal');
                    setExternalSearchSources(searchConfigData.externalSources || []);
                    // 加载已保存的选中搜索源
                    if (searchConfigData.selectedSource) {
                        setSelectedSearchSource(searchConfigData.selectedSource);
                    }
                }
            }
            
            // 获取网站配置（包括密码过期时间设置）
            const websiteConfigRes = await fetch('/api/storage?getConfig=website');
            if (websiteConfigRes.ok) {
                const websiteConfigData = await websiteConfigRes.json();
                if (websiteConfigData) {
                    setSiteSettings(prev => ({
                        ...prev,
                        title: websiteConfigData.title || prev.title,
                        navTitle: websiteConfigData.navTitle || prev.navTitle,
                        favicon: websiteConfigData.favicon || prev.favicon,
                        cardStyle: websiteConfigData.cardStyle || prev.cardStyle,
                        requirePasswordOnVisit: websiteConfigData.requirePasswordOnVisit !== undefined ? websiteConfigData.requirePasswordOnVisit : prev.requirePasswordOnVisit,
                        passwordExpiryDays: websiteConfigData.passwordExpiryDays !== undefined ? websiteConfigData.passwordExpiryDays : prev.passwordExpiryDays
                    }));
                }
            }

            if (savedToken) {
                const webDavConfigRes = await fetch('/api/storage?getConfig=webdav', {
                    headers: buildAuthHeaders(savedToken)
                });
                if (webDavConfigRes.ok) {
                    const webDavConfigData = await webDavConfigRes.json();
                    if (webDavConfigData && (webDavConfigData.url || webDavConfigData.username || webDavConfigData.password || webDavConfigData.enabled !== undefined)) {
                        setWebDavConfig(webDavConfigData);
                        localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(webDavConfigData));
                    }
                }
            }
        } catch (e) {
            console.warn("Failed to fetch configs from KV.", e);
        }
        
        // 如果有云端数据，则不需要加载本地数据
        if (hasCloudData) {
            setIsCheckingAuth(false);
            return;
        }
        
        // 如果没有云端数据，则加载本地数据
        loadFromLocal();
        
        // 如果从KV空间加载搜索配置失败，直接使用默认配置（不使用localStorage回退）
        setSearchMode('internal');
        setExternalSearchSources([
            {
                id: 'bing',
                name: '必应',
                url: 'https://www.bing.com/search?q={query}',
                icon: 'Search',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'google',
                name: 'Google',
                url: 'https://www.google.com/search?q={query}',
                icon: 'Search',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'baidu',
                name: '百度',
                url: 'https://www.baidu.com/s?wd={query}',
                icon: 'Globe',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'sogou',
                name: '搜狗',
                url: 'https://www.sogou.com/web?query={query}',
                icon: 'Globe',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'yandex',
                name: 'Yandex',
                url: 'https://yandex.com/search/?text={query}',
                icon: 'Globe',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'github',
                name: 'GitHub',
                url: 'https://github.com/search?q={query}',
                icon: 'Github',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'linuxdo',
                name: 'Linux.do',
                url: 'https://linux.do/search?q={query}',
                icon: 'Terminal',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'bilibili',
                name: 'B站',
                url: 'https://search.bilibili.com/all?keyword={query}',
                icon: 'Play',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'youtube',
                name: 'YouTube',
                url: 'https://www.youtube.com/results?search_query={query}',
                icon: 'Video',
                enabled: true,
                createdAt: Date.now()
            },
            {
                id: 'wikipedia',
                name: '维基',
                url: 'https://zh.wikipedia.org/wiki/Special:Search?search={query}',
                icon: 'BookOpen',
                enabled: true,
                createdAt: Date.now()
            }
        ]);
        
        setIsLoadingSearchConfig(false);
        setIsCheckingAuth(false);
    };

    initData();
  }, []);

  // Update page title and favicon when site settings change
  useEffect(() => {
    if (siteSettings.title) {
      document.title = siteSettings.title;
    }
    
    const updateFavicon = async () => {
      if (!siteSettings.favicon) return;

      const roundedFavicon = await createRoundedFavicon(siteSettings.favicon);
      const existingFavicons = document.querySelectorAll('link[rel="icon"]');
      existingFavicons.forEach(favicon => favicon.remove());

      const favicon = document.createElement('link');
      favicon.rel = 'icon';
      favicon.href = roundedFavicon;
      document.head.appendChild(favicon);
    };

    updateFavicon();
  }, [siteSettings.title, siteSettings.favicon]);

  useEffect(() => {
    return () => {
      if (themeTransitionTimerRef.current) {
        window.clearTimeout(themeTransitionTimerRef.current);
      }
    };
  }, []);

  const applyThemeMode = (newMode: boolean) => {
    setDarkMode(newMode);
    if (newMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  };

  const toggleTheme = () => {
    const newMode = !darkMode;
    const rect = themeButtonRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 48;
    const y = rect ? rect.top + rect.height / 2 : 32;
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    if (themeTransitionTimerRef.current) {
      window.clearTimeout(themeTransitionTimerRef.current);
    }

    setThemeTransition({
      visible: true,
      x,
      y,
      radius: 0,
      targetDark: newMode,
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setThemeTransition({
          visible: true,
          x,
          y,
          radius,
          targetDark: newMode,
        });
      });
    });

    themeTransitionTimerRef.current = window.setTimeout(() => {
      applyThemeMode(newMode);
      setThemeTransition(prev => ({
        ...prev,
        visible: false,
        radius: 0,
      }));
      themeTransitionTimerRef.current = null;
    }, 620);
  };

  // 视图模式切换处理函数
  const handleViewModeChange = (cardStyle: 'detailed' | 'simple') => {
    const newSiteSettings = { ...siteSettings, cardStyle };
    setSiteSettings(newSiteSettings);
    localStorage.setItem('cloudnav_site_settings', JSON.stringify(newSiteSettings));
  };

  // --- Batch Edit Functions ---
  const toggleBatchEditMode = () => {
    if (!requireAuth()) return;
    setIsBatchEditMode(!isBatchEditMode);
    setSelectedLinks(new Set()); // 退出批量编辑模式时清空选中项
  };

  const toggleLinkSelection = (linkId: string) => {
    setSelectedLinks(prev => {
      const newSet = new Set(prev);
      if (newSet.has(linkId)) {
        newSet.delete(linkId);
      } else {
        newSet.add(linkId);
      }
      return newSet;
    });
  };

  const handleBatchDelete = async () => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }

    if (selectedLinks.size === 0) {
      alertDialog({ message: '请先选择要删除的链接', variant: 'warning' });
      return;
    }

    const ok = await confirmDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${selectedLinks.size} 个链接吗？`,
      variant: 'danger',
      confirmText: '删除',
    });
    if (ok) {
      const newLinks = links.filter(link => !selectedLinks.has(link.id));
      updateData(newLinks, categories);
      setSelectedLinks(new Set());
      setIsBatchEditMode(false);
    }
  };

  const handleBatchMove = (targetCategoryId: string) => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }

    if (selectedLinks.size === 0) {
      alertDialog({ message: '请先选择要移动的链接', variant: 'warning' });
      return;
    }
    
    const newLinks = links.map(link => 
      selectedLinks.has(link.id) ? { ...link, categoryId: targetCategoryId } : link
    );
    updateData(newLinks, categories);
    setSelectedLinks(new Set());
    setIsBatchEditMode(false);
    setBatchMoveOpen(false);
  };

  const handleSelectAll = () => {
    // 获取当前显示的所有链接ID
    const currentLinkIds = displayedLinks.map(link => link.id);
    
    // 如果已选中的链接数量等于当前显示的链接数量，则取消全选
    if (selectedLinks.size === currentLinkIds.length && currentLinkIds.every(id => selectedLinks.has(id))) {
      setSelectedLinks(new Set());
    } else {
      // 否则全选当前显示的所有链接
      setSelectedLinks(new Set(currentLinkIds));
    }
  };

  // --- Actions ---

  const handleLogin = async (password: string): Promise<boolean> => {
      try {
        // 首先验证密码
        const authResponse = await fetch('/api/storage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-auth-password': password
            },
            body: JSON.stringify({ authOnly: true }) // 只用于验证密码，不更新数据
        });
        
        if (authResponse.ok) {
            const authPayload = await authResponse.json();
            setAuthToken(password);
            localStorage.setItem(AUTH_KEY, password);
            setIsAuthOpen(false);
            setSyncStatus('saved');
            
            // 登录成功后，获取网站配置（包括密码过期时间设置）
            try {
                const websiteConfigRes = await fetch('/api/storage?getConfig=website');
                if (websiteConfigRes.ok) {
                    const websiteConfigData = await websiteConfigRes.json();
                    if (websiteConfigData) {
                        setSiteSettings(prev => ({
                            ...prev,
                            title: websiteConfigData.title || prev.title,
                            navTitle: websiteConfigData.navTitle || prev.navTitle,
                            favicon: websiteConfigData.favicon || prev.favicon,
                            cardStyle: websiteConfigData.cardStyle || prev.cardStyle,
                            requirePasswordOnVisit: websiteConfigData.requirePasswordOnVisit !== undefined ? websiteConfigData.requirePasswordOnVisit : prev.requirePasswordOnVisit,
                            passwordExpiryDays: websiteConfigData.passwordExpiryDays !== undefined ? websiteConfigData.passwordExpiryDays : prev.passwordExpiryDays
                        }));
                    }
                }
            } catch (e) {
                console.warn("Failed to fetch website config after login.", e);
            }
            
            // 检查密码是否过期
            const lastLoginTime = localStorage.getItem(AUTH_TIME_KEY);
            const currentTime = Date.now();
            
            if (lastLoginTime) {
                const lastLogin = parseInt(lastLoginTime);
                const timeDiff = currentTime - lastLogin;
                
                const expiryTimeMs = (siteSettings.passwordExpiryDays || 7) > 0 ? (siteSettings.passwordExpiryDays || 7) * 24 * 60 * 60 * 1000 : 0;
                
                if (expiryTimeMs > 0 && timeDiff > expiryTimeMs) {
                    clearAuthSession();
                    setIsAuthOpen(true);
                    alertDialog({ message: '您的密码已过期，请重新登录', variant: 'warning', title: '登录已过期' });
                    return false;
                }
            }
            
            localStorage.setItem(AUTH_TIME_KEY, String(authPayload.authenticatedAt || currentTime));
            
            // 登录成功后，从服务器获取数据
            try {
                const res = await fetch('/api/storage', {
                    headers: buildAuthHeaders(password)
                });
                if (res.ok) {
                    const data = await res.json();
                    // 如果服务器有数据，使用服务器数据
                    if (data.links && data.links.length > 0) {
                        setLinks(data.links);
                        const loadedCats = data.categories || DEFAULT_CATEGORIES;
                        setCategories(loadedCats);
                        setSelectedCategory(prev => prev === 'all' ? loadedCats.find(c => !c.parentId)?.id || 'common' : prev);
                        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
                        
                        // 加载链接图标缓存
                        loadLinkIcons(data.links, loadedCats);
                    } else {
                        // 如果服务器没有数据，使用本地数据
                        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ links, categories }));
                        // 并将本地数据同步到服务器
                        syncToCloud(links, categories, password);
                        
                        // 加载链接图标缓存
                        loadLinkIcons(links, categories);
                    }
                } 
            } catch (e) {
                console.warn("Failed to fetch data after login.", e);
                loadFromLocal();
                // 尝试将本地数据同步到服务器
                syncToCloud(links, categories, password);
            }
            
            // 登录成功后，从KV空间加载AI配置
            try {
                const aiConfigRes = await fetch('/api/storage?getConfig=ai', {
                    headers: buildAuthHeaders(password)
                });
                if (aiConfigRes.ok) {
                    const aiConfigData = await aiConfigRes.json();
                    if (aiConfigData && Object.keys(aiConfigData).length > 0) {
                        setAiConfig(aiConfigData);
                        localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfigData));
                    }
                }
            } catch (e) {
                console.warn("Failed to fetch AI config after login.", e);
            }

            try {
                const webDavConfigRes = await fetch('/api/storage?getConfig=webdav', {
                    headers: buildAuthHeaders(password)
                });
                if (webDavConfigRes.ok) {
                    const webDavConfigData = await webDavConfigRes.json();
                    if (webDavConfigData && (webDavConfigData.url || webDavConfigData.username || webDavConfigData.password || webDavConfigData.enabled !== undefined)) {
                        setWebDavConfig(webDavConfigData);
                        localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(webDavConfigData));
                    }
                }
            } catch (e) {
                console.warn("Failed to fetch WebDAV config after login.", e);
            }

            if (pendingProtectedCategoryId) {
                // 多级导航：登录成功后，优先选中用户原本想点击的子分类
                setSelectedCategory(pendingSelectCategoryId || pendingProtectedCategoryId);
                setPendingProtectedCategoryId(null);
                setPendingSelectCategoryId(null);
            }
            
            return true;
        }
        return false;
      } catch (e) {
          return false;
      }
  };

  const handleLogout = () => {
      clearAuthSession();
      setPendingProtectedCategoryId(null);
      setSyncStatus('offline');
      // 退出后重新加载本地数据
      loadFromLocal();
  };

  // 分类操作密码验证处理函数
  const handleCategoryActionAuth = async (password: string): Promise<boolean> => {
    // 本地开发模式：直接通过，无需密码
    if (IS_DEV) return true;
    try {
      // 验证密码
      const authResponse = await fetch('/api/storage', {
        method: 'POST',
        headers: buildAuthHeaders(password, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ authOnly: true })
      });
      
      return authResponse.ok;
    } catch (error) {
      console.error('Category action auth error:', error);
      return false;
    }
  };

  // 打开分类操作验证弹窗
  const openCategoryActionAuth = (action: 'edit' | 'delete', categoryId: string, categoryName: string) => {
    setCategoryActionAuth({
      isOpen: true,
      action,
      categoryId,
      categoryName
    });
  };

  // 关闭分类操作验证弹窗
  const closeCategoryActionAuth = () => {
    setCategoryActionAuth({
      isOpen: false,
      action: 'edit',
      categoryId: '',
      categoryName: ''
    });
  };

  const handleImportConfirm = (newLinks: LinkItem[], newCategories: Category[]) => {
      // Merge categories: Avoid duplicate names/IDs
      const mergedCategories = [...categories];
      
      // 确保"常用推荐"分类始终存在
      if (!mergedCategories.some(c => c.id === 'common')) {
        mergedCategories.push({ id: 'common', name: '常用推荐', icon: 'Star' });
      }
      
      newCategories.forEach(nc => {
          if (!mergedCategories.some(c => c.id === nc.id || c.name === nc.name)) {
              mergedCategories.push(nc);
          }
      });

      const mergedLinks = [...links, ...newLinks];
      updateData(mergedLinks, mergedCategories);
      setIsImportModalOpen(false);
      alertDialog({ message: `成功导入 ${newLinks.length} 个新书签!`, variant: 'success', title: '导入完成' });
  };

  const handleAddLink = (data: Omit<LinkItem, 'id' | 'createdAt'>) => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    
    // 处理URL，确保有协议前缀
    let processedUrl = data.url;
    if (processedUrl && !processedUrl.startsWith('http://') && !processedUrl.startsWith('https://')) {
      processedUrl = 'https://' + processedUrl;
    }
    
    // 获取当前分类下的所有链接（不包括置顶链接）
    const categoryLinks = links.filter(link => 
      !link.pinned && (data.categoryId === 'all' || link.categoryId === data.categoryId)
    );
    
    // 计算新链接的order值，使其排在分类最后
    const maxOrder = categoryLinks.length > 0 
      ? Math.max(...categoryLinks.map(link => link.order || 0))
      : -1;
    
    const newLink: LinkItem = {
      ...data,
      url: processedUrl, // 使用处理后的URL
      id: Date.now().toString(),
      createdAt: Date.now(),
      order: maxOrder + 1, // 设置为当前分类的最大order值+1，确保排在最后
      // 如果是置顶链接，设置pinnedOrder为当前置顶链接数量
      pinnedOrder: data.pinned ? links.filter(l => l.pinned).length : undefined
    };
    
    // 将新链接插入到合适的位置，而不是直接放在开头
    // 如果是置顶链接，放在置顶链接区域的最后
    if (newLink.pinned) {
      const firstNonPinnedIndex = links.findIndex(link => !link.pinned);
      if (firstNonPinnedIndex === -1) {
        // 如果没有非置顶链接，直接添加到末尾
        updateData([...links, newLink], categories);
      } else {
        // 插入到非置顶链接之前
        const updatedLinks = [...links];
        updatedLinks.splice(firstNonPinnedIndex, 0, newLink);
        updateData(updatedLinks, categories);
      }
    } else {
      // 非置顶链接，按照order字段排序后插入
      const updatedLinks = [...links, newLink].sort((a, b) => {
        // 置顶链接始终排在前面
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        
        // 同类型链接按照order排序
        const aOrder = a.order !== undefined ? a.order : a.createdAt;
        const bOrder = b.order !== undefined ? b.order : b.createdAt;
        return aOrder - bOrder;
      });
      updateData(updatedLinks, categories);
    }
    
    // Clear prefill if any
    setPrefillLink(undefined);
  };

  const handleEditLink = (data: Omit<LinkItem, 'id' | 'createdAt'>) => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    if (!editingLink) return;
    
    // 处理URL，确保有协议前缀
    let processedUrl = data.url;
    if (processedUrl && !processedUrl.startsWith('http://') && !processedUrl.startsWith('https://')) {
      processedUrl = 'https://' + processedUrl;
    }
    
    const updated = links.map(l => l.id === editingLink.id ? { ...l, ...data, url: processedUrl } : l);
    updateData(updated, categories);
    setEditingLink(undefined);
  };

  // 拖拽结束事件处理函数
  const handleDragEnd = (event: DragEndEvent) => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    const { active, over } = event;

    if (over && active.id !== over.id) {
      // 获取当前分类下的所有链接
      const categoryLinks = links.filter(link => 
        selectedCategory === 'all' || link.categoryId === selectedCategory
      );
      
      // 找到被拖拽元素和目标元素的索引
      const activeIndex = categoryLinks.findIndex(link => link.id === active.id);
      const overIndex = categoryLinks.findIndex(link => link.id === over.id);
      
      if (activeIndex !== -1 && overIndex !== -1) {
        // 重新排序当前分类的链接
        const reorderedCategoryLinks = arrayMove(categoryLinks, activeIndex, overIndex);
        
        // 更新所有链接的顺序
        const updatedLinks = links.map(link => {
          const reorderedIndex = reorderedCategoryLinks.findIndex(l => l.id === link.id);
          if (reorderedIndex !== -1) {
            return { ...link, order: reorderedIndex };
          }
          return link;
        });
        
        // 按照order字段重新排序
        updatedLinks.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        updateData(updatedLinks, categories);
      }
    }
  };

  // 置顶链接拖拽结束事件处理函数
  const handlePinnedDragEnd = (event: DragEndEvent) => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    const { active, over } = event;

    if (over && active.id !== over.id) {
      // 获取所有置顶链接
      const pinnedLinksList = links.filter(link => link.pinned);
      
      // 找到被拖拽元素和目标元素的索引
      const activeIndex = pinnedLinksList.findIndex(link => link.id === active.id);
      const overIndex = pinnedLinksList.findIndex(link => link.id === over.id);
      
      if (activeIndex !== -1 && overIndex !== -1) {
        // 重新排序置顶链接
        const reorderedPinnedLinks = arrayMove(pinnedLinksList, activeIndex, overIndex);
        
        // 创建一个映射，存储每个置顶链接的新pinnedOrder
        const pinnedOrderMap = new Map<string, number>();
        reorderedPinnedLinks.forEach((link, index) => {
          pinnedOrderMap.set(link.id, index);
        });
        
        // 只更新置顶链接的pinnedOrder，不改变任何链接的顺序
        const updatedLinks = links.map(link => {
          if (link.pinned) {
            return { 
              ...link, 
              pinnedOrder: pinnedOrderMap.get(link.id) 
            };
          }
          return link;
        });
        
        // 按照pinnedOrder重新排序整个链接数组，确保置顶链接的顺序正确
        // 同时保持非置顶链接的相对顺序不变
        updatedLinks.sort((a, b) => {
          // 如果都是置顶链接，按照pinnedOrder排序
          if (a.pinned && b.pinned) {
            return (a.pinnedOrder || 0) - (b.pinnedOrder || 0);
          }
          // 如果只有一个是置顶链接，置顶链接排在前面
          if (a.pinned) return -1;
          if (b.pinned) return 1;
          // 如果都不是置顶链接，保持原位置不变（按照order或createdAt排序）
          const aOrder = a.order !== undefined ? a.order : a.createdAt;
          const bOrder = b.order !== undefined ? b.order : b.createdAt;
          return bOrder - aOrder;
        });
        
        updateData(updatedLinks, categories);
      }
    }
  };

  // 开始排序
  const startSorting = (categoryId: string) => {
    if (!requireAuth()) return;
    setIsSortingMode(categoryId);
  };

  // 保存排序
  const saveSorting = () => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    // 在保存排序时，确保将当前排序后的数据保存到服务器和本地存储
    updateData(links, categories);
    setIsSortingMode(null);
  };

  // 取消排序
  const cancelSorting = () => {
    setIsSortingMode(null);
  };

  // 保存置顶链接排序
  const savePinnedSorting = () => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    // 在保存排序时，确保将当前排序后的数据保存到服务器和本地存储
    updateData(links, categories);
    setIsSortingPinned(false);
  };

  // 取消置顶链接排序
  const cancelPinnedSorting = () => {
    setIsSortingPinned(false);
  };

  // 设置dnd-kit的传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 需要拖动8px才开始拖拽，避免误触
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDeleteLink = async (id: string) => {
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    const ok = await confirmDialog({
      title: '删除链接',
      message: '确定删除此链接吗?',
      variant: 'danger',
      confirmText: '删除',
    });
    if (ok) {
      updateData(links.filter(l => l.id !== id), categories);
    }
  };

  const togglePin = (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (needsEditAuth()) { setIsAuthOpen(true); return; }
      
      const linkToToggle = links.find(l => l.id === id);
      if (!linkToToggle) return;
      
      // 如果是设置为置顶，则设置pinnedOrder为当前置顶链接数量
      // 如果是取消置顶，则清除pinnedOrder
      const updated = links.map(l => {
        if (l.id === id) {
          const isPinned = !l.pinned;
          return { 
            ...l, 
            pinned: isPinned,
            pinnedOrder: isPinned ? links.filter(link => link.pinned).length : undefined
          };
        }
        return l;
      });
      
      updateData(updated, categories);
  };

  // 切换收藏（常用推荐标记），不改变链接的原分类归属
  const toggleFavorite = (id: string, e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (needsEditAuth()) { setIsAuthOpen(true); return; }
    const updated = links.map(l =>
      l.id === id ? { ...l, favorite: !l.favorite } : l
    );
    updateData(updated, categories);
  };

  const handleSaveAIConfig = async (config: AIConfig, newSiteSettings?: any) => {
      setAiConfig(config);
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
      
      if (newSiteSettings) {
          setSiteSettings(newSiteSettings);
          localStorage.setItem('cloudnav_site_settings', JSON.stringify(newSiteSettings));
      }
      
      if (authToken) {
          try {
              const response = await fetch('/api/storage', {
                  method: 'POST',
                  headers: buildAuthHeaders(authToken, {
                      'Content-Type': 'application/json',
                  }),
                  body: JSON.stringify({
                      saveConfig: 'ai',
                      config: config
                  })
              });
              
              if (!response.ok) {
                  console.error('Failed to save AI config to KV:', response.statusText);
              }
          } catch (error) {
              console.error('Error saving AI config to KV:', error);
          }
          
          if (newSiteSettings) {
              try {
                  const response = await fetch('/api/storage', {
                      method: 'POST',
                      headers: buildAuthHeaders(authToken, {
                          'Content-Type': 'application/json',
                      }),
                      body: JSON.stringify({
                          saveConfig: 'website',
                          config: newSiteSettings
                      })
                  });
                  
                  if (!response.ok) {
                      console.error('Failed to save website config to KV:', response.statusText);
                  }
              } catch (error) {
                  console.error('Error saving website config to KV:', error);
              }
          }
      }
  };

  const handleRestoreAIConfig = async (config: AIConfig) => {
      setAiConfig(config);
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
      
      // 同时保存到KV空间
      if (authToken) {
          try {
              const response = await fetch('/api/storage', {
                  method: 'POST',
                  headers: buildAuthHeaders(authToken, {
                      'Content-Type': 'application/json',
                  }),
                  body: JSON.stringify({
                      saveConfig: 'ai',
                      config: config
                  })
              });
              
              if (!response.ok) {
                  console.error('Failed to restore AI config to KV:', response.statusText);
              }
          } catch (error) {
              console.error('Error restoring AI config to KV:', error);
          }
      }
  };

  // --- Category Management & Security ---

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem('cloudnav_sidebar_collapsed', String(next));
      return next;
    });
  };

  const handleCategoryClick = (cat: Category) => {
      // 本地开发模式：直接选中分类，不做任何鉴权
      if (IS_DEV) {
        setSelectedCategory(cat.id);
        setSidebarOpen(false);
        return;
      }
      // 多级导航：检查祖先链上是否有需要解锁的分类
      // 找到最近一个被锁定的祖先（含自身），优先处理它
      const ancestorIds = getAncestorIds(categories, cat.id);
      let lockedAncestor: Category | null = null;
      for (const id of ancestorIds) {
        const ancestor = categories.find(c => c.id === id);
        if (!ancestor) continue;
        if (ancestor.requireAuth && !authToken) {
          // requireAuth 走全站密码流程
          setPendingProtectedCategoryId(id);
          // 如果用户点击的不是被锁定的祖先本身，记录用户原本想点击的分类
          setPendingSelectCategoryId(cat.id !== id ? cat.id : null);
          setIsAuthOpen(true);
          setSidebarOpen(false);
          return;
        }
        if (ancestor.password && !unlockedCategoryIds.has(id)) {
          lockedAncestor = ancestor;
          break;
        }
      }

      if (lockedAncestor) {
          // 记录用户原本想点击的子分类（如果不是被锁定的祖先本身）
          setPendingSelectCategoryId(cat.id !== lockedAncestor.id ? cat.id : null);
          setCatAuthModalData(lockedAncestor);
          setSidebarOpen(false);
          return;
      }
      setSelectedCategory(cat.id);
      setSidebarOpen(false);
  };

  const handleUnlockCategory = (catId: string) => {
      setUnlockedCategoryIds(prev => new Set(prev).add(catId));
      // 多级导航：解锁祖先后，如果有用户原本想点击的子分类，选中它
      setSelectedCategory(pendingSelectCategoryId || catId);
      setPendingSelectCategoryId(null);
  };

  const handleUpdateCategories = (newCats: Category[]) => {
      if (needsEditAuth()) { setIsAuthOpen(true); return; }
      updateData(links, newCats);
  };

  const handleDeleteCategory = (catId: string) => {
      if (needsEditAuth()) { setIsAuthOpen(true); return; }

      // 防止删除"常用推荐"分类
      if (catId === 'common') {
          alertDialog({ message: '"常用推荐"分类不能被删除', variant: 'warning' });
          return;
      }
      
      // 获取所有子孙分类ID（包括自身）
      const allChildIds = getAllChildIds(categories, catId);
      const idsToDelete = new Set([catId, ...allChildIds]);
      
      let newCats = categories.filter(c => !idsToDelete.has(c.id));
      
      // 检查是否存在"常用推荐"分类，如果不存在则创建它
      if (!newCats.some(c => c.id === 'common')) {
          newCats = [
              { id: 'common', name: '常用推荐', icon: 'Star' },
              ...newCats
          ];
      }
      
      // 将所有被删除分类及其子分类下的链接移动到"常用推荐"
      const targetId = 'common'; 
      const newLinks = links.map(l => idsToDelete.has(l.categoryId) ? { ...l, categoryId: targetId } : l);
      
      updateData(newLinks, newCats);
  };

  // --- WebDAV Config ---
  const handleSaveWebDavConfig = (config: WebDavConfig) => {
      setWebDavConfig(config);
      localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(config));

      if (authToken) {
          fetch('/api/storage', {
              method: 'POST',
              headers: buildAuthHeaders(authToken, {
                  'Content-Type': 'application/json',
              }),
              body: JSON.stringify({
                  saveConfig: 'webdav',
                  config,
              })
          }).catch((error) => {
              console.error('Error saving WebDAV config to KV:', error);
          });
      }
  };

  const handleRestoreWebDavConfig = (config: WebDavConfig) => {
      handleSaveWebDavConfig(config);
  };

  // 搜索源选择弹出窗口状态
  const [showSearchSourcePopup, setShowSearchSourcePopup] = useState(false);
  const [hoveredSearchSource, setHoveredSearchSource] = useState<ExternalSearchSource | null>(null);
  const [selectedSearchSource, setSelectedSearchSource] = useState<ExternalSearchSource | null>(null);
  const [isIconHovered, setIsIconHovered] = useState(false);
  const [isPopupHovered, setIsPopupHovered] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 处理弹出窗口显示/隐藏逻辑
  useEffect(() => {
    if (isIconHovered || isPopupHovered) {
      // 如果图标或弹出窗口被悬停，清除隐藏定时器并显示弹出窗口
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setShowSearchSourcePopup(true);
    } else {
      // 如果图标和弹出窗口都没有被悬停，设置一个延迟隐藏弹出窗口
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      hideTimeoutRef.current = setTimeout(() => {
        setShowSearchSourcePopup(false);
        setHoveredSearchSource(null);
      }, 100);
    }
    
    // 清理函数
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [isIconHovered, isPopupHovered]);

  // 处理搜索源选择
  const handleSearchSourceSelect = async (source: ExternalSearchSource) => {
    // 更新选中的搜索源
    setSelectedSearchSource(source);
    
    // 保存选中的搜索源到KV空间
    await handleSaveSearchConfig(externalSearchSources, searchMode, source);
    
    if (searchQuery.trim()) {
      const searchUrl = source.url.replace('{query}', encodeURIComponent(searchQuery));
      window.open(searchUrl, '_blank');
    }
    setShowSearchSourcePopup(false);
    setHoveredSearchSource(null);
  };

  // --- Search Config ---
  const handleSaveSearchConfig = async (sources: ExternalSearchSource[], mode: SearchMode, selectedSource?: ExternalSearchSource | null, persistToCloud: boolean = true) => {
      const searchConfig: SearchConfig = {
          mode,
          externalSources: sources,
          selectedSource: selectedSource !== undefined ? selectedSource : selectedSearchSource
      };
      
      setExternalSearchSources(sources);
      setSearchMode(mode);
      if (selectedSource !== undefined) {
          setSelectedSearchSource(selectedSource);
      }
      
      // 只保存到KV空间（搜索配置允许无密码访问）
      if (!persistToCloud || !authToken) {
          return;
      }

      try {
          const response = await fetch('/api/storage', {
              method: 'POST',
              headers: buildAuthHeaders(authToken, {
                  'Content-Type': 'application/json'
              }),
              body: JSON.stringify({
                  saveConfig: 'search',
                  config: searchConfig
              })
          });
          
          if (!response.ok) {
              console.error('Failed to save search config to KV:', response.statusText);
          }
      } catch (error) {
          console.error('Error saving search config to KV:', error);
      }
  };

  const openSearchConfigModal = () => {
      if (!requireAuth()) return;
      setIsSearchConfigModalOpen(true);
  };

  const handleSearchConfigModalSave = async (sources: ExternalSearchSource[]) => {
      if (!requireAuth()) return;
      await handleSaveSearchConfig(sources, searchMode, undefined, true);
  };

  const handleSearchModeChange = (mode: SearchMode) => {
      setSearchMode(mode);
      
      // 如果切换到外部搜索模式且搜索源列表为空，自动加载默认搜索源
      if (mode === 'external' && externalSearchSources.length === 0) {
          const defaultSources: ExternalSearchSource[] = [
              {
                  id: 'bing',
                  name: '必应',
                  url: 'https://www.bing.com/search?q={query}',
                  icon: 'Search',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'google',
                  name: 'Google',
                  url: 'https://www.google.com/search?q={query}',
                  icon: 'Search',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'baidu',
                  name: '百度',
                  url: 'https://www.baidu.com/s?wd={query}',
                  icon: 'Globe',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'sogou',
                  name: '搜狗',
                  url: 'https://www.sogou.com/web?query={query}',
                  icon: 'Globe',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'yandex',
                  name: 'Yandex',
                  url: 'https://yandex.com/search/?text={query}',
                  icon: 'Globe',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'github',
                  name: 'GitHub',
                  url: 'https://github.com/search?q={query}',
                  icon: 'Github',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'linuxdo',
                  name: 'Linux.do',
                  url: 'https://linux.do/search?q={query}',
                  icon: 'Terminal',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'bilibili',
                  name: 'B站',
                  url: 'https://search.bilibili.com/all?keyword={query}',
                  icon: 'Play',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'youtube',
                  name: 'YouTube',
                  url: 'https://www.youtube.com/results?search_query={query}',
                  icon: 'Video',
                  enabled: true,
                  createdAt: Date.now()
              },
              {
                  id: 'wikipedia',
                  name: '维基',
                  url: 'https://zh.wikipedia.org/wiki/Special:Search?search={query}',
                  icon: 'BookOpen',
                  enabled: true,
                  createdAt: Date.now()
              }
          ];
          
          // 保存默认搜索源到状态和KV空间
          handleSaveSearchConfig(defaultSources, mode);
      } else {
          handleSaveSearchConfig(externalSearchSources, mode);
      }
  };

  const handleExternalSearch = () => {
      if (searchQuery.trim() && searchMode === 'external') {
          // 如果搜索源列表为空，自动加载默认搜索源
          if (externalSearchSources.length === 0) {
              const defaultSources: ExternalSearchSource[] = [
                  {
                      id: 'bing',
                      name: '必应',
                      url: 'https://www.bing.com/search?q={query}',
                      icon: 'Search',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'google',
                      name: 'Google',
                      url: 'https://www.google.com/search?q={query}',
                      icon: 'Search',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'baidu',
                      name: '百度',
                      url: 'https://www.baidu.com/s?wd={query}',
                      icon: 'Globe',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'sogou',
                      name: '搜狗',
                      url: 'https://www.sogou.com/web?query={query}',
                      icon: 'Globe',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'yandex',
                      name: 'Yandex',
                      url: 'https://yandex.com/search/?text={query}',
                      icon: 'Globe',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'github',
                      name: 'GitHub',
                      url: 'https://github.com/search?q={query}',
                      icon: 'Github',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'linuxdo',
                      name: 'Linux.do',
                      url: 'https://linux.do/search?q={query}',
                      icon: 'Terminal',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'bilibili',
                      name: 'B站',
                      url: 'https://search.bilibili.com/all?keyword={query}',
                      icon: 'Play',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'youtube',
                      name: 'YouTube',
                      url: 'https://www.youtube.com/results?search_query={query}',
                      icon: 'Video',
                      enabled: true,
                      createdAt: Date.now()
                  },
                  {
                      id: 'wikipedia',
                      name: '维基',
                      url: 'https://zh.wikipedia.org/wiki/Special:Search?search={query}',
                      icon: 'BookOpen',
                      enabled: true,
                      createdAt: Date.now()
                  }
              ];
              
              // 保存默认搜索源到状态和KV空间
              handleSaveSearchConfig(defaultSources, 'external');
              
              // 使用第一个默认搜索源立即执行搜索
              const searchUrl = defaultSources[0].url.replace('{query}', encodeURIComponent(searchQuery));
              window.open(searchUrl, '_blank');
              return;
          }
          
          // 如果有选中的搜索源，使用选中的搜索源；否则使用第一个启用的搜索源
          let source = selectedSearchSource;
          if (!source) {
              const enabledSources = externalSearchSources.filter(s => s.enabled);
              if (enabledSources.length > 0) {
                  source = enabledSources[0];
              }
          }
          
          if (source) {
              const searchUrl = source.url.replace('{query}', encodeURIComponent(searchQuery));
              window.open(searchUrl, '_blank');
          }
      }
  };

  const handleRestoreBackup = (restoredLinks: LinkItem[], restoredCategories: Category[]) => {
      updateData(restoredLinks, restoredCategories);
      setIsBackupModalOpen(false);
  };

  const handleRestoreSearchConfig = (restoredSearchConfig: SearchConfig) => {
      handleSaveSearchConfig(restoredSearchConfig.externalSources, restoredSearchConfig.mode);
  };

  // --- Filtering & Memo ---

  const requiresGlobalCategoryAuth = (catId: string) => {
      // 本地开发模式：跳过 requireAuth 检查
      if (IS_DEV) return false;
      // 多级导航：祖先链中任意分类标记 requireAuth 且未登录时，该分类也视为需登录
      const ancestorIds = getAncestorIds(categories, catId);
      return ancestorIds.some(id => {
        const cat = categories.find(c => c.id === id);
        return !!cat?.requireAuth && !authToken;
      });
  };

  // Helper to check if a category is "Locked"
  // 多级导航：分类锁定状态会向子孙传递
  // 如果任意祖先分类被锁定（requireAuth 未通过 或 password 未解锁），该分类也视为锁定
  const isCategoryLocked = (catId: string) => {
      // 本地开发模式：跳过所有分类锁检查
      if (IS_DEV) return false;
      const ancestorIds = getAncestorIds(categories, catId);
      for (const id of ancestorIds) {
        const cat = categories.find(c => c.id === id);
        if (!cat) continue;
        if (cat.requireAuth && !authToken) return true;
        if (cat.password && !unlockedCategoryIds.has(id)) return true;
      }
      return false;
  };

  const pinnedLinks = useMemo(() => {
      // Don't show pinned links if they belong to a locked category
      const filteredPinnedLinks = links.filter(l => l.pinned && !isCategoryLocked(l.categoryId));
      // 按照pinnedOrder字段排序，如果没有pinnedOrder字段则按创建时间排序
      return filteredPinnedLinks.sort((a, b) => {
        // 如果有pinnedOrder字段，则使用pinnedOrder排序
        if (a.pinnedOrder !== undefined && b.pinnedOrder !== undefined) {
          return a.pinnedOrder - b.pinnedOrder;
        }
        // 如果只有一个有pinnedOrder字段，有pinnedOrder的排在前面
        if (a.pinnedOrder !== undefined) return -1;
        if (b.pinnedOrder !== undefined) return 1;
        // 如果都没有pinnedOrder字段，则按创建时间排序
        return a.createdAt - b.createdAt;
      });
  }, [links, categories, unlockedCategoryIds]);

  const displayedLinks = useMemo(() => {
    let result = links;
    
    // Security Filter: Always hide links from locked categories
    result = result.filter(l => !isCategoryLocked(l.categoryId));

    // Search Filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(l => 
        l.title.toLowerCase().includes(q) || 
        l.url.toLowerCase().includes(q) ||
        (l.description && l.description.toLowerCase().includes(q))
      );
    }

    // Category Filter: 严格匹配当前分类，不包含子分类
    // "常用推荐"(common) 分类显示所有被收藏(favorite)的链接
    if (selectedCategory !== 'all') {
      if (selectedCategory === 'common') {
        result = result.filter(l => l.favorite);
      } else {
        result = result.filter(l => l.categoryId === selectedCategory);
      }
    }
    
    // 按照order字段排序，如果没有order字段则按创建时间排序
    // 修改排序逻辑：order值越大排在越前面，新增的卡片order值最大，会排在最前面
    // 我们需要反转这个排序，让新增的卡片(order值最大)排在最后面
    return result.sort((a, b) => {
      const aOrder = a.order !== undefined ? a.order : a.createdAt;
      const bOrder = b.order !== undefined ? b.order : b.createdAt;
      // 改为升序排序，这样order值小(旧卡片)的排在前面，order值大(新卡片)的排在后面
      return aOrder - bOrder;
    });
  }, [links, selectedCategory, searchQuery, categories, unlockedCategoryIds]);

  // 计算其他目录的搜索结果
  const otherCategoryResults = useMemo(() => {
    if (!searchQuery.trim() || selectedCategory === 'all') {
      return [];
    }

    const q = searchQuery.toLowerCase();
    
    // 获取其他目录中匹配的链接
    const otherLinks = links.filter(link => {
      // 排除当前分类的链接（common 分类排除所有已收藏的链接）
      if (selectedCategory === 'common') {
        if (link.favorite) return false;
      } else if (link.categoryId === selectedCategory) {
        return false;
      }
      
      // 排除锁定的目录
      if (isCategoryLocked(link.categoryId)) {
        return false;
      }
      
      // 搜索匹配
      return (
        link.title.toLowerCase().includes(q) || 
        link.url.toLowerCase().includes(q) ||
        (link.description && link.description.toLowerCase().includes(q))
      );
    });

    // 按目录分组
    const groupedByCategory = otherLinks.reduce((acc, link) => {
      if (!acc[link.categoryId]) {
        acc[link.categoryId] = [];
      }
      acc[link.categoryId].push(link);
      return acc;
    }, {} as Record<string, LinkItem[]>);

    // 对每个目录内的链接进行排序
    Object.keys(groupedByCategory).forEach(categoryId => {
      groupedByCategory[categoryId].sort((a, b) => {
        const aOrder = a.order !== undefined ? a.order : a.createdAt;
        const bOrder = b.order !== undefined ? b.order : b.createdAt;
        return aOrder - bOrder;
      });
    });

    return groupedByCategory;
  }, [links, selectedCategory, searchQuery, categories, unlockedCategoryIds]);


  // --- Render Components ---

  // 创建可排序的链接卡片组件
  const SortableLinkCard = ({ link }: { link: LinkItem }) => {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id: link.id });
    
    // 根据视图模式决定卡片样式
    const isDetailedView = siteSettings.cardStyle === 'detailed';
    
    const style = {
      transform: CSS.Transform.toString(transform),
      transition: isDragging ? 'none' : transition,
      opacity: isDragging ? 0.5 : 1,
      zIndex: isDragging ? 1000 : 'auto',
    };

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`group relative transition-all duration-200 cursor-grab active:cursor-grabbing min-w-0 max-w-full overflow-hidden hover:shadow-lg hover:shadow-green-100/50 dark:hover:shadow-green-900/20 ${
          isSortingMode || isSortingPinned
            ? 'bg-green-20 dark:bg-green-900/30 border-green-200 dark:border-green-800' 
            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'
        } ${isDragging ? 'shadow-2xl scale-105' : ''} ${
          isDetailedView 
            ? 'flex flex-col rounded-2xl border shadow-sm p-4 min-h-[100px] hover:border-green-400 dark:hover:border-green-500' 
            : 'flex items-center rounded-xl border shadow-sm hover:border-green-300 dark:hover:border-green-600'
        }`}
        {...attributes}
        {...listeners}
      >
        {/* 已收藏角标 */}
        {link.favorite && (
          <Star
            size={14}
            fill="currentColor"
            className="absolute top-1.5 left-1.5 text-amber-400 z-10 pointer-events-none"
          />
        )}
        {/* 链接内容 - 移除a标签，改为div防止点击跳转 */}
        <div className={`flex flex-1 min-w-0 overflow-hidden ${
          isDetailedView ? 'flex-col' : 'items-center gap-3'
        }`}>
          {/* 第一行：图标和标题水平排列 */}
          <div className={`flex items-center gap-3 mb-2 ${
            isDetailedView ? '' : 'w-full'
          }`}>
            {/* Icon */}
            <div className={`text-blue-600 dark:text-blue-400 flex items-center justify-center text-sm font-bold uppercase shrink-0 ${
              isDetailedView ? 'w-8 h-8 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-700 dark:to-slate-800' : 'w-8 h-8 rounded-lg bg-slate-50 dark:bg-slate-700'
            }`}>
                {link.icon ? <img src={link.icon} alt="" className="w-5 h-5"/> : link.title.charAt(0)}
            </div>
            
            {/* 标题 */}
            <h3 className={`text-slate-900 dark:text-slate-100 truncate overflow-hidden text-ellipsis ${
              isDetailedView ? 'text-base' : 'text-sm font-medium text-slate-800 dark:text-slate-200'
            }`} title={link.title}>
                {link.title}
            </h3>
          </div>
          
          {/* 第二行：描述文字 */}
             {isDetailedView && link.description && (
               <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed line-clamp-2">
                 {link.description}
               </p>
             )}
        </div>
      </div>
    );
  };

  const renderLinkCard = (link: LinkItem) => {
    const isSelected = selectedLinks.has(link.id);
    
    // 根据视图模式决定卡片样式
    const isDetailedView = siteSettings.cardStyle === 'detailed';
    
    return (
      <div
        key={link.id}
        className={`group relative transition-all duration-200 hover:shadow-lg hover:shadow-blue-100/50 dark:hover:shadow-blue-900/20 ${
          isSelected 
            ? 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800' 
            : 'bg-white dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-slate-200 dark:border-slate-700'
        } ${isBatchEditMode ? 'cursor-pointer' : ''} ${
          isDetailedView 
            ? 'flex flex-col rounded-2xl border shadow-sm p-4 min-h-[100px] hover:border-blue-400 dark:hover:border-blue-500' 
            : 'flex items-center justify-between rounded-xl border shadow-sm p-3 hover:border-blue-300 dark:hover:border-blue-600'
        }`}
        onClick={() => isBatchEditMode && toggleLinkSelection(link.id)}
        onContextMenu={(e) => handleContextMenu(e, link)}
      >
        {/* 已收藏角标 */}
        {link.favorite && (
          <Star
            size={14}
            fill="currentColor"
            className="absolute top-1.5 left-1.5 text-amber-400 z-10 pointer-events-none"
          />
        )}
        {/* 链接内容 - 在批量编辑模式下不使用a标签 */}
        {isBatchEditMode ? (
          <div className={`flex flex-1 min-w-0 overflow-hidden h-full ${
            isDetailedView ? 'flex-col' : 'items-center'
          }`}>
            {/* 第一行：图标和标题水平排列 */}
            <div className={`flex items-center gap-3 w-full`}>
              {/* Icon */}
              <div className={`text-blue-600 dark:text-blue-400 flex items-center justify-center text-sm font-bold uppercase shrink-0 ${
                isDetailedView ? 'w-8 h-8 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-700 dark:to-slate-800' : 'w-8 h-8 rounded-lg bg-slate-50 dark:bg-slate-700'
              }`}>
                  {link.icon ? <img src={link.icon} alt="" className="w-5 h-5"/> : link.title.charAt(0)}
              </div>
              
              {/* 标题 */}
              <h3 className={`text-slate-900 dark:text-slate-100 truncate overflow-hidden text-ellipsis ${
                isDetailedView ? 'text-base' : 'text-sm font-medium text-slate-800 dark:text-slate-200'
              }`} title={link.title}>
                  {link.title}
              </h3>
            </div>
            
            {/* 第二行：描述文字 */}
            {isDetailedView && link.description && (
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed line-clamp-2">
                {link.description}
              </p>
            )}
          </div>
        ) : (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex flex-1 min-w-0 overflow-hidden h-full ${
              isDetailedView ? 'flex-col' : 'items-center'
            }`}
            title={isDetailedView ? link.url : (link.description || link.url)} // 详情版视图只显示URL作为tooltip
          >
            {/* 第一行：图标和标题水平排列 */}
            <div className={`flex items-center gap-3 w-full`}>
              {/* Icon */}
              <div className={`text-blue-600 dark:text-blue-400 flex items-center justify-center text-sm font-bold uppercase shrink-0 ${
                isDetailedView ? 'w-8 h-8 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-700 dark:to-slate-800' : 'w-8 h-8 rounded-lg bg-slate-50 dark:bg-slate-700'
              }`}>
                  {link.icon ? <img src={link.icon} alt="" className="w-5 h-5"/> : link.title.charAt(0)}
              </div>
              
              {/* 标题 */}
                <h3 className={`text-slate-800 dark:text-slate-200 truncate whitespace-nowrap overflow-hidden text-ellipsis group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors ${
                  isDetailedView ? 'text-base' : 'text-sm font-medium'
                }`} title={link.title}>
                    {link.title}
                </h3>
            </div>
            
            {/* 第二行：描述文字 */}
              {isDetailedView && link.description && (
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed line-clamp-2">
                  {link.description}
                </p>
              )}
            {!isDetailedView && link.description && (
              <div className="tooltip-custom absolute left-0 -top-8 w-max max-w-[200px] bg-black text-white text-xs p-2 rounded opacity-0 invisible group-hover:visible group-hover:opacity-100 transition-all z-20 pointer-events-none truncate">
                {link.description}
              </div>
            )}
          </a>
        )}

        {/* Hover Actions (Absolute Right) - 在批量编辑模式下隐藏，未登录时隐藏 */}
        {!isBatchEditMode && !needsEditAuth() && (
          <div className={`flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-blue-50 dark:bg-blue-900/20 backdrop-blur-sm rounded-md p-1 absolute ${
            isDetailedView ? 'top-3 right-3' : 'top-1/2 -translate-y-1/2 right-2'
          }`}>
              <button
                  onClick={(e) => toggleFavorite(link.id, e)}
                  className={`p-1 rounded-md transition-colors ${
                    link.favorite
                      ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-slate-700'
                      : 'text-slate-400 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                  title={link.favorite ? '取消常用' : '加入常用'}
              >
                  <Star size={18} fill={link.favorite ? 'currentColor' : 'none'} />
              </button>
              <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); if(!requireAuth()) return; setEditingLink(link); setIsModalOpen(true); }}
                  className="p-1 text-slate-400 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md"
                  title="编辑"
              >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12A3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5a3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97c0-.33-.03-.65-.07-.97l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.08-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.32-.07.64-.07.97c0 .33.03.65.07.97l-2.11 1.63c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.39 1.06.73 1.69.98l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.25 1.17-.59 1.69-.98l2.49 1c.22.08.49 0 .61-.22l2-3.46c.13-.22.07-.49-.12-.64l-2.11-1.63Z" fill="currentColor"/>
                  </svg>
              </button>
          </div>
        )}
      </div>
    );
  };

  if (isCheckingAuth && requiresAuth === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden text-slate-900 dark:text-slate-50">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[120] will-change-[clip-path,opacity,background-color] transition-[clip-path,opacity,background-color] duration-[620ms]"
        style={{
          backgroundColor: themeTransition.targetDark ? '#020617' : '#f8fafc',
          opacity: themeTransition.visible ? 1 : 0,
          clipPath: `circle(${themeTransition.radius}px at ${themeTransition.x}px ${themeTransition.y}px)`,
          transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
      <AuthModal
        isOpen={isAuthOpen}
        onLogin={handleLogin}
        onClose={() => { setIsAuthOpen(false); setPendingSelectCategoryId(null); }}
        canClose={true}
        description="输入部署时设置的 PASSWORD，验证后就能继续操作。"
      />
      {/* 首页开放访问，不需要登录认证；编辑操作通过 needsEditAuth() 检查 */}
      <>
      {/* 全屏认证弹窗，仅在用户主动触发编辑操作时弹出 */}
      {isAuthOpen && (
        <AuthModal
          isOpen={true}
          onLogin={handleLogin}
          description="输入部署时设置的 PASSWORD，验证后就能继续操作。"
        />
      )}
      <CategoryAuthModal 
        isOpen={!!catAuthModalData}
        category={catAuthModalData}
        onClose={() => { setCatAuthModalData(null); setPendingSelectCategoryId(null); }}
        onUnlock={handleUnlockCategory}
      />

      <CategoryManagerModal 
        isOpen={isCatManagerOpen} 
        onClose={() => setIsCatManagerOpen(false)}
        categories={categories}
        onUpdateCategories={handleUpdateCategories}
        onDeleteCategory={handleDeleteCategory}
        onVerifyPassword={IS_DEV || authToken ? undefined : handleCategoryActionAuth}
      />

      <BackupModal
        isOpen={isBackupModalOpen}
        onClose={() => setIsBackupModalOpen(false)}
        links={links}
        categories={categories}
        onRestore={handleRestoreBackup}
        webDavConfig={webDavConfig}
        onSaveWebDavConfig={handleSaveWebDavConfig}
        onRestoreWebDavConfig={handleRestoreWebDavConfig}
        searchConfig={{ mode: searchMode, externalSources: externalSearchSources }}
        onRestoreSearchConfig={handleRestoreSearchConfig}
        aiConfig={aiConfig}
        onRestoreAIConfig={handleRestoreAIConfig}
      />

      <ImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        existingLinks={links}
        categories={categories}
        onImport={handleImportConfirm}
        onImportSearchConfig={handleRestoreSearchConfig}
        onImportAIConfig={handleRestoreAIConfig}
        onImportWebDavConfig={handleRestoreWebDavConfig}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        config={aiConfig}
        siteSettings={siteSettings}
        onSave={handleSaveAIConfig}
        links={links}
        categories={categories}
        onUpdateLinks={(newLinks) => updateData(newLinks, categories)}
        authToken={authToken}
      />

      <SearchConfigModal
        isOpen={isSearchConfigModalOpen}
        onClose={() => setIsSearchConfigModalOpen(false)}
        sources={externalSearchSources}
        onSave={handleSearchConfigModalSave}
      />

      {/* Sidebar Mobile Overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 z-20 bg-black/50 lg:hidden backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside 
        className={`
          fixed lg:static inset-y-0 left-0 z-30 transform transition-all duration-300 ease-in-out
          bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col
          ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'} w-64
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        {/* Logo */}
        <div className={`h-16 flex items-center border-b border-slate-100 dark:border-slate-700 shrink-0 ${sidebarCollapsed ? 'lg:px-0 lg:justify-center' : 'px-6'}`}>
            {sidebarCollapsed ? (
              <span className="hidden lg:block text-xl font-bold bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent">
                {(siteSettings.navTitle || 'CloudNav').charAt(0)}
              </span>
            ) : (
              <span className="text-xl font-bold bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent flex-1 truncate">
                {siteSettings.navTitle || 'CloudNav'}
              </span>
            )}
            <button
              onClick={toggleSidebarCollapsed}
              className="hidden lg:flex p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors shrink-0"
              title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
        </div>

        {/* Categories List */}
        <div className={`flex-1 overflow-y-auto p-4 space-y-1 scrollbar-hide ${sidebarCollapsed ? 'lg:px-2' : ''}`}>
            <div className={`flex items-center justify-between pt-4 pb-2 px-4 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
               <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">分类目录</span>
               {!needsEditAuth() && (
               <button 
                  onClick={() => { if(needsEditAuth()) setIsAuthOpen(true); else setIsCatManagerOpen(true); }}
                  className="p-1 text-slate-400 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
                  title="管理分类"
               >
                  <Settings size={14} />
               </button>
               )}
            </div>

            {/* 树形分类列表 */}
            {(() => {
              const treeNodes = buildCategoryTree(categories);
              
              // 递归渲染分类节点
              const renderCategoryNode = (node: CategoryTreeNode, depth: number = 0): React.ReactNode => {
                const cat = node.category;
                const isLocked = isCategoryLocked(cat.id);
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedCategoryIds.has(cat.id);
                const indentPx = depth * 16;
                // 多级导航：父分类自身被锁定（含祖先锁定）时不允许展开子分类
                const canExpand = hasChildren && !isLocked;
                
                return (
                  <React.Fragment key={cat.id}>
                    <div
                      onClick={() => handleCategoryClick(cat)}
                      onMouseEnter={(e) => {
                        if (sidebarCollapsed && hasChildren && canExpand) {
                          if (flyoutTimer.current) { clearTimeout(flyoutTimer.current); flyoutTimer.current = null; }
                          setCollapsedFlyout({ catId: cat.id, rect: e.currentTarget.getBoundingClientRect() });
                        }
                      }}
                      onMouseLeave={() => {
                        if (sidebarCollapsed) {
                          if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
                          flyoutTimer.current = setTimeout(() => setCollapsedFlyout(null), 200);
                        }
                      }}
                      style={sidebarCollapsed ? undefined : { paddingLeft: `${16 + indentPx}px` }}
                      className={`w-full flex items-center gap-2 py-2 pr-4 rounded-xl transition-all group cursor-pointer ${sidebarCollapsed ? 'lg:justify-center lg:px-0 lg:pr-0' : ''} ${
                        selectedCategory === cat.id 
                          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium' 
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700'
                      }`}
                      title={sidebarCollapsed ? cat.name : undefined}
                    >
                      {/* 展开/折叠箭头（独立点击区域） */}
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canExpand) return;
                            setExpandedCategoryIds(prev => {
                              const newSet = new Set(prev);
                              if (isExpanded) {
                                newSet.delete(cat.id);
                              } else {
                                newSet.add(cat.id);
                              }
                              return newSet;
                            });
                          }}
                          className={`p-0.5 rounded transition-colors ${sidebarCollapsed ? 'lg:hidden' : ''} ${canExpand ? 'hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-500' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}
                          aria-label={isExpanded ? '折叠' : '展开'}
                          tabIndex={-1}
                        >
                          <ChevronRight 
                            size={14} 
                            className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          />
                        </button>
                      ) : (
                        <span className={`w-3.5 inline-block ${sidebarCollapsed ? 'lg:hidden' : ''}`}></span>
                      )}
                      <div className={`p-1.5 rounded-lg transition-colors flex items-center justify-center shrink-0 ${selectedCategory === cat.id ? 'bg-blue-100 dark:bg-blue-800' : 'bg-slate-100 dark:bg-slate-800'}`}>
                        {isLocked ? <Lock size={16} className="text-amber-500" /> : <Icon name={cat.icon} size={16} />}
                      </div>
                      <span className={`truncate flex-1 text-left ${sidebarCollapsed ? 'lg:hidden' : ''}`}>{cat.name}</span>
                      {requiresGlobalCategoryAuth(cat.id) && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
                          需登录
                        </span>
                      )}
                      {selectedCategory === cat.id && <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>}
                    </div>
                    {/* 递归渲染子分类 */}
                    {isExpanded && canExpand && node.children.map(child => renderCategoryNode(child, depth + 1))}
                  </React.Fragment>
                );
              };
              
              return treeNodes.map(node => renderCategoryNode(node));
            })()}
        </div>

        {/* Footer Actions */}
        <div className={`border-t border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 shrink-0 ${sidebarCollapsed ? 'lg:p-2' : 'p-4'}`}>

            {!needsEditAuth() && (
            <div className={`grid grid-cols-3 gap-2 mb-2 ${sidebarCollapsed ? 'lg:grid-cols-1 lg:gap-1.5' : ''}`}>
                <button
                    onClick={() => { if(needsEditAuth()) setIsAuthOpen(true); else setIsImportModalOpen(true); }}
                    className="flex flex-col items-center justify-center gap-1 p-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 transition-all"
                    title="导入书签"
                >
                    <Upload size={14} />
                    <span className={`${sidebarCollapsed ? 'lg:hidden' : ''}`}>导入</span>
                </button>

                <button
                    onClick={() => { if(needsEditAuth()) setIsAuthOpen(true); else setIsBackupModalOpen(true); }}
                    className="flex flex-col items-center justify-center gap-1 p-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 transition-all"
                    title="备份与恢复"
                >
                    <CloudCog size={14} />
                    <span className={`${sidebarCollapsed ? 'lg:hidden' : ''}`}>备份</span>
                </button>

                <button
                    onClick={() => { if(needsEditAuth()) setIsAuthOpen(true); else setIsSettingsModalOpen(true); }}
                    className="flex flex-col items-center justify-center gap-1 p-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 transition-all"
                    title="AI 设置"
                >
                    <Settings size={14} />
                    <span className={`${sidebarCollapsed ? 'lg:hidden' : ''}`}>设置</span>
                </button>
            </div>
            )}
            
            <div className={`flex items-center justify-between text-xs px-2 mt-2 ${sidebarCollapsed ? 'lg:flex-col lg:gap-1 lg:px-0' : ''}`}>
               <div className="flex items-center gap-1 text-slate-400">
                 {syncStatus === 'saving' && <Loader2 className="animate-spin w-3 h-3 text-blue-500" />}
                 {syncStatus === 'saved' && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                 {syncStatus === 'error' && <AlertCircle className="w-3 h-3 text-red-500" />}
                 {authToken ? <span className={`text-green-600 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>已同步</span> : <span className={`text-amber-500 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>离线</span>}
               </div>

               <a 
                 href={GITHUB_REPO_URL} 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="flex items-center gap-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                 title="Fork this project on GitHub"
               >
                 <GitFork size={14} />
                 <span className={`${sidebarCollapsed ? 'lg:hidden' : ''}`}>Fork 项目 v1.7.1</span>
               </a>
            </div>
        </div>
      </aside>

      {/* 折叠模式下的子分类弹出层 */}
      {sidebarCollapsed && collapsedFlyout && (() => {
        const allNodes = buildCategoryTree(categories);
        const flyoutNode = allNodes.find(n => n.category.id === collapsedFlyout.catId);
        if (!flyoutNode || flyoutNode.children.length === 0) return null;

        // 递归渲染弹出层中的子分类
        const renderFlyoutNode = (node: CategoryTreeNode, depth: number = 0): React.ReactNode => {
          const cat = node.category;
          const isLocked = isCategoryLocked(cat.id);
          const hasChildren = node.children.length > 0;
          return (
            <React.Fragment key={cat.id}>
              <div
                onClick={() => { handleCategoryClick(cat); setCollapsedFlyout(null); }}
                style={{ paddingLeft: `${12 + depth * 16}px` }}
                className={`w-full flex items-center gap-2 py-1.5 pr-3 rounded-lg cursor-pointer transition-colors ${
                  selectedCategory === cat.id
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
              >
                {hasChildren ? <ChevronRight size={12} className="text-slate-400 shrink-0" /> : <span className="w-3 inline-block shrink-0" />}
                <div className={`p-1 rounded flex items-center justify-center shrink-0 ${selectedCategory === cat.id ? 'bg-blue-100 dark:bg-blue-800' : 'bg-slate-100 dark:bg-slate-800'}`}>
                  {isLocked ? <Lock size={12} className="text-amber-500" /> : <Icon name={cat.icon} size={12} />}
                </div>
                <span className="truncate text-sm">{cat.name}</span>
              </div>
              {node.children.map(child => renderFlyoutNode(child, depth + 1))}
            </React.Fragment>
          );
        };

        return (
          <div
            className="fixed z-50 min-w-[200px] max-h-[70vh] overflow-y-auto p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl"
            style={{ top: Math.min(collapsedFlyout.rect.top, window.innerHeight * 0.7), left: collapsedFlyout.rect.right + 8 }}
            onMouseEnter={() => { if (flyoutTimer.current) { clearTimeout(flyoutTimer.current); flyoutTimer.current = null; } }}
            onMouseLeave={() => {
              if (flyoutTimer.current) clearTimeout(flyoutTimer.current);
              flyoutTimer.current = setTimeout(() => setCollapsedFlyout(null), 200);
            }}
          >
            {/* 弹出层标题 */}
            <div className="px-3 py-1.5 mb-1 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">
              {flyoutNode.category.name}
            </div>
            <div className="space-y-0.5">
              {flyoutNode.children.map(child => renderFlyoutNode(child))}
            </div>
          </div>
        );
      })()}

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full bg-slate-50 dark:bg-slate-900 overflow-hidden relative">
        
        {/* Header */}
        <header className="h-16 px-4 lg:px-8 flex items-center justify-between bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10 shrink-0">
          <div className="flex items-center gap-4 flex-1">
            <button onClick={() => setSidebarOpen(true)} className="lg:hidden p-2 -ml-2 text-slate-600 dark:text-slate-300">
              <Menu size={24} />
            </button>

            {/* 搜索模式切换 + 搜索框 */}
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <button 
                onClick={() => {
                  setIsMobileSearchOpen(!isMobileSearchOpen);
                  if (searchMode !== 'external') {
                    handleSearchModeChange('external');
                  }
                }}
                className="sm:flex md:hidden lg:hidden p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors"
                title="搜索"
              >
                <Search size={20} />
              </button>

              {/* 搜索模式切换 - 平板端和桌面端显示，手机端隐藏 */}
              <div className="hidden sm:hidden md:flex lg:flex items-center gap-2 flex-shrink-0">
                <div className="flex items-center bg-slate-100 dark:bg-slate-700 rounded-full p-1">
                  <button
                    onClick={() => handleSearchModeChange('internal')}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-all flex items-center justify-center min-h-[24px] min-w-[40px] ${
                      searchMode === 'internal'
                        ? 'bg-white dark:bg-slate-600 text-blue-600 dark:text-blue-400 shadow-sm'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100'
                    }`}
                    title="站内搜索"
                  >
                    站内
                  </button>
                  <button
                    onClick={() => handleSearchModeChange('external')}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-all flex items-center justify-center min-h-[24px] min-w-[40px] ${
                      searchMode === 'external'
                        ? 'bg-white dark:bg-slate-600 text-blue-600 dark:text-blue-400 shadow-sm'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100'
                    }`}
                    title="站外搜索"
                  >
                    站外
                  </button>
                </div>
                {searchMode === 'external' && (
                  <button
                    onClick={openSearchConfigModal}
                    className="p-1.5 text-slate-400 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors"
                    title="管理搜索源"
                  >
                    <Settings size={14} />
                  </button>
                )}
              </div>

              {/* 搜索框 */}
              <div className={`relative w-full max-w-lg ${isMobileSearchOpen ? 'block' : 'hidden'} sm:block`}>
                {/* 搜索源选择弹出窗口 */}
                {searchMode === 'external' && showSearchSourcePopup && (
                  <div 
                    className="absolute left-0 top-full mt-2 w-full bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 p-3 z-50"
                    onMouseEnter={() => setIsPopupHovered(true)}
                    onMouseLeave={() => setIsPopupHovered(false)}
                  >
                    <div className="grid grid-cols-5 sm:grid-cols-5 gap-2">
                      {externalSearchSources
                        .filter(source => source.enabled)
                        .map((source, index) => (
                          <button
                            key={index}
                            onClick={() => handleSearchSourceSelect(source)}
                            onMouseEnter={() => setHoveredSearchSource(source)}
                            onMouseLeave={() => setHoveredSearchSource(null)}
                            className="px-2 py-2 text-sm rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 flex items-center gap-1 justify-center"
                          >
                            <img 
                              src={`https://www.faviconextractor.com/favicon/${new URL(source.url).hostname}?larger=true`}
                              alt={source.name}
                              className="w-4 h-4"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXNlYXJjaCI+PHBhdGggZD0ibTIxIDIxLTQuMzQtNC4zNCI+PC9wYXRoPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjgiPjwvY2lyY2xlPjwvc3ZnPg==';
                              }}
                            />
                            <span className="truncate hidden sm:inline">{source.name}</span>
                          </button>
                        ))}
                    </div>
                  </div>
                )}

                <div 
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 cursor-pointer"
                  onMouseEnter={() => searchMode === 'external' && setIsIconHovered(true)}
                  onMouseLeave={() => setIsIconHovered(false)}
                  onClick={() => {
                    if (searchMode === 'external') {
                      setShowSearchSourcePopup(!showSearchSourcePopup);
                    }
                  }}
                >
                  {searchMode === 'internal' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-search">
                      <path d="m21 21-4.35-4.35"></path>
                      <circle cx="11" cy="11" r="8"></circle>
                    </svg>
                  ) : (hoveredSearchSource || selectedSearchSource) ? (
                    <img 
                      src={`https://www.faviconextractor.com/favicon/${new URL((hoveredSearchSource || selectedSearchSource).url).hostname}?larger=true`}
                      alt={(hoveredSearchSource || selectedSearchSource).name}
                      className="w-4 h-4"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXNlYXJjaCI+PHBhdGggZD0ibTIxIDIxLTQuMzQtNC4zNCI+PC9wYXRoPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjgiPjwvY2lyY2xlPjwvc3ZnPg==';
                      }}
                    />
                  ) : (
                    <Search size={16} />
                  )}
                </div>
                
                <input
                  type="text"
                  placeholder={
                    searchMode === 'internal' 
                      ? "搜索站内内容..." 
                      : selectedSearchSource 
                        ? `在${selectedSearchSource.name}搜索内容` 
                        : "搜索站外内容..."
                  }
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchMode === 'external') {
                      handleExternalSearch();
                    }
                  }}
                  className="w-full pl-9 pr-4 py-2 rounded-full bg-slate-100 dark:bg-slate-700/50 border-none text-sm focus:ring-2 focus:ring-blue-500 dark:text-white placeholder-slate-400 outline-none transition-all"
                  // 移动端优化：防止页面缩放
                  style={{ fontSize: '16px' }}
                  inputMode="search"
                  enterKeyHint="search"
                />

                {searchMode === 'external' && searchQuery.trim() && (
                  <button
                    onClick={handleExternalSearch}
                    className="absolute right-10 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-blue-500"
                    title="执行站外搜索"
                  >
                    <ExternalLink size={14} />
                  </button>
                )}
                
                {searchQuery.trim() && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full bg-slate-200 dark:bg-slate-600 text-slate-500 dark:text-slate-300 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-500 dark:hover:text-red-400 transition-all"
                    title="清空搜索"
                  >
                    <X size={12} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* 视图切换控制器 - 移动端：搜索框展开时隐藏，桌面端始终显示 */}
            <div className={`${isMobileSearchOpen ? 'hidden' : 'flex'} lg:flex items-center bg-slate-100 dark:bg-slate-700 rounded-full p-1`}>
              <button
                onClick={() => handleViewModeChange('simple')}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  siteSettings.cardStyle === 'simple'
                    ? 'bg-white dark:bg-slate-600 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100'
                }`}
                title="简约版视图"
              >
                简约
              </button>
              <button
                onClick={() => handleViewModeChange('detailed')}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  siteSettings.cardStyle === 'detailed'
                    ? 'bg-white dark:bg-slate-600 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100'
                }`}
                title="详情版视图"
              >
                详情
              </button>
            </div>

            {/* 主题切换按钮 - 移动端：搜索框展开时隐藏，桌面端始终显示 */}
            <button ref={themeButtonRef} onClick={toggleTheme} className={`${isMobileSearchOpen ? 'hidden' : 'flex'} lg:flex p-2 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700`}>
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            {/* 登录/退出按钮 - 移动端：搜索框展开时隐藏，桌面端始终显示 */}
            <div className={`${isMobileSearchOpen ? 'hidden' : 'flex'}`}>
              {!authToken ? (
                  <button onClick={() => setIsAuthOpen(true)} className="flex items-center gap-2 bg-slate-200 dark:bg-slate-700 px-3 py-1.5 rounded-full text-xs font-medium">
                      <Cloud size={14} /> <span className="hidden sm:inline">登录</span>
                  </button>
              ) : (
                  <button onClick={handleLogout} className="flex items-center gap-2 bg-slate-200 dark:bg-slate-700 px-3 py-1.5 rounded-full text-xs font-medium">
                      <LogOut size={14} /> <span className="hidden sm:inline">退出</span>
                  </button>
              )}
            </div>

            {/* 添加按钮 - 移动端：搜索框展开时隐藏，桌面端始终显示；未登录时隐藏 */}
            {!needsEditAuth() && (
            <div className={`${isMobileSearchOpen ? 'hidden' : 'flex'}`}>
              <button
                onClick={() => { if(needsEditAuth()) setIsAuthOpen(true); else { setEditingLink(undefined); setIsModalOpen(true); }}}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-full text-sm font-medium shadow-lg shadow-blue-500/30"
              >
                <Plus size={16} /> <span className="hidden sm:inline">添加</span>
              </button>
            </div>
            )}
          </div>
        </header>

        {/* Content Scroll Area */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-8 space-y-8">
            
            {/* 1. Pinned Area (Custom Top Area) */}
            {pinnedLinks.length > 0 && !searchQuery && (selectedCategory === 'all') && (
                <section>
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <Pin size={16} className="text-blue-500 fill-blue-500" />
                            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                置顶 / 常用
                            </h2>
                            <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 rounded-full">
                                {pinnedLinks.length}
                            </span>
                        </div>
                        {isSortingPinned ? (
                            <div className="flex gap-2">
                                <button 
                                    onClick={savePinnedSorting}
                                    className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-full transition-colors"
                                    title="保存顺序"
                                >
                                    <Save size={14} />
                                    <span>保存顺序</span>
                                </button>
                                <button 
                                    onClick={cancelPinnedSorting}
                                    className="px-3 py-1.5 bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-medium rounded-full hover:bg-slate-300 dark:hover:bg-slate-600 transition-all"
                                    title="取消排序"
                                >
                                    取消
                                </button>
                            </div>
                        ) : (
                            !needsEditAuth() && (
                            <button
                                onClick={() => { if(!requireAuth()) return; setIsSortingPinned(true); }}
                                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-full transition-colors"
                                title="排序"
                            >
                                <GripVertical size={14} />
                                <span>排序</span>
                            </button>
                            )
                        )}
                    </div>
                    {isSortingPinned ? (
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCorners}
                            onDragEnd={handlePinnedDragEnd}
                        >
                            <SortableContext
                                items={pinnedLinks.map(link => link.id)}
                                strategy={rectSortingStrategy}
                            >
                                <div className={`grid gap-3 ${
                                  siteSettings.cardStyle === 'detailed' 
                                    ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' 
                                    : 'grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8'
                                }`}>
                                    {pinnedLinks.map(link => (
                                        <SortableLinkCard key={link.id} link={link} />
                                    ))}
                                </div>
                            </SortableContext>
                        </DndContext>
                    ) : (
                        <div className={`grid gap-3 ${
                          siteSettings.cardStyle === 'detailed' 
                            ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' 
                            : 'grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8'
                        }`}>
                            {pinnedLinks.map(link => renderLinkCard(link))}
                        </div>
                    )}
                </section>
            )}

            {/* 2. Main Grid */}
            {(selectedCategory !== 'all' || searchQuery) && (
            <section>
                 {(!pinnedLinks.length && !searchQuery && selectedCategory === 'all') && (
                    <div className="mb-6 p-4 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-lg flex items-center justify-between">
                         <div>
                            <h1 className="text-xl font-bold">早安 👋</h1>
                            <p className="text-sm opacity-90 mt-1">
                                {links.length} 个链接 · {categories.length} 个分类
                            </p>
                         </div>
                         <Icon name="Compass" size={48} className="opacity-20" />
                    </div>
                 )}

                 <div className="flex items-center justify-between mb-4">
                     <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-2">
                         {selectedCategory === 'all' 
                            ? (searchQuery ? '搜索结果' : '所有链接') 
                            : (
                                <>
                                    {categories.find(c => c.id === selectedCategory)?.name}
                                    {isCategoryLocked(selectedCategory) && <Lock size={14} className="text-amber-500" />}
                                    <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 rounded-full">
                                        {displayedLinks.length}
                                    </span>
                                </>
                            )
                         }
                     </h2>
                     {selectedCategory !== 'all' && !isCategoryLocked(selectedCategory) && (
                         isSortingMode === selectedCategory ? (
                             <div className="flex gap-2">
                                 <button 
                                     onClick={saveSorting}
                                     className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-full transition-colors"
                                     title="保存顺序"
                                 >
                                     <Save size={14} />
                                     <span>保存顺序</span>
                                 </button>
                                 <button 
                                     onClick={cancelSorting}
                                     className="px-3 py-1.5 bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-medium rounded-full hover:bg-slate-300 dark:hover:bg-slate-600 transition-all"
                                     title="取消排序"
                                 >
                                     取消
                                 </button>
                             </div>
                         ) : (
                            !needsEditAuth() && (
                             <div className="flex gap-2">
                                 <button
                                     onClick={toggleBatchEditMode}
                                     className={`flex items-center gap-1 px-3 py-1.5 text-white text-xs font-medium rounded-full transition-colors ${
                                         isBatchEditMode
                                             ? 'bg-red-600 hover:bg-red-700'
                                             : 'bg-blue-600 hover:bg-blue-700'
                                     }`}
                                     title={isBatchEditMode ? "退出批量编辑" : "批量编辑"}
                                 >
                                     {isBatchEditMode ? '取消' : '批量编辑'}
                                 </button>
                                 {isBatchEditMode ? (
                                     <>
                                         <button
                                             onClick={handleBatchDelete}
                                             className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-full transition-colors"
                                             title="批量删除"
                                         >
                                             <Trash2 size={14} />
                                             <span>批量删除</span>
                                         </button>
                                         <button
                                             onClick={handleSelectAll}
                                             className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-full transition-colors"
                                             title="全选/取消全选"
                                         >
                                             <CheckSquare size={14} />
                                             <span>{selectedLinks.size === displayedLinks.length ? '取消全选' : '全选'}</span>
                                         </button>
                                         <button
                                             onClick={() => {
                                               if (selectedLinks.size === 0) {
                                                 alertDialog({ message: '请先选择要移动的链接', variant: 'warning' });
                                                 return;
                                               }
                                               setBatchMoveOpen(true);
                                             }}
                                             className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-full transition-colors"
                                             title="批量移动"
                                         >
                                             <Upload size={14} />
                                             <span>批量移动</span>
                                         </button>
                                     </>
                                 ) : (
                                     <button
                                         onClick={() => startSorting(selectedCategory)}
                                         className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-full transition-colors"
                                         title="排序"
                                     >
                                         <GripVertical size={14} />
                                         <span>排序</span>
                                     </button>
                                 )}
                             </div>
                            )
                         )
                     )}
                 </div>

                 {displayedLinks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                        {isCategoryLocked(selectedCategory) ? (
                            <>
                                <Lock size={40} className="text-amber-400 mb-4" />
                                <p>该目录已锁定</p>
                                <button onClick={() => setCatAuthModalData(categories.find(c => c.id === selectedCategory) || null)} className="mt-4 px-4 py-2 bg-amber-500 text-white rounded-lg">输入密码解锁</button>
                            </>
                        ) : (
                            <></>
                        )}
                    </div>
                 ) : (
                    isSortingMode === selectedCategory ? (
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCorners}
                            onDragEnd={handleDragEnd}
                        >
                            <SortableContext
                                items={displayedLinks.map(link => link.id)}
                                strategy={rectSortingStrategy}
                            >
                                <div className={`grid gap-3 ${
                                  siteSettings.cardStyle === 'detailed' 
                                    ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' 
                                    : 'grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8'
                                }`}>
                                    {displayedLinks.map(link => (
                                        <SortableLinkCard key={link.id} link={link} />
                                    ))}
                                </div>
                            </SortableContext>
                        </DndContext>
                    ) : (
                        <div className={`grid gap-3 ${
                          siteSettings.cardStyle === 'detailed' 
                            ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' 
                            : 'grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8'
                        }`}>
                            {displayedLinks.map(link => renderLinkCard(link))}
                        </div>
                    )
                 )}
            </section>
            )}

            {/* 其他目录搜索结果区域 */}
            {searchQuery.trim() && selectedCategory !== 'all' && (
              <section className="mt-8 pt-8 border-t-2 border-slate-200 dark:border-slate-700">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-2 mb-4">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-folder-search">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                    <path d="M11 11h.01"></path>
                  </svg>
                  其他目录搜索结果
                  <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300 rounded-full">
                    {Object.values(otherCategoryResults).flat().length}
                  </span>
                </h2>

                {Object.keys(otherCategoryResults).length > 0 ? (
                  Object.entries(otherCategoryResults).map(([categoryId, links]) => {
                    const category = categories.find(c => c.id === categoryId);
                    if (!category) return null;

                    return (
                      <div key={categoryId} className="mb-6 last:mb-0">
                        <div className="flex items-center gap-2 mb-3">
                          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                            {category.name}
                          </h3>
                          <span className="px-2 py-0.5 text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 rounded-full">
                            {links.length}
                          </span>
                        </div>

                        <div className={`grid gap-3 ${
                          siteSettings.cardStyle === 'detailed' 
                            ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' 
                            : 'grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8'
                        }`}>
                          {links.map(link => renderLinkCard(link))}
                        </div>
                      </div>
                    );
                  })
                ) : null}
              </section>
            )}
        </div>
      </main>

          <LinkModal
            isOpen={isModalOpen}
            onClose={() => { setIsModalOpen(false); setEditingLink(undefined); setPrefillLink(undefined); }}
            onSave={editingLink ? handleEditLink : handleAddLink}
            onDelete={editingLink ? handleDeleteLink : undefined}
            categories={categories}
            initialData={editingLink || (prefillLink as LinkItem)}
            aiConfig={aiConfig}
            defaultCategoryId={selectedCategory !== 'all' ? selectedCategory : undefined}
          />

          {/* 右键菜单 */}
          <ContextMenu
            isOpen={contextMenu.isOpen}
            position={contextMenu.position}
            onClose={closeContextMenu}
            onCopyLink={copyLinkToClipboard}
            onShowQRCode={showQRCode}
            onEditLink={editLinkFromContextMenu}
            onDeleteLink={deleteLinkFromContextMenu}
            onTogglePin={togglePinFromContextMenu}
            onToggleFavorite={toggleFavoriteFromContextMenu}
            isFavorite={contextMenu.link?.favorite}
          />

          {/* 二维码模态框 */}
          <QRCodeModal
            isOpen={qrCodeModal.isOpen}
            url={qrCodeModal.url || ''}
            title={qrCodeModal.title || ''}
            onClose={() => setQrCodeModal({ isOpen: false, url: '', title: '' })}
          />

          {/* 批量移动分类选择器 */}
          <CategoryTreeSelect
            categories={categories}
            value={selectedCategory}
            onChange={handleBatchMove}
            isOpen={batchMoveOpen}
            onOpenChange={setBatchMoveOpen}
            title="批量移动到分类"
            hideTrigger
          />

          {/* 全局确认/提示模态框 */}
          <ConfirmDialogHost />
      </>
    </div>
  );
}

export default App;

