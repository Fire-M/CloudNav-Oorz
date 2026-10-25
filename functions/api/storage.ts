interface Env {
  CLOUDNAV_KV: any;
  PASSWORD: string;
}

interface WebsiteConfig {
  title?: string;
  navTitle?: string;
  favicon?: string;
  cardStyle?: 'detailed' | 'simple';
  requirePasswordOnVisit?: boolean;
  passwordExpiryDays?: number;
  backgroundImage?: string;
  backgroundImageType?: 'url' | 'upload';
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, x-auth-password, ${AUTH_TIME_HEADER}`,
  };
};

const getWebsiteConfig = async (env: Env): Promise<WebsiteConfig> => {
  const websiteConfigStr = await env.CLOUDNAV_KV.get('website_config');
  return websiteConfigStr
    ? JSON.parse(websiteConfigStr)
    : { requirePasswordOnVisit: false, passwordExpiryDays: 7 };
};

const buildUnauthorizedResponse = (message: string, corsHeaders: Record<string, string>) =>
  new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

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
      response: buildUnauthorizedResponse('Unauthorized', corsHeaders),
    };
  }

  const websiteConfig = await getWebsiteConfig(env);
  const passwordExpiryDays = websiteConfig.passwordExpiryDays ?? 7;

  if (options.requireSession && passwordExpiryDays > 0) {
    const authIssuedAtRaw = request.headers.get(AUTH_TIME_HEADER);
    const authIssuedAt = authIssuedAtRaw ? Number(authIssuedAtRaw) : NaN;
    const expiryMs = passwordExpiryDays * 24 * 60 * 60 * 1000;

    if (Number.isFinite(authIssuedAt) && authIssuedAt > 0 && Date.now() - authIssuedAt > expiryMs) {
      return {
        ok: false,
        response: buildUnauthorizedResponse('密码已过期，请重新输入', corsHeaders),
      };
    }
  }

  return {
    ok: true,
    websiteConfig,
  };
};

const normalizeDomain = (rawDomain: string | null) => {
  if (!rawDomain) return '';

  try {
    const value = rawDomain.startsWith('http://') || rawDomain.startsWith('https://')
      ? rawDomain
      : `https://${rawDomain}`;
    return new URL(value).hostname;
  } catch {
    return rawDomain.trim();
  }
};

const toBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

const fetchAndEncodeImage = async (imageUrl: string) => {
  try {
    const response = await fetch(imageUrl, {
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) return null;

    const contentType = response.headers.get('content-type') || 'image/png';
    return `data:${contentType};base64,${toBase64(arrayBuffer)}`;
  } catch {
    return null;
  }
};

const fetchAndEncodeFavicon = async (domain: string) => {
  const providers = [
    `https://www.faviconextractor.com/favicon/${encodeURIComponent(domain)}?larger=true`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
  ];

  for (const iconUrl of providers) {
    const encoded = await fetchAndEncodeImage(iconUrl);
    if (encoded) return encoded;
  }

  return null;
};

// 处理 OPTIONS 请求（解决跨域预检）
export const onRequestOptions = async (context: { request: Request }) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(context.request),
  });
};

