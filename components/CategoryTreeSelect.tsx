import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronRight, Folder, FolderTree, Search, Check, X } from 'lucide-react';
import { Category } from '../types';

interface CategoryTreeNode {
  category: Category;
  children: CategoryTreeNode[];
}

const buildCategoryTree = (categories: Category[]): CategoryTreeNode[] => {
  const map = new Map<string, CategoryTreeNode>();
  const roots: CategoryTreeNode[] = [];

  categories.forEach(cat => {
    map.set(cat.id, { category: cat, children: [] });
  });

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

// 深度优先扁平化（用于搜索结果）
interface FlatNode {
  category: Category;
  depth: number;
  path: string[]; // 祖先名称路径
}
const flattenTree = (nodes: CategoryTreeNode[], parentPath: string[] = []): FlatNode[] => {
  const result: FlatNode[] = [];
  nodes.forEach(node => {
    const path = [...parentPath, node.category.name];
    result.push({ category: node.category, depth: parentPath.length, path });
    result.push(...flattenTree(node.children, path));
  });
  return result;
};

// 根据选中节点 ID 推导出从根到该节点的路径（节点 ID 数组）
const getPathToNode = (categories: Category[], targetId: string | undefined): string[] => {
  if (!targetId) return [];
  const map = new Map(categories.map(c => [c.id, c]));
  const path: string[] = [];
  let current = map.get(targetId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.id);
    if (!current.parentId) break;
    current = map.get(current.parentId);
  }
  return path;
};

interface CategoryTreeSelectProps {
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  allowNone?: boolean;
  noneLabel?: string;
  excludeIds?: string[];
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  /** 隐藏触发按钮（外部控制时使用） */
  hideTrigger?: boolean;
}

