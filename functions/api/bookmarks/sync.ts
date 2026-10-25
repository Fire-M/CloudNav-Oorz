interface Env {
  CLOUDNAV_KV: any;
  PASSWORD: string;
}

interface FolderPayload {
  id: string;
  title: string;
  parentId?: string;
  depth?: number;
}

interface LinkPayload {
  id: string;
  title: string;
  url: string;
  folderId?: string;
  dateAdded?: number;
}

const AUTH_TIME_HEADER = 'x-auth-issued-at';
const ROOT_CATEGORY_ID = 'browser_bookmarks';

const getCorsHeaders = (request: Request) => {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowOrigin = origin && (
    origin === requestUrl.origin ||
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://')
  ) ? origin : requestUrl.origin;

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, x-auth-password, ${AUTH_TIME_HEADER}`,
  };
};

const buildError = (message: string, status: number, corsHeaders: Record<string, string>) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

const getWebsiteConfig = async (env: Env) => {
  const raw = await env.CLOUDNAV_KV.get('website_config');
  return raw ? JSON.parse(raw) : { passwordExpiryDays: 7 };
};

// 与前端 ImportModal 的 normalizeUrl 保持一致，保证手动导入与自动同步判定同一条链接
const normalizeUrl = (rawUrl: string): string => {
  let u = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
  try {
    const urlObj = new URL(u);
    urlObj.hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return urlObj.toString().replace(/\/+$/, '');
  } catch {
    return u.toLowerCase();
  }
};

const validateAuth = async (
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
  options: { requireSession?: boolean } = {}
) => {
  const serverPassword = env.PASSWORD;
  if (!serverPassword) {
    return { ok: true };
  }

  const providedPassword = request.headers.get('x-auth-password');
  if (!providedPassword || providedPassword !== serverPassword) {
    return {
      ok: false,
      response: buildError('Unauthorized', 401, corsHeaders),
    };
  }

  if (options.requireSession) {
    const websiteConfig = await getWebsiteConfig(env);
    const passwordExpiryDays = websiteConfig.passwordExpiryDays ?? 7;

    if (passwordExpiryDays > 0) {
      const authIssuedAtRaw = request.headers.get(AUTH_TIME_HEADER);
      const authIssuedAt = authIssuedAtRaw ? Number(authIssuedAtRaw) : NaN;
      const expiryMs = passwordExpiryDays * 24 * 60 * 60 * 1000;

      if (Number.isFinite(authIssuedAt) && authIssuedAt > 0 && Date.now() - authIssuedAt > expiryMs) {
        return {
          ok: false,
          response: buildError('密码已过期，请重新输入', 401, corsHeaders),
        };
      }
    }
  }

  return { ok: true };
};

export const onRequestOptions = async (context: { request: Request }) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(context.request),
  });
};

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request);

  const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
  if (!authCheck.ok) {
    return authCheck.response;
  }

  try {
    const body = await request.json() as any;
    const folders: FolderPayload[] = Array.isArray(body.folders) ? body.folders : [];
    const links: LinkPayload[] = Array.isArray(body.links) ? body.links : [];

    if (folders.length === 0 && links.length === 0) {
      return new Response(JSON.stringify({ success: true, added: 0, skipped: 0, categoriesAdded: 0 }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const raw = await env.CLOUDNAV_KV.get('app_data');
    const data = raw ? JSON.parse(raw) : { links: [], categories: [] };
    if (!Array.isArray(data.links)) data.links = [];
    if (!Array.isArray(data.categories)) data.categories = [];

    // 1. 固定容器：收藏夹内容全部挂在"浏览器收藏夹"下，与手工整理的分类隔离
    if (!data.categories.some((c: any) => c.id === ROOT_CATEGORY_ID)) {
      data.categories.push({ id: ROOT_CATEGORY_ID, name: '浏览器收藏夹', icon: 'Bookmark' });
    }

    // 2. 文件夹 -> 分类，完整保留收藏夹原始层级
    //    顶级文件夹（收藏夹栏/其他收藏夹）parentId 为空，挂到容器下
    let categoriesAdded = 0;
    let categoriesUpdated = 0;
    for (const folder of folders) {
      if (!folder || !folder.id) continue;

      const name = folder.title || '未命名文件夹';
      const existing = data.categories.find((c: any) => c.id === folder.id);

      if (existing) {
        // 收藏夹里改了文件夹名，这次同步把它改名过来
        if (existing.name !== name) {
          existing.name = name;
          categoriesUpdated++;
        }
        continue;
      }

      data.categories.push({
        id: folder.id,
        name: name,
        icon: 'Folder',
        parentId: folder.parentId || ROOT_CATEGORY_ID,
      });
      categoriesAdded++;
    }

    // 5. 链接去重（同时防止同一批次内部重复）
    const existingUrls = new Set<string>();
    for (const item of data.links as any[]) {
      if (item && item.url) existingUrls.add(normalizeUrl(item.url));
    }

    let added = 0;
    let skipped = 0;
    for (const link of links) {
      if (!link || !link.url) continue;
      const key = normalizeUrl(link.url);
      if (existingUrls.has(key)) {
        skipped++;
        continue;
      }
      existingUrls.add(key);
      data.links.push({
        id: link.id || ('bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
        title: link.title || link.url,
        url: link.url,
        categoryId: link.folderId || ROOT_CATEGORY_ID,
        createdAt: link.dateAdded || Date.now(),
        pinned: false,
      });
      added++;
    }

    await env.CLOUDNAV_KV.put('app_data', JSON.stringify(data));

    return new Response(JSON.stringify({
      success: true,
      added,
      skipped,
      categoriesAdded,
      categoriesUpdated,
      total: data.links.length,
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
};
