import React, { useState, useEffect } from 'react';
import { X, Share2, Copy, Check, Link2, Clock, Loader2 } from 'lucide-react';
import { LinkItem } from '../types';
import { alertDialog } from './ConfirmDialog';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  links: LinkItem[];
  selectedLinks?: LinkItem[];
  authToken: string;
  authIssuedAt?: string;
}

const ShareModal: React.FC<ShareModalProps> = ({ 
  isOpen, onClose, links, selectedLinks = [], authToken, authIssuedAt 
}) => {
  const [step, setStep] = useState<'select' | 'result'>('select');
  const [title, setTitle] = useState('我的书签合集');
  const [description, setDescription] = useState('');
  const [expiresIn, setExpiresIn] = useState(3600); // 默认 1 小时
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [isCreating, setIsCreating] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep('select');
      setShareUrl('');
      setCopied(false);
      setTitle('我的书签合集');
      setDescription('');
      setExpiresIn(3600);
      // 默认选中传入的 selectedLinks，如果没有则选中所有
      if (selectedLinks.length > 0) {
        setCheckedIds(new Set(selectedLinks.map(l => l.id)));
      } else {
        setCheckedIds(new Set(links.map(l => l.id)));
      }
    }
  }, [isOpen, links, selectedLinks]);

  const toggleLink = (id: string) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setCheckedIds(new Set(links.map(l => l.id)));
  };

  const deselectAll = () => {
    setCheckedIds(new Set());
  };

  const handleCreate = async () => {
    if (checkedIds.size === 0) {
      alertDialog({ message: '请至少选择一个链接', variant: 'warning', title: '提示' });
      return;
    }

    setIsCreating(true);
    try {
      const selectedLinksData = links
        .filter(l => checkedIds.has(l.id))
        .map(l => ({
          title: l.title,
          url: l.url,
          icon: l.icon || '',
          description: l.description || ''
        }));

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-auth-password': authToken
      };
      if (authIssuedAt) {
        headers['x-auth-issued-at'] = authIssuedAt;
      }

      const res = await fetch('/api/share', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title,
          description,
          links: selectedLinksData,
          expiresIn
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '创建失败' }));
        throw new Error(err.error || '创建失败');
      }

      const data = await res.json();
      setShareUrl(data.url);
      setStep('result');
    } catch (e: any) {
      alertDialog({ message: e.message || '创建分享失败', variant: 'danger', title: '错误' });
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!isOpen) return null;

  const expiryOptions = [
    { value: 3600, label: '1 小时' },
    { value: 86400, label: '1 天' },
    { value: 259200, label: '3 天' },
    { value: 604800, label: '7 天' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border border-slate-200 dark:border-slate-700">
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <Share2 size={20} className="text-purple-500" />
            <h3 className="text-lg font-semibold dark:text-white">
              {step === 'select' ? '分享书签' : '分享链接已生成'}
            </h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors">
            <X className="w-5 h-5 dark:text-slate-400" />
          </button>
        </div>

        {/* Content */}
        {step === 'select' ? (
          <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
            {/* 标题 */}
            <div>
              <label className="block text-sm font-medium mb-1 dark:text-slate-300">合集标题</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white focus:ring-2 focus:ring-purple-500 outline-none transition-all"
                placeholder="我的书签合集"
              />
            </div>

            {/* 描述 */}
            <div>
              <label className="block text-sm font-medium mb-1 dark:text-slate-300">描述 (可选)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white focus:ring-2 focus:ring-purple-500 outline-none transition-all h-16 resize-none"
                placeholder="简短描述..."
              />
            </div>

            {/* 过期时间 */}
            <div>
              <label className="block text-sm font-medium mb-2 dark:text-slate-300">
                <Clock size={14} className="inline mr-1" />
                过期时间
              </label>
              <div className="flex gap-2">
                {expiryOptions.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setExpiresIn(opt.value)}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                      expiresIn === opt.value
                        ? 'bg-purple-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 链接选择 */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-medium dark:text-slate-300">
                  选择链接 ({checkedIds.size}/{links.length})
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={selectAll}
                    className="text-xs text-purple-600 dark:text-purple-400 hover:underline"
                  >
                    全选
                  </button>
                  <button
                    onClick={deselectAll}
                    className="text-xs text-slate-500 hover:underline"
                  >
                    取消全选
                  </button>
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-700">
                {links.map(link => (
                  <label
                    key={link.id}
                    className="flex items-center gap-3 p-2 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checkedIds.has(link.id)}
                      onChange={() => toggleLink(link.id)}
                      className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-slate-300 rounded dark:border-slate-600 dark:bg-slate-700"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                        {link.title}
                      </div>
                      <div className="text-xs text-slate-400 truncate">{link.url}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            {/* 成功提示 */}
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <Check size={32} className="text-green-600 dark:text-green-400" />
              </div>
              <h4 className="text-lg font-semibold dark:text-white mb-1">分享链接已生成</h4>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {expiryOptions.find(o => o.value === expiresIn)?.label}后过期
              </p>
            </div>

            {/* 链接显示 */}
            <div className="flex items-center gap-2 p-3 bg-slate-100 dark:bg-slate-700 rounded-lg">
              <Link2 size={16} className="text-slate-400 shrink-0" />
              <input
                type="text"
                readOnly
                value={shareUrl}
                className="flex-1 bg-transparent text-sm text-slate-700 dark:text-slate-300 outline-none truncate"
              />
              <button
                onClick={handleCopy}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  copied
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                    : 'bg-purple-600 hover:bg-purple-700 text-white'
                }`}
              >
                {copied ? (
                  <>
                    <Check size={14} />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy size={14} />
                    复制
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
          {step === 'select' ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={isCreating || checkedIds.size === 0}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {isCreating ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    生成中...
                  </>
                ) : (
                  <>
                    <Share2 size={14} />
                    生成分享链接
                  </>
                )}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors"
            >
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShareModal;
