interface Env {
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

  // 简单校验密码即可，不强制检查过期（检测操作是临时的）
  return { ok: true };
};

// 检查 Wayback Machine 是否有归档快照
const checkWaybackArchive = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const archivedUrl = data?.archived_snapshots?.closest?.url;
    if (archivedUrl && data.archived_snapshots.closest.available) {
      return archivedUrl;
    }
    return null;
  } catch {
    return null;
  }
};

export const onRequestOptions = async ({ request }: { request: Request }) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request),
  });
};

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const corsHeaders = getCorsHeaders(request);

  const authResult = await validateAuth(request, env, corsHeaders);
  if (!authResult.ok) return authResult.response;

  try {
    const body = await request.json() as { url?: string };
    const url = body?.url;

    if (!url) {
      return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
    }

    // 确保 URL 有协议
    let checkUrl = url;
    if (!checkUrl.startsWith('http://') && !checkUrl.startsWith('https://')) {
      checkUrl = 'https://' + checkUrl;
    }

    // 验证 URL 格式
    try {
      new URL(checkUrl);
    } catch {
      return jsonResponse({ url, alive: false, status: 0, error: 'Invalid URL' }, corsHeaders);
    }

    // 发起 HEAD 请求检测链接是否存活
    let status = 0;
    let alive = false;
    let errorMessage = '';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(checkUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'CloudNav-LinkChecker/1.0',
        },
        // @ts-ignore - Cloudflare Workers specific
        cf: {
          cacheTtl: 0,
        },
      });

      clearTimeout(timeout);
      status = res.status;
      // 2xx 和 3xx 都视为存活
      alive = status >= 200 && status < 400;
    } catch (e: any) {
      // 如果 HEAD 失败（某些网站不支持 HEAD），尝试 GET
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(checkUrl, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'CloudNav-LinkChecker/1.0',
          },
          // @ts-ignore - Cloudflare Workers specific
          cf: {
            cacheTtl: 0,
          },
        });

        clearTimeout(timeout);
        status = res.status;
        alive = status >= 200 && status < 400;
      } catch (e2: any) {
        status = 0;
        alive = false;
        if (e2.name === 'AbortError') {
          errorMessage = 'Timeout';
        } else {
          errorMessage = 'Connection failed';
        }
      }
    }

    // 如果链接死亡，检查 Wayback Machine 归档
    let archiveUrl: string | null = null;
    if (!alive) {
      archiveUrl = await checkWaybackArchive(checkUrl);
    }

    return jsonResponse({
      url: checkUrl,
      alive,
      status,
      archiveUrl,
      error: errorMessage || undefined,
    }, corsHeaders);

  } catch (e: any) {
    return jsonResponse({ error: e.message || 'Internal error' }, corsHeaders, 500);
  }
};
