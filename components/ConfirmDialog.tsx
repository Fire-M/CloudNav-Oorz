import React, { useState, useCallback, useEffect } from 'react';
import { AlertTriangle, Info, CheckCircle2, HelpCircle, X } from 'lucide-react';

// --- 全局模态框服务 ---
// 通过模块级单例管理，任意组件 import { confirmDialog, alertDialog } 即可调用
type DialogType = 'confirm' | 'alert';
type DialogVariant = 'danger' | 'warning' | 'info' | 'success';

interface DialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: DialogVariant;
  type?: DialogType;
}

interface DialogState extends DialogOptions {
  isOpen: boolean;
  resolve?: (value: boolean) => void;
}

let setStateRef: ((state: DialogState) => void) | null = null;

// 弹出确认框，返回 Promise<boolean>，确定返回 true，取消/关闭返回 false
export function confirmDialog(options: Omit<DialogOptions, 'type'> | string): Promise<boolean> {
  const opts: DialogOptions = typeof options === 'string'
    ? { message: options }
    : { ...options, type: 'confirm' };
  opts.type = 'confirm';
  return openDialog(opts);
}

// 弹出提示框，返回 Promise<boolean>，点击确定返回 true
export function alertDialog(options: Omit<DialogOptions, 'type' | 'cancelText'> | string): Promise<boolean> {
  const opts: DialogOptions = typeof options === 'string'
    ? { message: options }
    : { ...options };
  opts.type = 'alert';
  return openDialog(opts);
}

function openDialog(opts: DialogOptions): Promise<boolean> {
  if (!setStateRef) {
    console.warn('ConfirmDialog host 未挂载，回退到原生弹窗');
    if (opts.type === 'alert') {
      alert(opts.message);
      return Promise.resolve(true);
    }
    return Promise.resolve(confirm(opts.message));
  }
  return new Promise<boolean>((resolve) => {
    setStateRef!({
      ...opts,
      isOpen: true,
      resolve,
    });
  });
}

// --- 模态框宿主组件 ---
// 在 App.tsx 顶层挂载一次即可
export const ConfirmDialogHost: React.FC = () => {
  const [state, setState] = useState<DialogState>({
    isOpen: false,
    message: '',
    type: 'confirm',
  });

  useEffect(() => {
    setStateRef = setState;
    return () => { setStateRef = null; };
  }, []);

  const handleClose = useCallback((result: boolean) => {
    setState(prev => {
      prev.resolve?.(result);
      return { ...prev, isOpen: false, resolve: undefined };
    });
  }, []);

  return <ConfirmDialog state={state} onClose={handleClose} />;
};

// --- 模态框 UI 组件 ---
interface ConfirmDialogProps {
  state: DialogState;
  onClose: (result: boolean) => void;
}

const variantConfig: Record<DialogVariant, { icon: React.ReactNode; color: string; bg: string; ring: string }> = {
  danger: {
    icon: <AlertTriangle size={28} />,
    color: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-100 dark:bg-red-900/30',
    ring: 'focus:ring-red-500',
  },
  warning: {
    icon: <AlertTriangle size={28} />,
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-100 dark:bg-amber-900/30',
    ring: 'focus:ring-amber-500',
  },
  info: {
    icon: <Info size={28} />,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    ring: 'focus:ring-blue-500',
  },
  success: {
    icon: <CheckCircle2 size={28} />,
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-100 dark:bg-emerald-900/30',
    ring: 'focus:ring-emerald-500',
  },
};

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ state, onClose }) => {
  if (!state.isOpen) return null;

  const variant = state.variant || 'info';
  const cfg = variantConfig[variant];
  const isConfirm = state.type !== 'alert';
  const Icon = state.variant ? null : <HelpCircle size={28} />;

  // 按变体决定确认按钮颜色
  const confirmBtnColor = variant === 'danger'
    ? 'bg-red-600 hover:bg-red-700 shadow-red-500/30'
    : variant === 'warning'
      ? 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/30'
      : variant === 'success'
        ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/30'
        : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(false);
    } else if (e.key === 'Enter' && isConfirm) {
      e.preventDefault();
      onClose(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        // alert 模式点击遮罩不关闭，confirm 模式点击遮罩视为取消
        if (isConfirm && e.target === e.currentTarget) onClose(false);
      }}
    >
      <div
        className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200 dark:border-slate-700 p-6 animate-in fade-in zoom-in duration-150"
        role="dialog"
        aria-modal="true"
      >
        {isConfirm && (
          <button
            type="button"
            onClick={() => onClose(false)}
            className="absolute right-4 top-4 p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 dark:hover:text-slate-200 transition-colors"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        )}

        <div className="flex flex-col items-center mb-6">
          <div className={`w-14 h-14 ${cfg.bg} rounded-full flex items-center justify-center mb-4 ${cfg.color}`}>
            {Icon || cfg.icon}
          </div>
          {state.title && (
            <h2 className="text-lg font-bold dark:text-white mb-2">{state.title}</h2>
          )}
          <p className="text-sm text-slate-600 dark:text-slate-300 text-center whitespace-pre-line">
            {state.message}
          </p>
        </div>

        <div className="flex gap-3">
          {isConfirm && (
            <button
              type="button"
              onClick={() => onClose(false)}
              className="flex-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium py-2.5 px-4 rounded-xl transition-colors"
            >
              {state.cancelText || '取消'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onClose(true)}
            className={`flex-1 ${confirmBtnColor} text-white font-bold py-2.5 px-4 rounded-xl transition-colors shadow-lg flex items-center justify-center gap-2`}
            autoFocus
          >
            {state.confirmText || (isConfirm ? '确定' : '知道了')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