const CategoryTreeSelect: React.FC<CategoryTreeSelectProps> = ({
  categories,
  value,
  onChange,
  placeholder = '选择分类',
  allowNone = false,
  noneLabel = '无（顶级分类）',
  excludeIds = [],
  isOpen: externalIsOpen,
  onOpenChange,
  title = '选择分类',
  hideTrigger = false,
}) => {
  // 如果外部控制，使用 externalIsOpen；否则使用内部状态
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen;
  const setIsOpen = (open: boolean) => {
    if (onOpenChange) {
      onOpenChange(open);
    } else {
      setInternalIsOpen(open);
    }
  };
  // 弹窗内临时选中路径（每一级选中的节点 ID）
  const [tempPath, setTempPath] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const columnsRef = useRef<HTMLDivElement>(null);

  // 过滤掉被排除的分类（防止循环引用）
  const effectiveCategories = useMemo(() => {
    if (excludeIds.length === 0) return categories;
    const excludeSet = new Set(excludeIds);
    return categories.filter(c => !excludeSet.has(c.id));
  }, [categories, excludeIds]);

  const tree = useMemo(() => buildCategoryTree(effectiveCategories), [effectiveCategories]);

  const selectedCategory = useMemo(
    () => categories.find(c => c.id === value),
    [categories, value]
  );

  // 搜索结果（扁平化 + 过滤）
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.trim().toLowerCase();
    return flattenTree(tree).filter(f =>
      f.category.name.toLowerCase().includes(q)
    );
  }, [tree, searchQuery]);

  // 打开弹窗时：初始化临时路径为当前选中节点的祖先链 + 锁定背景滚动
  useEffect(() => {
    if (isOpen) {
      setTempPath(getPathToNode(effectiveCategories, value));
      setSearchQuery('');
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen, value, effectiveCategories]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen]);

  // 选中某一级的节点：
  // - 如果该节点有子分类：展开下一级（保留这一级选择，截断后续层级）
  // - 无论如何：更新 tempPath 到该层级
  const handlePickAtLevel = (node: CategoryTreeNode, level: number) => {
    setTempPath(prev => {
      const next = prev.slice(0, level);
      next[level] = node.category.id;
      return next;
    });
  };

  // 选中"无"（顶级分类）：清空 tempPath
  const handlePickNone = () => {
    setTempPath([]);
  };

  // 确定按钮：提交 tempPath 最后一个节点（即最深选中的分类）
  const handleConfirm = () => {
    if (tempPath.length > 0) {
      onChange(tempPath[tempPath.length - 1]);
    } else if (allowNone) {
      onChange('');
    }
    setIsOpen(false);
  };

  // 搜索结果直接选中（已带完整路径）
  const handlePickFromSearch = (flat: FlatNode) => {
    const path = getPathToNode(effectiveCategories, flat.category.id);
    setTempPath(path);
    setSearchQuery('');
    // 不立即关闭，让用户看到选中状态后点确定
  };

  // 构建要渲染的列：根列 + 每一级选中节点的子列
  const columns: { nodes: CategoryTreeNode[]; level: number }[] = [];
  columns.push({ nodes: tree, level: 0 });
  for (let i = 0; i < tempPath.length; i++) {
    const parentId = tempPath[i];
    const parent = tree
      .flatMap(function find(n: CategoryTreeNode): CategoryTreeNode[] {
        return [n, ...n.children.flatMap(find)];
      })
      .find(n => n.category.id === parentId);
    if (parent && parent.children.length > 0) {
      columns.push({ nodes: parent.children, level: i + 1 });
    } else {
      break;
    }
  }

  const flatCount = categories.length;

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="w-full p-2 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none transition-all flex items-center justify-between text-left"
        >
          <span className="flex items-center gap-2 truncate">
            {selectedCategory ? (
              <>
                <Folder size={14} className="text-amber-500 shrink-0" />
                <span className="truncate">{selectedCategory.name}</span>
              </>
            ) : allowNone ? (
              <span className="text-slate-500 dark:text-slate-400 truncate">{noneLabel}</span>
            ) : (
              <span className="text-slate-400">{placeholder}</span>
            )}
          </span>
          <ChevronRight size={14} className="text-slate-400 shrink-0" />
        </button>
      )}

      {/* 弹窗：居中模态框 - 级联列视图 */}
      {isOpen && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsOpen(false);
          }}
        >
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden border border-slate-200 dark:border-slate-700 flex flex-col max-h-[80vh]">
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-700">
              <h2 className="text-base font-bold dark:text-white">{title}</h2>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 dark:hover:text-slate-200 transition-colors"
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>

            {/* 搜索框 */}
            {flatCount > 8 && (
              <div className="p-3 border-b border-slate-100 dark:border-slate-700">
                <div className="relative">
                  <Search
                    size={14}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索分类..."
                    className="w-full pl-8 pr-2 py-2 text-sm rounded-lg bg-slate-50 dark:bg-slate-700/60 dark:text-white border border-slate-200 dark:border-slate-600 focus:ring-2 focus:ring-blue-500 outline-none"
                    autoFocus
                  />
                </div>
              </div>
            )}

            {/* 主体：级联列视图 / 搜索结果 */}
            <div ref={columnsRef} className="flex-1 overflow-auto min-h-[200px]">
              {searchQuery.trim() ? (
                /* 搜索结果：扁平列表 */
                <div className="p-2">
                  {searchResults.length === 0 ? (
                    <div className="py-8 text-center text-sm text-slate-400">
                      未找到匹配分类
                    </div>
                  ) : (
                    searchResults.map(flat => {
                      const isSelected = flat.category.id === tempPath[tempPath.length - 1];
                      return (
                        <div
                          key={flat.category.id}
                          onClick={() => handlePickFromSearch(flat)}
                          className={`flex items-center gap-2 py-2 px-3 rounded-lg cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                              : 'hover:bg-slate-100 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          <Folder size={14} className="text-amber-500 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">{flat.category.name}</div>
                            {flat.path.length > 1 && (
                              <div className="text-xs text-slate-400 truncate mt-0.5">
                                {flat.path.slice(0, -1).join(' / ')}
                              </div>
                            )}
                          </div>
                          {isSelected && <Check size={14} className="shrink-0" />}
                        </div>
                      );
                    })
                  )}
                </div>
              ) : (
                /* 级联列视图：每一级一列，横向排列 */
                <div className="flex min-h-full">
                  {columns.map((col, colIdx) => (
                    <div
                      key={colIdx}
                      className="w-56 shrink-0 border-r border-slate-100 dark:border-slate-700 last:border-r-0 overflow-y-auto"
                    >
                      <div className="p-1.5">
                        {/* 第一列显示"无（顶级分类）"选项 */}
                        {colIdx === 0 && allowNone && (
                          <div
                            onClick={handlePickNone}
                            className={`flex items-center gap-1.5 py-2 px-2.5 rounded-lg cursor-pointer transition-colors mb-1 ${
                              tempPath.length === 0
                                ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                                : 'hover:bg-slate-100 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200'
                            }`}
                          >
                            <span className="w-[14px] h-[14px] rounded-sm shrink-0 border border-dashed border-slate-400 dark:border-slate-500 flex items-center justify-center">
                              <X size={10} className="text-slate-400" />
                            </span>
                            <span className="truncate flex-1 text-sm">{noneLabel}</span>
                            {tempPath.length === 0 && <Check size={14} className="shrink-0" />}
                          </div>
                        )}
                        {col.nodes.length === 0 ? (
                          <div className="py-6 text-center text-xs text-slate-400">
                            无子分类
                          </div>
                        ) : (
                          col.nodes.map(node => {
                            const cat = node.category;
                            const hasChildren = node.children.length > 0;
                            const isSelectedAtLevel = tempPath[colIdx] === cat.id;
                            return (
                              <div
                                key={cat.id}
                                onClick={() => handlePickAtLevel(node, colIdx)}
                                className={`flex items-center gap-1.5 py-2 px-2.5 rounded-lg cursor-pointer transition-colors ${
                                  isSelectedAtLevel
                                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                                    : 'hover:bg-slate-100 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200'
                                }`}
                              >
                                {hasChildren ? (
                                  isSelectedAtLevel ? (
                                    <FolderTree size={14} className="text-amber-500 shrink-0" />
                                  ) : (
                                    <Folder size={14} className="text-amber-500 shrink-0" />
                                  )
                                ) : (
                                  <span
                                    className="w-[14px] h-[14px] rounded-sm shrink-0 border border-slate-300 dark:border-slate-600"
                                    style={{ background: cat.color || 'transparent' }}
                                  />
                                )}
                                <span className="truncate flex-1 text-sm">{cat.name}</span>
                                {hasChildren && (
                                  <ChevronRight
                                    size={14}
                                    className="text-slate-400 shrink-0"
                                  />
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  ))}
                  {columns.length === 1 && columns[0].nodes.length === 0 && (
                    <div className="flex-1 flex items-center justify-center text-sm text-slate-400 py-12">
                      暂无分类
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 底部：当前选中路径预览 + 操作按钮 */}
            <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex-1 min-w-0 text-xs text-slate-500 dark:text-slate-400 truncate">
                  {tempPath.length > 0 ? (
                    (() => {
                      const names = tempPath.map(id =>
                        categories.find(c => c.id === id)?.name || ''
                      );
                      return (
                        <span className="flex items-center gap-1 flex-wrap">
                          {names.map((name, idx) => (
                            <React.Fragment key={idx}>
                              {idx > 0 && (
                                <ChevronRight size={12} className="text-slate-400" />
                              )}
                              <span className={idx === names.length - 1 ? 'text-blue-600 dark:text-blue-400 font-medium' : ''}>
                                {name}
                              </span>
                            </React.Fragment>
                          ))}
                        </span>
                      );
                    })()
                  ) : allowNone ? (
                    <span className="text-blue-600 dark:text-blue-400 font-medium">{noneLabel}</span>
                  ) : (
                    <span>未选择</span>
                  )}
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium py-2 px-4 rounded-xl transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={!allowNone && tempPath.length === 0}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-xl transition-colors shadow-lg shadow-blue-500/30"
                >
                  确定
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CategoryTreeSelect;
