
import { Category, LinkItem, WebDavConfig, SearchConfig, AIConfig } from "../types";

type BackupPayload = {
    links: LinkItem[],
    categories: Category[],
    searchConfig?: SearchConfig,
    aiConfig?: AIConfig,
    webDavConfig?: WebDavConfig
};

type ProxyResult = {
    success?: boolean,
    status?: number,
    error?: string,
    links?: LinkItem[],
    categories?: Category[],
    searchConfig?: SearchConfig,
    aiConfig?: AIConfig,
    webDavConfig?: WebDavConfig
};

// Helper to call our Cloudflare Proxy
// This solves the CORS issue by delegating the request to the backend
const callWebDavProxy = async (operation: 'check' | 'upload' | 'download', config: WebDavConfig, payload?: any, filename?: string, authToken?: string, authIssuedAt?: string): Promise<ProxyResult> => {
    try {
        const response = await fetch('/api/webdav', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authToken ? { 'x-auth-password': authToken } : {}),
                ...(authIssuedAt ? { 'x-auth-issued-at': authIssuedAt } : {}),
            },
            body: JSON.stringify({
                operation,
                config,
                payload,
                filename
            })
        });
        
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            console.error(`WebDAV Proxy Error: ${response.status}`, data);
            return {
                success: false,
                status: response.status,
                error: data?.error || `HTTP ${response.status}`
            };
        }

        return data;
    } catch (e) {
        console.error("WebDAV Proxy Network Error", e);
        return {
            success: false,
            error: e instanceof Error ? e.message : 'Network Error'
        };
    }
}

export const checkWebDavConnection = async (config: WebDavConfig, authToken?: string, authIssuedAt?: string): Promise<{ success: boolean; error?: string }> => {
    if (!config.url || !config.username || !config.password) {
        return { success: false, error: '请先填完整 WebDAV 配置' };
    }
    const result = await callWebDavProxy('check', config, undefined, undefined, authToken, authIssuedAt);
    return {
        success: result?.success === true,
        error: result?.success === true ? undefined : result?.error || '连接失败'
    };
};

export const uploadBackup = async (config: WebDavConfig, data: BackupPayload, authToken?: string, authIssuedAt?: string): Promise<{ success: boolean; error?: string }> => {
    const result = await callWebDavProxy('upload', config, data, undefined, authToken, authIssuedAt);
    return {
        success: result?.success === true,
        error: result?.success === true ? undefined : result?.error || '上传失败'
    };
};

export const uploadBackupWithTimestamp = async (config: WebDavConfig, data: BackupPayload, authToken?: string, authIssuedAt?: string): Promise<{ success: boolean; filename: string; error?: string }> => {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    const filename = `cloudnav_backup_${timestamp}.json`;
    const result = await callWebDavProxy('upload', config, data, filename, authToken, authIssuedAt);
    return {
        success: result?.success === true,
        filename,
        error: result?.success === true ? undefined : result?.error || '上传失败'
    };
};

export const downloadBackup = async (config: WebDavConfig, authToken?: string, authIssuedAt?: string): Promise<ProxyResult> => {
    const result = await callWebDavProxy('download', config, undefined, undefined, authToken, authIssuedAt);
    
    // Check if the result looks like valid backup data
    if (result && Array.isArray(result.links) && Array.isArray(result.categories)) {
        return result;
    }
    return {
        success: false,
        error: result?.error || '下载失败',
        status: result?.status
    };
};
