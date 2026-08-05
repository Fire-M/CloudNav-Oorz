interface Env {
  CLOUDNAV_KV: any;
}

interface SharedLink {
  title: string;
  url: string;
  icon?: string;
  description?: string;
  categoryId?: string;
  categoryName?: string;
  categoryIcon?: string;
}

interface SharedCollection {
  id: string;
  title: string;
  description?: string;
  links: SharedLink[];
  createdAt: number;
  expiresAt: number;
  viewCount?: number;
}

// 按分类分组
const groupByCategory = (links: SharedLink[]): Map<string, { name: string; icon: string; links: SharedLink[] }> => {
  const groups = new Map<string, { name: string; icon: string; links: SharedLink[] }>();
  
  links.forEach(link => {
    const catId = link.categoryId || 'uncategorized';
    const catName = link.categoryName || '未分类';
    const catIcon = link.categoryIcon || 'Folder';
    
    if (!groups.has(catId)) {
      groups.set(catId, { name: catName, icon: catIcon, links: [] });
    }
    groups.get(catId)!.links.push(link);
  });
  
  return groups;
};

// 获取分类图标 emoji
const getCategoryEmoji = (icon: string): string => {
  const iconMap: Record<string, string> = {
    'Star': '⭐', 'Code': '💻', 'Layout': '📐', 'Server': '🖥️', 'Cloud': '☁️',
    'Atom': '⚛️', 'Box': '📦', 'FlaskConical': '🧪', 'Palette': '🎨',
    'MousePointerClick': '👆', 'BookOpen': '📖', 'FileText': '📄', 'PenLine': '✍️',
    'Gamepad2': '🎮', 'Film': '🎬', 'Music': '🎵', 'Bot': '🤖', 'MessageCircle': '💬',
    'Image': '🖼️', 'Terminal': '💻', 'Folder': '📁', 'Heart': '❤️', 'Globe': '🌐',
    'ShoppingBag': '🛍️', 'Briefcase': '💼', 'GraduationCap': '🎓', 'Home': '🏠',
    'Coffee': '☕', 'Pizza': '🍕', 'Plane': '✈️', 'Car': '🚗', 'Bicycle': '🚲',
    'Dumbbell': '🏋️', 'Camera': '📷', 'Headphones': '🎧', 'Tv': '📺', 'Smartphone': '📱',
    'Laptop': '💻', 'Watch': '⌚', 'Key': '🔑', 'Lock': '🔒', 'Shield': '🛡️',
    'Zap': '⚡', 'Fire': '🔥', 'Sun': '☀️', 'Moon': '🌙',
    'Umbrella': '☂️', 'Map': '🗺️', 'Compass': '🧭',
    'Anchor': '⚓', 'Rocket': '🚀', 'Sparkles': '✨', 'Crown': '👑'
  };
  return iconMap[icon] || '📁';
};