// GET: 获取数据
export const onRequestGet = async (context: { env: Env; request: Request }) => {
  const corsHeaders = getCorsHeaders(context.request);
  try {
    const { env, request } = context;
    const url = new URL(request.url);
    const checkAuth = url.searchParams.get('checkAuth');
    const getConfig = url.searchParams.get('getConfig');
    const websiteConfig = await getWebsiteConfig(env);
    const serverPassword = env.PASSWORD;
    const requiresAuth = !!serverPassword && !!websiteConfig.requirePasswordOnVisit;
    
    // 如果是检查认证请求，返回是否设置了密码
    if (checkAuth === 'true') {
      return new Response(JSON.stringify({ 
        hasPassword: !!serverPassword,
        requiresAuth
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 如果是获取配置请求
    if (getConfig === 'ai') {
      const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
      if (!authCheck.ok) {
        return authCheck.response;
      }
      const aiConfig = await env.CLOUDNAV_KV.get('ai_config');
      return new Response(aiConfig || '{}', {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 如果是获取搜索配置请求
    if (getConfig === 'search') {
      const searchConfig = await env.CLOUDNAV_KV.get('search_config');
      return new Response(searchConfig || '{}', {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (getConfig === 'webdav') {
      const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
      if (!authCheck.ok) {
        return authCheck.response;
      }
      const webDavConfig = await env.CLOUDNAV_KV.get('webdav_config');
      return new Response(webDavConfig || '{}', {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 如果是获取网站配置请求
    if (getConfig === 'website') {
      return new Response(JSON.stringify({
        requirePasswordOnVisit: false,
        passwordExpiryDays: 7,
        ...websiteConfig,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 批量获取所有配置（搜索+网站+WebDAV）
    if (getConfig === 'all') {
      const searchConfig = await env.CLOUDNAV_KV.get('search_config');
      const websiteData = {
        requirePasswordOnVisit: false,
        passwordExpiryDays: 7,
        ...websiteConfig,
      };

      // 背景图不在此处返回，由客户端单独请求（避免大数据量导致响应慢）
      // 清除可能存在的 backgroundImage 字段（上传类型时为空字符串）
      if (websiteConfig?.backgroundImageType === 'upload') {
        websiteData.backgroundImage = ''; // 不在此返回，需要时单独请求
      }

      // WebDAV 配置需要认证
      let webDavData = null;
      const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: false });
      if (authCheck.ok) {
        const webDavConfig = await env.CLOUDNAV_KV.get('webdav_config');
        if (webDavConfig) {
          try { webDavData = JSON.parse(webDavConfig); } catch {}
        }
      }

      return new Response(JSON.stringify({
        search: searchConfig ? JSON.parse(searchConfig) : null,
        website: websiteData,
        webdav: webDavData,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 如果是获取图标请求
    if (getConfig === 'favicon') {
      const domain = normalizeDomain(url.searchParams.get('domain'));
      const shouldFetch = url.searchParams.get('fetch') === 'true';
      if (!domain) {
        return new Response(JSON.stringify({ error: 'Domain parameter is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      
      // 从KV中获取缓存的图标
      const cachedIcon = await env.CLOUDNAV_KV.get(`favicon:${domain}`);
      if (cachedIcon && (!shouldFetch || cachedIcon.startsWith('data:'))) {
        return new Response(JSON.stringify({ icon: cachedIcon, cached: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (shouldFetch) {
        const fetchedIcon = await fetchAndEncodeFavicon(domain);

        if (fetchedIcon) {
          await env.CLOUDNAV_KV.put(`favicon:${domain}`, fetchedIcon);
          return new Response(JSON.stringify({ icon: fetchedIcon, cached: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        if (cachedIcon) {
          return new Response(JSON.stringify({ icon: cachedIcon, cached: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }
      
      // 如果没有缓存，返回空结果
      return new Response(JSON.stringify({ icon: null, cached: false }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 获取背景图
    if (getConfig === 'background') {
      const bgData = await env.CLOUDNAV_KV.get('background_image');
      return new Response(JSON.stringify({ image: bgData }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 从 KV 中读取数据（首页开放访问，不需要认证）
    let data = await env.CLOUDNAV_KV.get('app_data');

    if (!data) {
      // 如果没有数据，返回空结构
      return new Response(JSON.stringify({ links: [], categories: [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 服务端迁移：剥离 app_data 中的 base64 图标，存入 favicon 缓存
    try {
      const parsed = JSON.parse(data);
      if (parsed.links && Array.isArray(parsed.links)) {
        let hasBase64 = false;
        const iconWrites: Promise<void>[] = [];

        const cleanedLinks = parsed.links.map((link: any) => {
          if (link.icon && typeof link.icon === 'string' && link.icon.startsWith('data:') && link.url) {
            hasBase64 = true;
            const domain = normalizeDomain(link.url);
            if (domain) {
              // 异步写入 favicon 缓存（不阻塞响应）
              iconWrites.push(
                env.CLOUDNAV_KV.put(`favicon:${domain}`, link.icon).catch(() => {})
              );
            }
            const { icon, ...rest } = link;
            return rest;
          }
          return link;
        });

        if (hasBase64) {
          // 等待图标写入完成，确保前端后续请求能命中缓存
          await Promise.all(iconWrites);
          // 回写精简后的数据到 KV（异步，不阻塞当前响应）
          const cleanedData = JSON.stringify({ ...parsed, links: cleanedLinks });
          env.CLOUDNAV_KV.put('app_data', cleanedData).catch(() => {});
          // 使用精简数据作为本次响应
          data = cleanedData;
        }
      }
    } catch {}

    // 返回前剔除分类密码明文，只留 hasPassword 标记
    // 否则任何人 GET 这个接口就能拿到全部目录密码
    try {
      const parsed = JSON.parse(data);
      if (parsed.categories && Array.isArray(parsed.categories)) {
        parsed.categories = parsed.categories.map((cat: any) => {
          if (!cat || !cat.password) return cat;
          const { password, ...rest } = cat;
          return { ...rest, hasPassword: true };
        });
        data = JSON.stringify(parsed);
      }
    } catch {}

    return new Response(data, {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to fetch data' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
};

// POST: 保存数据
export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request);

  // 1. 验证密码（对于敏感操作需要密码）
  const providedPassword = request.headers.get('x-auth-password');
  const serverPassword = env.PASSWORD;

  try {
    const body = await request.json();
    
    // 如果只是验证密码，不更新数据
    if (body.authOnly) {
      const authCheck = await validateAuth(request, env, corsHeaders);
      if (!authCheck.ok) {
        return authCheck.response;
      }
      
      return new Response(JSON.stringify({ success: true, authenticatedAt: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 验证分类密码：只需要分类密码本身，不要求站点登录态，
    // 否则没登录的人就没法解锁受保护的目录
    if (body.verifyCategory) {
      const { categoryId, password } = body.verifyCategory;
      let ok = false;
      try {
        const appData = await env.CLOUDNAV_KV.get('app_data');
        const parsed = appData ? JSON.parse(appData) : { categories: [] };
        const target = (parsed.categories || []).find((c: any) => c.id === categoryId);
        ok = !!target && !!target.password && target.password === password;
      } catch {}
      return new Response(JSON.stringify({ success: ok }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 如果是保存搜索配置（允许无密码访问，因为搜索配置不包含敏感数据）
    if (body.saveConfig === 'search') {
      // 如果服务器设置了密码，需要验证密码
      if (serverPassword) {
        const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
        if (!authCheck.ok) {
          return authCheck.response;
        }
      }
      
      await env.CLOUDNAV_KV.put('search_config', JSON.stringify(body.config));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (body.saveConfig === 'webdav') {
      const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
      if (!authCheck.ok) {
        return authCheck.response;
      }
      await env.CLOUDNAV_KV.put('webdav_config', JSON.stringify(body.config));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 保存图标也需要密码，避免任意写入缓存
    if (body.saveConfig === 'favicon') {
      const domain = normalizeDomain(body.domain);
      const { icon } = body;
      if (!domain || !icon) {
        return new Response(JSON.stringify({ error: 'Domain and icon are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (!serverPassword || providedPassword !== serverPassword) {
        const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
        if (!authCheck.ok) {
          return authCheck.response;
        }
      }
      
      let finalIcon = icon;
      if (!finalIcon.startsWith('data:')) {
        const isCustomImageUrl = /^https?:\/\//i.test(finalIcon);
        finalIcon = isCustomImageUrl
          ? await fetchAndEncodeImage(finalIcon)
          : await fetchAndEncodeFavicon(domain);
      }

      if (!finalIcon) {
        return new Response(JSON.stringify({ error: 'Failed to fetch favicon' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      await env.CLOUDNAV_KV.put(`favicon:${domain}`, finalIcon);
      return new Response(JSON.stringify({ success: true, icon: finalIcon }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 对于其他操作（保存AI配置、应用数据等），需要密码验证
    if (serverPassword) {
      const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
      if (!authCheck.ok) {
        return authCheck.response;
      }
    } else {
      return new Response(JSON.stringify({ error: 'Server misconfigured: PASSWORD not set' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 如果是保存AI配置
    if (body.saveConfig === 'ai') {
      await env.CLOUDNAV_KV.put('ai_config', JSON.stringify(body.config));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 如果是保存网站配置
    if (body.saveConfig === 'website') {
      await env.CLOUDNAV_KV.put('website_config', JSON.stringify(body.config));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 如果是保存背景图
    if (body.saveConfig === 'background') {
      const { image } = body;
      if (!serverPassword || providedPassword !== serverPassword) {
        const authCheck = await validateAuth(request, env, corsHeaders, { requireSession: true });
        if (!authCheck.ok) {
          return authCheck.response;
        }
      }
      
      if (image) {
        // 检查图片大小（限制 10MB）
        const sizeInBytes = Math.ceil((image.length * 3) / 4);
        if (sizeInBytes > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: '图片大小不能超过 10MB' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        await env.CLOUDNAV_KV.put('background_image', image);
      } else {
        // 删除背景图
        await env.CLOUDNAV_KV.delete('background_image');
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    
    // 分类密码不在 GET 里下发，保存时按 id 从旧数据补齐，
    // 否则前端拿不到明文、回写时就会把密码清空
    let payload = body;
    if (Array.isArray(body.categories)) {
      let oldCategories: any[] = [];
      try {
        const oldData = await env.CLOUDNAV_KV.get('app_data');
        oldCategories = oldData ? (JSON.parse(oldData).categories || []) : [];
      } catch {}

      const oldPasswords = new Map(
        oldCategories.filter((c: any) => c && c.password).map((c: any) => [c.id, c.password])
      );

      payload = {
        ...body,
        categories: body.categories.map((cat: any) => {
          if (!cat) return cat;
          const { hasPassword, ...rest } = cat;
          // 请求里明确带了 password 字段才更新密码，否则保留服务端已有的
          if (Object.prototype.hasOwnProperty.call(rest, 'password')) return rest;
          const old = oldPasswords.get(cat.id);
          return old ? { ...rest, password: old } : rest;
        }),
      };
    }

    // 将数据写入 KV
    await env.CLOUDNAV_KV.put('app_data', JSON.stringify(payload));

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to save data' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
};
