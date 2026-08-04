interface Env {
  CLOUDNAV_KV: any;
  PASSWORD: string;
}

const AUTH_TIME_HEADER = 'x-auth-issued-at';

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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, x-auth-password, ${AUTH_TIME_HEADER}`,
  };
};

const jsonResponse = (data: any, corsHeaders: Record<string, string>, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

const validateAuth = async (request: Request, env: Env, corsHeaders: Record<string, string>) => {
  const serverPassword = env.PASSWORD;
  if (!serverPassword) return { ok: true };

  const providedPassword = request.headers.get('x-auth-password');
  if (!providedPassword || providedPassword !== serverPassword) {
    return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, corsHeaders, 401) };
  }

  return { ok: true };
};

// 生成随机 token
const generateToken = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

export const onRequestOptions = async ({ request }: { request: Request }) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request),
  });
};

// GET /api/share?id={token} - 获取分享数据（公开访问）
export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const corsHeaders = getCorsHeaders(request);
  const requestUrl = new URL(request.url);
  const token = requestUrl.searchParams.get('id');

  if (!token) {
    return jsonResponse({ error: 'Missing id parameter' }, corsHeaders, 400);
  }

  try {
    const data = await env.CLOUDNAV_KV.get(`share:${token}`);
    if (!data) {
      return jsonResponse({ error: 'Share not found or expired' }, corsHeaders, 404);
    }

    const collection = JSON.parse(data);
    
    // 可选：增加访问计数
    collection.viewCount = (collection.viewCount || 0) + 1;
    await env.CLOUDNAV_KV.put(`share:${token}`, JSON.stringify(collection), {
      expiration: collection.expiresAt
    });

    return jsonResponse(collection, corsHeaders);
  } catch (e: any) {
    return jsonResponse({ error: e.message || 'Internal error' }, corsHeaders, 500);
  }
};

// POST /api/share - 创建分享（需要鉴权）
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const corsHeaders = getCorsHeaders(request);

  const authResult = await validateAuth(request, env, corsHeaders);
  if (!authResult.ok) return authResult.response;

  try {
    const body = await request.json() as {
      title?: string;
      description?: string;
      links?: any[];
      expiresIn?: number;
    };

    const { title, description, links, expiresIn = 3600 } = body; // 默认 1 小时过期

    if (!title || !links || links.length === 0) {
      return jsonResponse({ error: 'Title and links are required' }, corsHeaders, 400);
    }

    // 限制链接数量
    if (links.length > 100) {
      return jsonResponse({ error: 'Maximum 100 links per share' }, corsHeaders, 400);
    }

    // 限制过期时间（最大 30 天）
    const maxExpiry = 30 * 24 * 60 * 60;
    const actualExpiresIn = Math.min(expiresIn, maxExpiry);

    const token = generateToken();
    const now = Date.now();
    const expiresAt = Math.floor(now / 1000) + actualExpiresIn; // Unix timestamp in seconds

    const collection = {
      id: token,
      title,
      description: description || '',
      links: links.map(l => ({
        title: l.title || 'Untitled',
        url: l.url || '',
        icon: l.icon || '',
        description: l.description || ''
      })),
      createdAt: now,
      expiresAt: expiresAt,
      viewCount: 0
    };

    await env.CLOUDNAV_KV.put(`share:${token}`, JSON.stringify(collection), {
      expirationTtl: actualExpiresIn
    });

    const requestUrl = new URL(request.url);
    const shareUrl = `${requestUrl.origin}/share/${token}`;

    return jsonResponse({
      token,
      url: shareUrl,
      expiresAt
    }, corsHeaders);

  } catch (e: any) {
    return jsonResponse({ error: e.message || 'Internal error' }, corsHeaders, 500);
  }
};

// DELETE /api/share?id={token} - 删除分享（需要鉴权）
export const onRequestDelete = async ({ request, env }: { request: Request; env: Env }) => {
  const corsHeaders = getCorsHeaders(request);

  const authResult = await validateAuth(request, env, corsHeaders);
  if (!authResult.ok) return authResult.response;

  const requestUrl = new URL(request.url);
  const token = requestUrl.searchParams.get('id');

  if (!token) {
    return jsonResponse({ error: 'Missing id parameter' }, corsHeaders, 400);
  }

  try {
    await env.CLOUDNAV_KV.delete(`share:${token}`);
    return jsonResponse({ success: true }, corsHeaders);
  } catch (e: any) {
    return jsonResponse({ error: e.message || 'Internal error' }, corsHeaders, 500);
  }
};
