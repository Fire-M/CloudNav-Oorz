export interface LinkItem {
  id: string;
  title: string;
  url: string;
  icon?: string;
  description?: string;
  categoryId: string;
  createdAt: number;
  pinned?: boolean; // New field for pinning
  pinnedOrder?: number; // Field for pinned link sorting order
  favorite?: boolean; // 是否收藏到常用推荐（不改变原分类归属）
}

export interface Category {
  id: string;
  name: string;
  icon: string; // Lucide icon name or emoji
  password?: string; // Optional password for category protection
  requireAuth?: boolean; // 使用全站密码后才可查看该分类内容
  parentId?: string; // 父分类ID，无值则为顶级分类
}

export interface SiteSettings {
  title: string;
  navTitle: string;
  favicon: string;
  cardStyle: 'detailed' | 'simple';
  requirePasswordOnVisit: boolean;
  passwordExpiryDays: number; // 密码过期天数，0表示永久不退出
}

export interface AppState {
  links: LinkItem[];
  categories: Category[];
  darkMode: boolean;
  settings?: SiteSettings;
}

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  enabled: boolean;
}

export type AIProvider = 'gemini' | 'openai';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  websiteTitle?: string; // 网站标题 (浏览器标签)
  faviconUrl?: string; // 网站图标URL
  navigationName?: string;
}



// 搜索模式类型
export type SearchMode = 'internal' | 'external';

// 外部搜索源配置
export interface ExternalSearchSource {
  id: string;
  name: string;
  url: string;
  icon?: string;
  enabled: boolean;
  createdAt: number;
}

// 搜索配置
export interface SearchConfig {
  mode: SearchMode;
  externalSources: ExternalSearchSource[];
  selectedSource?: ExternalSearchSource | null; // 选中的搜索源
}

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'common', name: '常用推荐', icon: 'Star' },
  { id: 'dev', name: '开发工具', icon: 'Code' },
  { id: 'dev-frontend', name: '前端', icon: 'Layout', parentId: 'dev' },
  { id: 'dev-backend', name: '后端', icon: 'Server', parentId: 'dev' },
  { id: 'dev-devops', name: 'DevOps', icon: 'Cloud', parentId: 'dev' },
  { id: 'dev-frontend-react', name: 'React', icon: 'Atom', parentId: 'dev-frontend' },
  { id: 'dev-frontend-vue', name: 'Vue', icon: 'Box', parentId: 'dev-frontend' },
  { id: 'dev-frontend-svelte', name: 'Svelte', icon: 'FlaskConical', parentId: 'dev-frontend' },
  { id: 'design', name: '设计资源', icon: 'Palette' },
  { id: 'design-ui', name: 'UI 设计', icon: 'MousePointerClick', parentId: 'design' },
  { id: 'design-3d', name: '3D 资源', icon: 'Box', parentId: 'design' },
  { id: 'read', name: '阅读资讯', icon: 'BookOpen' },
  { id: 'read-tech', name: '技术文章', icon: 'FileText', parentId: 'read' },
  { id: 'read-blog', name: '个人博客', icon: 'PenLine', parentId: 'read' },
  { id: 'ent', name: '休闲娱乐', icon: 'Gamepad2' },
  { id: 'ent-video', name: '视频', icon: 'Film', parentId: 'ent' },
  { id: 'ent-music', name: '音乐', icon: 'Music', parentId: 'ent' },
  { id: 'ai', name: '人工智能', icon: 'Bot' },
  { id: 'ai-chat', name: '对话模型', icon: 'MessageCircle', parentId: 'ai' },
  { id: 'ai-image', name: '图像生成', icon: 'Image', parentId: 'ai' },
  { id: 'ai-code', name: '代码助手', icon: 'Terminal', parentId: 'ai' },
];

export const INITIAL_LINKS: LinkItem[] = [
  { id: '1', title: 'GitHub', url: 'https://github.com', categoryId: 'dev', createdAt: Date.now(), description: '代码托管平台', pinned: true, icon: 'https://www.faviconextractor.com/favicon/github.com?larger=true' },
  { id: '2', title: 'React', url: 'https://react.dev', categoryId: 'dev', createdAt: Date.now(), description: '构建Web用户界面的库', pinned: true, icon: 'https://www.faviconextractor.com/favicon/react.dev?larger=true' },
  { id: '3', title: 'Tailwind CSS', url: 'https://tailwindcss.com', categoryId: 'design', createdAt: Date.now(), description: '原子化CSS框架', pinned: true, icon: 'https://www.faviconextractor.com/favicon/tailwindcss.com?larger=true' },
  { id: '4', title: 'ChatGPT', url: 'https://chat.openai.com', categoryId: 'ai', createdAt: Date.now(), description: 'OpenAI聊天机器人', pinned: true, icon: 'https://www.faviconextractor.com/favicon/chat.openai.com?larger=true' },
  { id: '5', title: 'Gemini', url: 'https://gemini.google.com', categoryId: 'ai', createdAt: Date.now(), description: 'Google DeepMind AI', pinned: true, icon: 'https://www.faviconextractor.com/favicon/gemini.google.com?larger=true' },
];