// 渲染分享页面 HTML
const renderHtml = (collection: SharedCollection | null, error?: string): string => {
  if (error || !collection) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>链接已过期</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh; 
      display: flex; 
      align-items: center; 
      justify-content: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
    }
    .container { text-align: center; padding: 2rem; }
    .icon { font-size: 4rem; margin-bottom: 1rem; opacity: 0.8; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { opacity: 0.8; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⏰</div>
    <h1>链接已过期或不存在</h1>
    <p>该分享链接可能已过期或被删除</p>
  </div>
</body>
</html>`;
  }

  // 按分类分组
  const categoryGroups = groupByCategory(collection.links);
  
  // 生成分类和链接的 HTML
  let contentHtml = '';
  categoryGroups.forEach((group, catId) => {
    const linksHtml = group.links.map(link => `
      <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="card">
        <div class="card-icon">
          ${link.icon ? `<img src="${escapeHtml(link.icon)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="icon-fallback" style="display:none">${getInitial(link.title)}</div>` : `<div class="icon-fallback">${getInitial(link.title)}</div>`}
        </div>
        <div class="card-content">
          <div class="card-title">${escapeHtml(link.title)}</div>
          ${link.description ? `<div class="card-desc">${escapeHtml(link.description)}</div>` : ''}
        </div>
      </a>
    `).join('');

    contentHtml += `
      <div class="category-section">
        <div class="category-header">
          <span class="category-icon">${getCategoryEmoji(group.icon)}</span>
          <span class="category-name">${escapeHtml(group.name)}</span>
          <span class="category-count">${group.links.length}</span>
        </div>
        <div class="grid">
          ${linksHtml}
        </div>
      </div>
    `;
  });

  const expiresIn = collection.expiresAt - Math.floor(Date.now() / 1000);
  const expiresInText = expiresIn > 3600 
    ? `${Math.floor(expiresIn / 3600)} 小时` 
    : `${Math.floor(expiresIn / 60)} 分钟`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(collection.title)} - CloudNav 分享</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh; 
      background: #f8fafc;
      color: #1e293b;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #f1f5f9; }
      .header { background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); }
      .card { background: #1e293b; border-color: #334155; }
      .card:hover { background: #253247; border-color: #475569; }
      .card-desc { color: #94a3b8; }
      .footer { color: #64748b; }
      .meta { color: #64748b; background: rgba(255,255,255,0.1); }
      .category-header { background: #1e293b; border-color: #334155; }
      .category-name { color: #f1f5f9; }
      .category-count { background: #334155; color: #94a3b8; }
    }
    .header {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      padding: 2.5rem 1.5rem;
      text-align: center;
    }
    .header h1 { 
      font-size: 1.75rem; 
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .header p { 
      opacity: 0.9; 
      font-size: 0.95rem;
      max-width: 500px;
      margin: 0 auto;
    }
    .meta {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 1rem;
      padding: 0.4rem 0.8rem;
      background: rgba(255,255,255,0.15);
      border-radius: 2rem;
      font-size: 0.75rem;
      opacity: 0.9;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 1.5rem;
    }
    .category-section {
      margin-bottom: 2rem;
    }
    .category-section:last-child {
      margin-bottom: 0;
    }
    .category-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      margin-bottom: 1rem;
    }
    .category-icon {
      font-size: 1.25rem;
    }
    .category-name {
      font-weight: 600;
      font-size: 0.95rem;
      color: #1e293b;
      flex: 1;
    }
    .category-count {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      background: #f1f5f9;
      color: #64748b;
      border-radius: 1rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .card {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      text-decoration: none;
      color: inherit;
      transition: all 0.2s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
      border-color: #8b5cf6;
    }
    .card-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      overflow: hidden;
      flex-shrink: 0;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card-icon img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .icon-fallback {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 1rem;
      color: #6366f1;
      background: linear-gradient(135deg, #e0e7ff 0%, #ddd6fe 100%);
    }
    .card-content {
      flex: 1;
      min-width: 0;
    }
    .card-title {
      font-weight: 600;
      font-size: 0.9rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-desc {
      font-size: 0.75rem;
      color: #64748b;
      margin-top: 0.2rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .footer {
      text-align: center;
      padding: 2rem 1rem;
      color: #94a3b8;
      font-size: 0.8rem;
    }
    .footer a {
      color: #6366f1;
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(collection.title)}</h1>
    ${collection.description ? `<p>${escapeHtml(collection.description)}</p>` : ''}
    <div class="meta">
      <span>${collection.links.length} 个链接</span>
      <span>·</span>
      <span>${categoryGroups.size} 个分类</span>
      <span>·</span>
      <span>${expiresInText}后过期</span>
    </div>
  </div>
  <div class="container">
    ${contentHtml}
  </div>
  <div class="footer">
    由 <a href="https://github.com/Fire-M/CloudNav-Oorz" target="_blank">CloudNav</a> 生成
  </div>
</body>
</html>`;
};

const escapeHtml = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const getInitial = (title: string): string => {
  return title.charAt(0).toUpperCase() || '?';
};

export const onRequestGet = async ({ params, env }: { params: { token?: string }; env: Env }) => {
  const token = params.token;

  if (!token) {
    return new Response(renderHtml(null, 'Not found'), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  try {
    const data = await env.CLOUDNAV_KV.get(`share:${token}`);
    
    if (!data) {
      return new Response(renderHtml(null, 'Not found'), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const collection: SharedCollection = JSON.parse(data);
    
    // 更新访问计数
    collection.viewCount = (collection.viewCount || 0) + 1;
    await env.CLOUDNAV_KV.put(`share:${token}`, JSON.stringify(collection), {
      expiration: collection.expiresAt
    });

    return new Response(renderHtml(collection), {
      status: 200,
      headers: { 
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      },
    });
  } catch (e) {
    return new Response(renderHtml(null, 'Error'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
};
